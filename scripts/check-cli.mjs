// Offline checks for bin/loadout.mjs and the hooks, with LOADOUT_HOME and CLAUDE_CONFIG_DIR in temp dirs.
// `build` runs only over the invented fixture sessions.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePack } from '../src/pack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturePath = join(root, 'fixtures', 'loadout-example.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const home = await mkdtemp(join(tmpdir(), 'loadout-home-'));
const claude = await mkdtemp(join(tmpdir(), 'loadout-claude-'));
await symlink(join(root, 'fixtures', 'claude'), join(claude, 'projects'));
const env = { ...process.env, LOADOUT_HOME: home, CLAUDE_CONFIG_DIR: claude };

// Doctor reads a Claude config dir with no sessions, so its lines don't depend on the fixtures' dates.
const doctorDir = await mkdtemp(join(tmpdir(), 'loadout-doctor-'));
const doctor = () => spawnSync(process.execPath, [join(root, 'bin', 'loadout.mjs'), 'doctor'], { env: { ...env, CLAUDE_CONFIG_DIR: doctorDir }, encoding: 'utf8' }).stdout.trim().split('\n');
const cli = (...args) => spawnSync(process.execPath, [join(root, 'bin', 'loadout.mjs'), ...args], { env, encoding: 'utf8' });
const hook = (name, input) => spawnSync(process.execPath, [join(root, 'hooks', name)], { env, input, encoding: 'utf8' });
const context = (r, event) => {
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, event);
  assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string');
  return out.hookSpecificOutput.additionalContext;
};
const silent = (r) => {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
};

// Runs `loadout review` with the browser off, waits for the page, then `leave(url, child)` ends the review.
async function reviewThen(leave) {
  const out = await mkdtemp(join(tmpdir(), 'loadout-out-'));
  const child = spawn(process.execPath, [join(root, 'bin', 'loadout.mjs'), 'review', '--handle', 'maya', '--out', out], { env: { ...env, LOADOUT_NO_OPEN: '1' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no review url: ${stderr}`)), 5000);
    child.stderr.on('data', (d) => {
      stderr += d;
      const m = /http:\/\/127\.0\.0\.1:\d+/.exec(stderr);
      if (m) (clearTimeout(timer), resolve(m[0]));
    });
  });
  await leave(url, child);
  const code = await new Promise((resolve) => child.on('close', resolve));
  const written = await readdir(out);
  await rm(out, { recursive: true, force: true });
  return { code, stdout, written };
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n${err.message}`);
    process.exitCode = 1;
  }
}

try {
  const packDir = await writePack(fixture, home);
  const sessionStart = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'x' });
  const prompt = (text, session = 'x') => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: session, transcript_path: `/work/${session}.jsonl` });

  await check('plugin manifests and hooks.json parse', async () => {
    for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json']) JSON.parse(await readFile(join(root, f), 'utf8'));
  });

  await check('help, and unknown commands fail', () => {
    assert.match(cli('help').stdout, /loadout use <handle\|path>/);
    assert.equal(cli('nope').status, 1);
  });

  await check('hooks are silent with no active loadout, and stamp last-hook.json', async () => {
    silent(hook('session-start.mjs', sessionStart));
    silent(hook('prompt.mjs', prompt('fix the failing test')));
    const stamp = JSON.parse(await readFile(join(home, 'last-hook.json'), 'utf8'));
    assert.equal(stamp.event, 'UserPromptSubmit');
    assert.equal(stamp.session, 'x');
    assert.ok(Date.now() - Date.parse(stamp.at) < 60_000);
  });

  await check('doctor: one line per check, then Next', async () => {
    await rm(join(home, 'last-hook.json'));
    const lines = doctor();
    assert.match(lines[0], /^✓ Node \d+\.\d+$/);
    assert.equal(lines[1], '! 0 sessions over 30 days, none typed by you. Nothing to mine yet.');
    assert.match(lines[2], /^! Claude Code deletes sessions after 30 days\./);
    assert.equal(lines[3], '· No feedback memories');
    assert.equal(lines[4], '✗ Plugin off. In Claude Code: /plugin install loadout@loadout');
    assert.equal(lines.at(-1), 'Next: /plugin install loadout@loadout');
    await writeFile(join(doctorDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90, enabledPlugins: { 'loadout@loadout': true } }));
    const ok = doctor();
    assert.deepEqual(ok.slice(2), ['✓ Sessions kept 90 days', '· No feedback memories', '✓ Plugin on, hooks installed', "Next: work a few sessions in Claude Code, or /loadout:use <handle> to try someone else's"]);
  });

  await check('incognito records the session, or the one the hooks saw last', async () => {
    const saved = async () => JSON.parse(await readFile(join(home, 'incognito.json'), 'utf8')).sessions;
    assert.equal(cli('incognito', '22222222-bbbb-4bbb-8bbb-000000000002').stdout.trim(), 'This session stays out of your loadout.');
    hook('prompt.mjs', JSON.stringify({ prompt: '/loadout:incognito', session_id: '33333333-cccc-4ccc-8ccc-000000000003' }));
    assert.equal(cli('incognito').status, 0);
    assert.equal(cli('incognito', '22222222-bbbb-4bbb-8bbb-000000000002').status, 0);
    assert.deepEqual(await saved(), ['22222222-bbbb-4bbb-8bbb-000000000002', '33333333-cccc-4ccc-8ccc-000000000003']);
  });

  await check('build skips incognito sessions and says how many', async () => {
    const r = cli('build', '--handle', 'demo', '--since', '99999d', '--no-review', '--no-claude-md');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Skipped 2 incognito sessions\.$/m);
    const draft = JSON.parse(await readFile(join(home, 'drafts', 'demo.json'), 'utf8'));
    assert.equal(draft.stats.sessions, 2);
    await rm(join(home, 'drafts'), { recursive: true });
  });

  await check('status, list and off with nothing on', () => {
    assert.equal(cli('status').stdout.trim(), 'No loadout is on.');
    assert.match(cli('list').stdout, /No loadouts yet/);
    assert.equal(cli('off').stdout.trim(), 'No loadout is on.');
  });

  await check('use <pack path> copies the pack and writes active.json', async () => {
    const r = cli('use', packDir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "Using maya's loadout: 4 playbooks (Build a feature, Fix a bug, New idea or plan, Review).");
    const active = JSON.parse(await readFile(join(home, 'active.json'), 'utf8'));
    assert.equal(active.handle, 'maya');
    assert.equal(active.path, join(home, 'packs', 'maya'));
    assert.ok(!Number.isNaN(Date.parse(active.since)));
    for (const f of ['loadout.json', 'LOADOUT.md', 'README.md']) assert.ok(existsSync(join(active.path, f)), f);
  });

  await check('status and list show the active loadout', () => {
    assert.match(cli('status').stdout, /^Using maya's loadout since \d{4}-\d\d-\d\d: 4 playbooks/);
    assert.match(cli('status', '--md').stdout, /^# Maya's loadout\n/);
    assert.equal(cli('list').stdout.trim(), '* maya  4 playbooks');
  });

  await check('doctor: on but the hooks have not run since', async () => {
    await rm(join(home, 'last-hook.json'), { force: true });
    const lines = doctor();
    assert.equal(lines.at(-2), "✗ maya's loadout is on, but the hooks haven't run since. Restart Claude Code.");
    assert.equal(lines.at(-1), 'Next: restart Claude Code');
  });

  await check('session-start injects the full LOADOUT.md', async () => {
    const md = await readFile(join(home, 'packs', 'maya', 'LOADOUT.md'), 'utf8');
    const ctx = context(hook('session-start.mjs', sessionStart), 'SessionStart');
    assert.ok(ctx.endsWith(md));
    assert.ok(ctx.length < 10_000);
  });

  await check('doctor: on and injected', () => {
    assert.deepEqual(doctor().slice(-2), ["✓ maya's loadout is on and injected", 'Next: start a task']);
  });

  await check('prompt offers the matching playbook once per session, with a cue', async () => {
    const r = hook('prompt.mjs', prompt('the login form is broken, fix it'));
    const ctx = context(r, 'UserPromptSubmit');
    assert.equal(JSON.parse(r.stdout).systemMessage, 'loadout: Fix a bug');
    assert.match(ctx, /^Maya's loadout has a playbook for this prompt, offered, not accepted\./);
    assert.ok(ctx.includes('**Fix a bug** (diagnosing-bugs, edit code, run tests, playwright). Want me to follow it?'));
    assert.ok(!ctx.includes('Build a feature'));
    assert.ok(ctx.includes("Don't add comments that restate the code."));
    assert.ok(ctx.length <= 2048);
    // The same playbook again in this session: nothing. Another one, or another session: offered.
    silent(hook('prompt.mjs', prompt('Fix the failing login test')));
    assert.equal(JSON.parse(hook('prompt.mjs', prompt('fix this bug, then build the feature and add support')).stdout).systemMessage, 'loadout: Build a feature');
    silent(hook('prompt.mjs', prompt('Add support for CSV export on the reports page')));
    assert.equal(JSON.parse(hook('prompt.mjs', prompt('Fix the failing login test', 'y')).stdout).systemMessage, 'loadout: Fix a bug');
    const state = JSON.parse(await readFile(join(home, 'sessions', 'x.json'), 'utf8'));
    assert.deepEqual(state.offered, ['bug', 'feature']);
    assert.equal(state.transcript, '/work/x.jsonl');
  });

  await check('session files older than a week are pruned, and bad session ids keep no state', async () => {
    const old = join(home, 'sessions', 'old.json');
    await writeFile(old, '{}');
    const week = (Date.now() - 8 * 86_400_000) / 1000;
    await utimes(old, week, week);
    context(hook('prompt.mjs', prompt('review this PR please', 'z')), 'UserPromptSubmit');
    assert.ok(!existsSync(old) && existsSync(join(home, 'sessions', 'z.json')));
    context(hook('prompt.mjs', prompt('review this PR please', '../evil')), 'UserPromptSubmit');
    assert.deepEqual((await readdir(join(home, 'sessions'))).sort(), ['x.json', 'y.json', 'z.json']);
  });

  await check('suggest auto follows without asking, every time; off sends nothing', () => {
    assert.equal(cli('suggest').stdout.trim(), 'ask');
    assert.equal(cli('suggest', 'maybe').status, 1);
    assert.equal(cli('suggest', 'auto').stdout.trim(), 'Playbook suggestions: auto.');
    assert.match(cli('status').stdout, /\nPlaybook suggestions: auto\.\n$/);
    for (let i = 0; i < 2; i++) {
      const r = hook('prompt.mjs', prompt('the login form is broken, fix it'));
      assert.match(context(r, 'UserPromptSubmit'), /^Following Maya's loadout: this prompt matches the playbook "Fix a bug"/);
      assert.equal(JSON.parse(r.stdout).systemMessage, undefined);
    }
    cli('suggest', 'off');
    silent(hook('prompt.mjs', prompt('the login form is broken, fix it', 'forget-new')));
    cli('suggest', 'ask');
    assert.ok(!cli('status').stdout.includes('suggestions'));
  });

  await check('prompt is silent on no match, slash commands and bad input', () => {
    silent(hook('prompt.mjs', prompt('what time is it')));
    silent(hook('prompt.mjs', prompt('/loadout:off fix bug')));
    silent(hook('prompt.mjs', 'not json'));
  });

  await check('forget drops an item from both hooks and restore brings it back', async () => {
    const rule = "Don't add comments that restate the code";
    const startCtx = () => context(hook('session-start.mjs', sessionStart), 'SessionStart');
    // A fresh session each time: a playbook is offered once per session.
    let n = 0;
    const bugCtx = () => context(hook('prompt.mjs', prompt('the login form is broken, fix it', `forget-${++n}`)), 'UserPromptSubmit');
    assert.match(cli('forget').stdout, /^rule:no-restating-comments {2}Don't add comments/);
    assert.match(cli('forget', 'test').stdout, /^Which one\?/);
    assert.equal(cli('forget', 'comments', 'that', 'restate').stdout.trim(), `Forgot "${rule}" in maya's loadout. Ignore it from now on. \`loadout restore\` brings it back.`);
    assert.ok(!startCtx().includes(rule) && !bugCtx().includes(rule));
    assert.match(cli('status').stdout, /\. 1 forgotten\.\n$/);
    assert.equal(cli('forget', 'playbook:bug').status, 0);
    silent(hook('prompt.mjs', prompt('the login form is broken, fix it', 'forget-new')));
    assert.ok(!cli('status', '--md').stdout.includes('### Fix a bug'));
    assert.equal(cli('use', 'maya').status, 0, 'use keeps what was forgotten');
    assert.ok(!startCtx().includes(rule));
    assert.equal(cli('restore').stdout, `rule:no-restating-comments  ${rule}\nplaybook:bug  Fix a bug\n`);
    assert.equal(cli('restore', 'playbook:bug').status, 0);
    assert.match(cli('restore', 'rule:no-restating-comments').stdout, /^Restored /);
    assert.ok(startCtx().includes(rule) && bugCtx().includes(rule));
    assert.equal(cli('restore').stdout.trim(), 'Nothing forgotten.');
    // In their own loadout, forgetting also switches the item off in the draft.
    await mkdir(join(home, 'drafts'), { recursive: true });
    const draft = join(home, 'drafts', 'maya.json');
    await copyFile(join(root, 'fixtures', 'draft-example.json'), draft);
    assert.match(cli('forget', 'check:tests-before-commit').stdout, /\nOff in your draft too\./);
    assert.equal(JSON.parse(await readFile(draft, 'utf8')).checks.find((c) => c.id === 'tests-before-commit').include, false);
    assert.equal(cli('restore', 'check:tests-before-commit').status, 0);
    await rm(draft);
  });

  await check('use <handle> reloads an installed pack', () => {
    assert.equal(cli('use', 'maya').status, 0);
    assert.equal(cli('use', 'nobody').status, 1);
  });

  await check('use drops items switched off in review, and CLAUDE.md unless switched on', async () => {
    const draft = structuredClone(fixture);
    draft.handle = 'sam';
    draft.displayName = 'Sam';
    draft.playbooks.forEach((p, i) => (p.include = i !== 2));
    draft.patterns[0].include = false;
    draft.kit.skills.forEach((s) => (s.include = true));
    draft.rules.forEach((r, i) => (r.include = i !== 0));
    draft.claudeMd.include = false;
    const file = join(home, 'sam.json');
    const saved = async () => JSON.parse(await readFile(join(home, 'packs', 'sam', 'loadout.json'), 'utf8'));
    await writeFile(file, JSON.stringify(draft));
    assert.equal(cli('use', file).status, 0);
    const off = await saved();
    assert.deepEqual(off.playbooks.map((p) => p.id), ['feature', 'bug', 'review']);
    assert.equal(off.patterns.length, 2);
    assert.deepEqual(off.rules.map((r) => r.id), fixture.rules.slice(1).map((r) => r.id));
    assert.equal(off.claudeMd, undefined);
    assert.ok(!JSON.stringify(off).includes('"include"'));
    const md = await readFile(join(home, 'packs', 'sam', 'LOADOUT.md'), 'utf8');
    assert.ok(!md.includes('## Their CLAUDE.md') && !md.includes(fixture.rules[0].text));
    draft.claudeMd.include = true;
    await writeFile(file, JSON.stringify(draft));
    assert.equal(cli('use', file).status, 0);
    assert.deepEqual((await saved()).claudeMd, { text: fixture.claudeMd.text });
    assert.ok((await readFile(join(home, 'packs', 'sam', 'LOADOUT.md'), 'utf8')).includes('## Their CLAUDE.md'));
    assert.equal(cli('use', 'maya').status, 0);
  });

  await check('review publishes only when asked', async () => {
    await mkdir(join(home, 'drafts'), { recursive: true });
    await copyFile(join(root, 'fixtures', 'draft-example.json'), join(home, 'drafts', 'maya.json'));
    const notYet = "Draft saved. Run `loadout publish` when you're ready.";
    const closed = await reviewThen((url) => fetch(`${url}/api/close`, { method: 'POST' }));
    assert.equal(closed.code, 0);
    assert.equal(closed.stdout.trim(), notYet);
    assert.deepEqual(closed.written, []);
    const interrupted = await reviewThen((url, child) => child.kill('SIGINT'));
    assert.equal(interrupted.stdout.trim(), notYet);
    assert.deepEqual(interrupted.written, []);
    const published = await reviewThen((url) => fetch(`${url}/api/done`, { method: 'POST' }));
    assert.equal(published.code, 0, published.stdout);
    assert.match(published.stdout, /^Wrote /);
    assert.deepEqual(published.written, ['maya.loadout']);
  });

  await check('build reads feedback memories unless --no-memory', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'loadout-claude-'));
    await cp(join(root, 'fixtures', 'claude'), join(fakeHome, '.claude', 'projects'), { recursive: true });
    const build = (...more) => spawnSync(process.execPath, [join(root, 'bin', 'loadout.mjs'), 'build', '--handle', 'demo', '--since', '99999d', '--no-review', ...more],
      { env: { ...env, HOME: fakeHome }, encoding: 'utf8' });
    const draft = async () => JSON.parse(await readFile(join(home, 'drafts', 'demo.json'), 'utf8'));
    try {
      const r = build();
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /, 2 rules \(2 from memory, \+2 off\),/); // +1: a rule said once
      const rules = (await draft()).rules.filter((x) => x.from === 'memory');
      // The deploy key and the shop rule became holes and were dropped; the migration rule names a repo in its Why.
      assert.deepEqual(rules.map((x) => [x.text, x.include]), [
        ['Avoid comments that restate the code; explain why, not what', true],
        ['Prefer tests that run offline and never hit the network', true],
        ['Never edit a migration that already ran; add a new one', false],
      ]);
      assert.equal(rules[2].why, 'An edited migration broke staging for ‹name› last spring.');
      assert.ok(!JSON.stringify(await draft()).includes('AKIA'));
      const out = await mkdtemp(join(tmpdir(), 'loadout-out-'));
      assert.equal(cli('publish', '--handle', 'demo', '--out', out).status, 0);
      const shipped = JSON.parse(await readFile(join(out, 'demo.loadout', 'loadout.json'), 'utf8'));
      assert.deepEqual(shipped.rules.map((x) => x.from), ['memory', 'memory']);
      assert.ok(shipped.rules.every((x) => !('why' in x)));
      await rm(out, { recursive: true, force: true });
      assert.equal(build('--no-memory').status, 0);
      assert.ok(!(await draft()).rules.some((x) => x.from === 'memory'));
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  await check('off stops it and the hooks go quiet', () => {
    assert.equal(cli('off').stdout.trim(), "Stopped using maya's loadout.");
    assert.ok(!existsSync(join(home, 'active.json')));
    silent(hook('session-start.mjs', sessionStart));
    silent(hook('prompt.mjs', prompt('fix the failing test', 'fresh')));
  });

  await check('a broken active.json keeps the hooks silent', async () => {
    await writeFile(join(home, 'active.json'), '{ not json');
    silent(hook('session-start.mjs', sessionStart));
    await writeFile(join(home, 'active.json'), JSON.stringify({ handle: 'gone', path: join(home, 'nowhere') }));
    silent(hook('session-start.mjs', sessionStart));
    silent(hook('prompt.mjs', prompt('fix the failing test', 'fresh')));
  });
  await check('prompt recalls past work once per session, never from this session, and joins a playbook offer', async () => {
    assert.equal(cli('recall', 'csv').stdout.trim(), 'Nothing to recall yet. `loadout recall --reindex` reads your sessions.');
    await mkdir(join(home, 'recall'), { recursive: true });
    await copyFile(join(root, 'fixtures', 'recall', 'index.jsonl'), join(home, 'recall', 'index.jsonl'));
    assert.equal(cli('use', 'maya').status, 0);
    const ask = (text, session, cwd = '/work/shop') => hook('prompt.mjs', JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: session, cwd }));
    const cart = 'the cart total is wrong when two discount codes are applied';
    const r = ask(cart, 'recall-1');
    assert.equal(JSON.parse(r.stdout).systemMessage, 'loadout recalled: fix the cart total rounding error when a discount code is…');
    const ctx = context(r, 'UserPromptSubmit');
    assert.match(ctx, /\n\nloadout recalled · Aug 19( 2026)? · shop\nLast time "fix the cart total rounding error when a discount code is applied": you used diagnosing-bugs → tdd\. You corrected: "round once at the end, not per line"\./);
    silent(ask(cart, 'recall-1'));
    assert.deepEqual(JSON.parse(await readFile(join(home, 'sessions', 'recall-1.json'), 'utf8')).recalled, ['5h0p0002-0000-4000-8000-000000000002:0']);
    for (const p of ['fix it', 'yes, do that', '/loadout:status', 'thanks']) silent(ask(p, 'recall-2'));
    // The retry of the CSV export ran in this very session: the first try is what comes back, with the playbook.
    const both = ask('Add CSV export to the customers page', '5h0p0005-0000-4000-8000-000000000005');
    assert.equal(JSON.parse(both.stdout).systemMessage, 'loadout: Build a feature · loadout recalled: add CSV export to the reports page');
    const joined = context(both, 'UserPromptSubmit');
    assert.ok(joined.startsWith("Maya's loadout has a playbook for this prompt") && joined.includes('\n\nFrom the user\'s own past Claude Code sessions') && joined.includes('"keep the export server-side"'));
    assert.equal(cli('recall', 'off').stdout.trim(), 'Recall off.');
    silent(ask(cart, 'recall-3'));
    assert.equal(cli('recall').stdout.trim(), 'Recall is off. Usage: loadout recall "<words>"');
    assert.equal(cli('recall', 'on').stdout.trim(), 'Recall on.');
    const incognito = JSON.parse(await readFile(join(home, 'incognito.json'), 'utf8'));
    await writeFile(join(home, 'incognito.json'), JSON.stringify({ sessions: [...incognito.sessions, '5h0p0002-0000-4000-8000-000000000002'] }));
    silent(ask(cart, 'recall-4'));
    assert.equal(cli('off').status, 0);
  });

  await check('loadout recall prints the best past tasks with date and repo', () => {
    const out = cli('recall', 'stripe', 'webhook', 'signature').stdout;
    // The task whose ask names all three comes first; the one that only decided about signatures, after it.
    assert.match(out, /^Aug 7( 2026)? · billing-api\n {2}Last time "add stripe webhook signature verification": you used Explore → tdd\./);
    assert.match(out, /\nOct 20( 2026)? · billing-api\n {2}Last time "handle stripe webhooks for disputes": you used Explore → tdd\. You decided: "reuse the signature check/);
    assert.equal(cli('recall', 'kubernetes').stdout.trim(), 'Nothing recalled for "kubernetes".');
  });

  // The prompt hook runs on every prompt: time it over an invented 5,000-task index. Node itself starts in ~40 ms.
  await check('prompt hook stays fast with 5,000 past tasks', async () => {
    const big = await mkdtemp(join(tmpdir(), 'loadout-big-'));
    try {
      const base = (await readFile(join(root, 'fixtures', 'recall', 'index.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      const vocab = base.flatMap((t) => t.terms);
      const lines = Array.from({ length: 5000 }, (_, i) => {
        const t = base[i % base.length];
        const extra = Array.from({ length: 40 }, (_, j) => `${vocab[(i * 7 + j * 13) % vocab.length]}${j % 3 ? '' : i}`);
        return JSON.stringify({ ...t, id: `big${i}:0`, session: `big${i}`, ask: `${t.ask} ${extra.slice(0, 6).join(' ')}`, terms: [...new Set([...t.terms, ...extra])].slice(0, 60) });
      });
      await mkdir(join(big, 'recall'));
      await writeFile(join(big, 'recall', 'index.jsonl'), `${lines.join('\n')}\n`);
      const input = JSON.stringify({ prompt: 'Add CSV export to the customers page', session_id: 'big', cwd: '/work/shop' });
      const times = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const r = spawnSync(process.execPath, [join(root, 'hooks', 'prompt.mjs')], { env: { ...env, LOADOUT_HOME: big }, input, encoding: 'utf8' });
        times.push(performance.now() - t0);
        assert.match(JSON.parse(r.stdout).systemMessage, /^loadout recalled: /);
        await rm(join(big, 'sessions'), { recursive: true, force: true });
      }
      const median = times.sort((a, b) => a - b)[2];
      console.log(`     median ${Math.round(median)} ms`);
      assert.ok(median < 400, `${Math.round(median)} ms`);
    } finally {
      await rm(big, { recursive: true, force: true });
    }
  });
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(claude, { recursive: true, force: true });
  await rm(doctorDir, { recursive: true, force: true });
}

console.log(`${passed} cli checks passed`);
