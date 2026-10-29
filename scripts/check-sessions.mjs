// Offline check: read the invented fixtures/claude sessions and assert the exact Session/Event output.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessions } from '../src/sessions.mjs';
import { buildIndex, purgeSessions, readIndex } from '../src/recall/index.mjs';
import { redactSecrets } from '../src/redact.mjs';

const dir = fileURLToPath(new URL('../fixtures/claude', import.meta.url));
const A = '11111111-aaaa-4aaa-8aaa-000000000001';
const B = '22222222-bbbb-4bbb-8bbb-000000000002';
const C = '33333333-cccc-4ccc-8ccc-000000000003';
const D = '44444444-dddd-4ddd-8ddd-000000000004';
const t = (hms, day = '2026-10-10') => `${day}T${hms}.000Z`;
// A prompt event with the v0.2 counters; defaults are a first, plain prompt.
const prompt = (text, at, f = {}) => ({
  kind: 'prompt', text, at, hadPaste: false, images: 0, words: text.split(/\s+/).length,
  namesFile: false, midTask: false, afterInterrupt: false, ...f,
});

const sessionA = {
  id: A,
  source: 'claude-code',
  startedAt: t('09:00:00'),
  cwdName: 'shop',
  events: [
    prompt('add a dark mode toggle to the settings page', t('09:00:00')),
    { kind: 'skill', name: 'grill-me', at: t('09:00:05') },
    { kind: 'agent', type: 'Explore', model: 'haiku', background: true, at: t('09:00:06') },
    { kind: 'agent', type: 'Plan', model: null, background: false, at: t('09:00:07') },
    { kind: 'mcp', server: 'docs_server', tool: 'search', at: t('09:00:08') },
    { kind: 'tool', name: 'Read', at: t('09:00:09') },
    { kind: 'test', ok: true, at: t('09:00:11') },
    { kind: 'check', how: 'test', ok: true, at: t('09:00:11') },
    { kind: 'test', ok: false, at: t('09:00:13') },
    { kind: 'check', how: 'test', ok: false, at: t('09:00:13') },
    { kind: 'test', ok: null, at: t('09:00:15') },
    { kind: 'check', how: 'test', ok: null, at: t('09:00:15') },
    { kind: 'git', verb: 'status', at: t('09:00:17') },
    { kind: 'git', verb: 'add', at: t('09:00:17') },
    { kind: 'git', verb: 'commit', at: t('09:00:17') },
    { kind: 'tool', name: 'Bash', at: t('09:00:17') },
    prompt('also respect the system theme', t('09:01:00'), { hadPaste: true, images: 1, midTask: true }),
    { kind: 'skill', name: 'review', at: t('09:02:00') },
    prompt('yes, ship it', t('09:05:00'), { midTask: true }),
  ],
  subagents: [
    {
      type: 'Explore',
      model: 'haiku', // meta.json has no model: taken from the launching Agent call
      events: [
        { kind: 'tool', name: 'Grep', at: t('09:00:07') },
        { kind: 'git', verb: 'log', at: t('09:00:08') },
      ],
    },
    { type: 'Plan', model: 'opus', events: [{ kind: 'skill', name: 'codebase-design', at: t('09:00:09') }] },
  ],
};
const sessionB = {
  id: B,
  source: 'claude-code',
  startedAt: t('10:00:00', '2026-09-01'),
  cwdName: 'api',
  events: [
    prompt('why does the login test flake?', t('10:00:00', '2026-09-01')),
    { kind: 'mcp', server: 'plugin_tracker_tracker', tool: 'get_issue', at: t('10:00:05', '2026-09-01') },
    { kind: 'interrupt', at: t('10:00:06', '2026-09-01') },
    prompt('try again with retries off', t('10:01:00', '2026-09-01'), { midTask: true, afterInterrupt: true }),
  ],
  subagents: [],
};
const sessionC = {
  id: C,
  source: 'claude-code',
  startedAt: t('14:00:00', '2026-10-20'),
  cwdName: 'shop',
  events: [prompt('rename the checkout button', t('14:00:00', '2026-10-20'))],
  subagents: [],
};
const d = (hms) => t(hms, '2026-10-15');
const sessionD = {
  id: D,
  source: 'claude-code',
  startedAt: d('09:00:00'),
  cwdName: 'shop',
  events: [
    prompt('fix the price rounding in src/cart/total.ts', d('09:00:00'), { namesFile: true }),
    { kind: 'check', how: 'build', ok: false, at: d('09:00:05') },
    { kind: 'check', how: 'typecheck', ok: false, at: d('09:00:05') },
    { kind: 'check', how: 'lint', ok: false, at: d('09:00:05') },
    { kind: 'check', how: 'run', ok: null, at: d('09:00:07') },
    { kind: 'check', how: 'curl', ok: null, at: d('09:00:07') },
    { kind: 'tool', name: 'Bash', at: d('09:00:07') }, // curl to a public host is not a check
    { kind: 'mcp', server: 'claude-in-chrome', tool: 'navigate', at: d('09:00:08') },
    { kind: 'check', how: 'browser', ok: null, at: d('09:00:08') },
    { kind: 'mcp', server: 'claude-in-chrome', tool: 'computer', at: d('09:00:08') },
    { kind: 'check', how: 'screenshot', ok: null, at: d('09:00:08') },
    { kind: 'mcp', server: 'claude-in-chrome', tool: 'computer', at: d('09:00:08') },
    { kind: 'check', how: 'browser', ok: null, at: d('09:00:08') },
    { kind: 'mcp', server: 'plugin_playwright_playwright', tool: 'browser_take_screenshot', at: d('09:00:08') },
    { kind: 'check', how: 'screenshot', ok: null, at: d('09:00:08') },
    { kind: 'mcp', server: 'claude-in-chrome', tool: 'find', at: d('09:00:08') },
    { kind: 'mcp', server: 'docs_server', tool: 'navigate', at: d('09:00:08') }, // not a browser server
    { kind: 'tool', name: 'WebFetch', at: d('09:00:08') },
    { kind: 'check', how: 'curl', ok: null, at: d('09:00:08') },
    { kind: 'tool', name: 'Edit', at: d('09:00:09') },
    { kind: 'denied', tool: 'Edit', at: d('09:00:10') },
    { kind: 'interrupt', at: d('09:00:10') },
    prompt('no, keep the old rounding and add a test instead', d('09:00:20'), { midTask: true, afterInterrupt: true }),
    { kind: 'tool', name: 'Bash', at: d('09:00:25') }, // an auto-mode classifier denial is not the user's
    { kind: 'command', name: 'model', at: d('09:01:00') },
    { kind: 'command', name: 'compact', at: d('09:02:00') },
    { kind: 'skill', name: 'grill-me', at: d('09:02:30') },
    { kind: 'command', name: 'plan', at: d('09:03:00') },
    { kind: 'plan', at: d('09:03:10') }, // permission-mode line has no timestamp: takes the next line's
    prompt('plan the refund flow and/or the receipt email', d('09:03:10'), { midTask: true }),
    { kind: 'tool', name: 'ExitPlanMode', at: d('09:03:20') }, // same plan stint, counted once
    prompt('look at this @docs/refunds.md', d('10:00:00'), { images: 2, namesFile: true }), // over 30 min since work
    { kind: 'tool', name: 'ExitPlanMode', at: d('10:00:05') },
    { kind: 'plan', at: d('10:00:05') }, // ExitPlanMode outside an observed plan mode
    { kind: 'plan', at: d('10:05:00') }, // the prompt line's own permissionMode
    prompt('what about partial refunds? see https://example.com/a/b/c.md', d('10:05:00'), { midTask: true }),
  ],
  subagents: [],
};

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name}\n     ${err.message.split('\n').slice(0, 12).join('\n     ')}`);
  }
};

const all = await readSessions({ dir });
const byId = Object.fromEntries(all.map((s) => [s.id, s]));

await step('reads every session newest first and skips the unreadable file', () =>
  assert.deepEqual(all.map((s) => s.id), [C, D, A, B]));
await step('typed, queued and accepted prompts count; reminders, meta, compact, notifications and tool results do not', () =>
  assert.deepEqual(byId[A].events.filter((e) => e.kind === 'prompt').map((e) => e.text), [
    'add a dark mode toggle to the settings page',
    'also respect the system theme',
    'yes, ship it',
  ]));
await step('paste, IDE block and image are dropped and hadPaste is set', () => {
  const p = byId[A].events.find((e) => e.hadPaste);
  assert.equal(p.text, 'also respect the system theme');
  assert.doesNotMatch(JSON.stringify(all), /pasted log|selected lines|AAAA|reminder text|must never/);
});
await step('session A: exact events, subagents attached, attachment ignored', () => assert.deepEqual(byId[A], sessionA));
await step('fallback rule without prompt fields; interrupt is an event, local commands and sidechain lines skipped', () =>
  assert.deepEqual(byId[B], sessionB));
await step('session C', () => assert.deepEqual(byId[C], sessionC));
await step('session D: checks by how, denied, interrupt, commands vs skills, plan entries, prompt counters', () =>
  assert.deepEqual(byId[D], sessionD));
await step('prompt counters hold numbers and booleans only; image data never kept', () => {
  const keys = new Set(all.flatMap((s) => s.events.filter((e) => e.kind === 'prompt').flatMap(Object.keys)));
  assert.deepEqual([...keys].sort(), ['afterInterrupt', 'at', 'hadPaste', 'images', 'kind', 'midTask', 'namesFile', 'text', 'words']);
  assert.doesNotMatch(JSON.stringify(all), /BBBB|CCCC|another plan|left_click|Set model to|denied by the|tool use was rejected/);
});
await step('since filters by startedAt', async () =>
  assert.deepEqual((await readSessions({ dir, since: new Date('2026-10-01T00:00:00Z') })).map((s) => s.id), [C, D, A]));
await step('limit keeps the newest', async () =>
  assert.deepEqual((await readSessions({ dir, limit: 1 })).map((s) => s.id), [C]));
await step('a missing directory yields no sessions', async () =>
  assert.deepEqual(await readSessions({ dir: `${dir}/does-not-exist` }), []));
await step('~ expands to the home directory', async () =>
  assert.deepEqual(await readSessions({ dir: '~/.loadout-check-does-not-exist' }), []));

// Recall index: invented sessions under fixtures/recall/claude, built into a throwaway LOADOUT_HOME.
const claudeDir = fileURLToPath(new URL('../fixtures/recall/claude', import.meta.url));
const R = '55555555-eeee-4eee-8eee-000000000005';
const INC = '66666666-ffff-4fff-8fff-000000000006';
const rt = (hms) => `2026-10-12T${hms}.000Z`;
const home = mkdtempSync(join(tmpdir(), 'loadout-recall-'));
const indexFile = join(home, 'recall', 'index.jsonl');
const since = '2026-01-01';
try {
  const built = await buildIndex({ home, claudeDir, since });
  const tasks = readIndex(home);
  await step('recall: splits a session into tasks with steps, corrections, decisions, checks, outcome and files', () => {
    assert.deepEqual(built, { tasks: 4, sessions: 2, ms: built.ms });
    assert.deepEqual(tasks.filter((x) => x.session === R), [
      {
        // "hi" opens nothing; the short question and "(Recommended)" go; an API error is not the outcome.
        v: 1, id: `${R}:0`, session: R, at: rt('14:03:00'), repo: 'shop', branch: 'feat/csv',
        ask: 'add CSV export to the reports page, my token is ‹secret›',
        steps: ['grilling', 'agent:Explore', 'mcp:claude-in-chrome'],
        corrections: ["Don't add a dependency"],
        decisions: ['Where should the export run → Server-side (reuse the report query)', "let's go with a streamed response", 'Use the report query, not a new one'],
        checks: ['browser', 'test', 'lint'],
        outcome: 'CSV export streams from the server; tests pass. Set API_KEY=‹secret› to try it.',
        files: ['src/reports/csv.ts', 'src/reports/export.ts', 'src/reports/format.ts'],
        terms: ['csv', 'export', 'reports', 'page', 'token', 'run', 'server', 'side', 'reuse', 'query', 'streamed', 'response', 'format', 'dependency', 'write', 'hand'],
      },
      {
        // A new request mid-task opens a task; "continue" after a long gap carries it on.
        v: 1, id: `${R}:1`, session: R, at: rt('14:12:00'), repo: 'shop', branch: 'feat/csv',
        ask: 'can you write a migration guide for the billing webhooks in the docs folder',
        steps: [], corrections: [], decisions: [], checks: [], outcome: 'Wrote the migration guide.', files: [],
        terms: ['write', 'migration', 'guide', 'billing', 'webhooks', 'docs', 'folder'],
      },
      {
        // A request after a long gap opens a task; the leading path is not the ask.
        v: 1, id: `${R}:2`, session: R, at: rt('17:00:00'), repo: 'shop', branch: 'main', ask: 'rename the reports nav item in the sidebar',
        steps: [], corrections: [], decisions: [], checks: [], outcome: 'Renamed it.', files: [], terms: ['rename', 'reports', 'nav', 'item', 'sidebar'],
      },
    ]);
  });
  await step('recall: no secret, reminder, subagent words or out-of-repo path enters the index', () => {
    const text = readFileSync(indexFile, 'utf8');
    assert.doesNotMatch(text, /ghp_|abc123def456|not the owner|subagent words|elsewhere/);
    for (const l of text.split('\n')) assert.equal(redactSecrets(l), l);
  });
  await step('recall: an unchanged build reads nothing and leaves the index alone', async () => {
    const before = statSync(indexFile).mtimeMs;
    const again = await buildIndex({ home, claudeDir, since });
    assert.deepEqual({ ...again, ms: 0 }, { tasks: 4, sessions: 2, ms: 0 });
    assert.equal(statSync(indexFile).mtimeMs, before);
  });
  await step('recall: a touched session file is re-read; others keep their tasks', async () => {
    const file = join(claudeDir, 'projects', '-work-demo-shop', `${R}.jsonl`);
    const { atime, mtime } = statSync(file);
    utimesSync(file, atime, new Date(mtime.getTime() + 1000));
    try {
      assert.deepEqual((await buildIndex({ home, claudeDir, since })).tasks, 4);
      assert.deepEqual(readIndex(home), tasks);
    } finally {
      utimesSync(file, atime, mtime);
    }
  });
  await step('recall: incognito sessions are purged and never indexed again', async () => {
    assert.ok(tasks.some((x) => x.session === INC));
    writeFileSync(join(home, 'incognito.json'), JSON.stringify({ sessions: [INC] }));
    assert.equal(purgeSessions([INC], home), 1);
    const r = await buildIndex({ home, claudeDir, since, full: true });
    assert.deepEqual([r.tasks, r.sessions], [3, 1]);
    assert.ok(!readIndex(home).some((x) => x.session === INC));
  });
  await step('recall: --since leaves older session files out', async () =>
    assert.equal((await buildIndex({ home, claudeDir, since: '2999-01-01' })).tasks, 0));
  await step('recall: the SessionEnd hook returns at once and the detached build writes the index', async () => {
    rmSync(join(home, 'recall'), { recursive: true, force: true });
    const env = { ...process.env, LOADOUT_HOME: home, CLAUDE_CONFIG_DIR: claudeDir };
    const hook = fileURLToPath(new URL('../hooks/recall-index.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: R, reason: 'other' }), env, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    for (let i = 0; i < 100 && !existsSync(indexFile); i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(readIndex(home).length, 3);
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ recall: 'off' }));
    rmSync(join(home, 'recall'), { recursive: true, force: true });
    spawnSync(process.execPath, [hook], { input: '{}', env });
    await new Promise((ok) => setTimeout(ok, 300));
    assert.ok(!existsSync(indexFile));
  });
  await step('recall: a missing index reads as no tasks', () => assert.deepEqual(readIndex(join(home, 'nope')), []));
} finally {
  rmSync(home, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
