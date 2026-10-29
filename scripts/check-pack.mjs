// Offline checks for src/pack.mjs against the invented fixture.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LOADOUT_MD, MAX_PLAYBOOK_MD, forgettable, imperative, pickItem, playbookFor, playbooksFor, readPack, renderLoadoutMd, renderOfferMd, renderPlaybookMd, validate, withoutForgotten, writePack } from '../src/pack.mjs';
import { MAX_RECALL_MD, quiet, recallBanner, recallFor, renderRecall, stem } from '../src/recall/query.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/loadout-example.json', import.meta.url), 'utf8'));
const prompts = JSON.parse(await readFile(new URL('../fixtures/suggest/prompts.json', import.meta.url), 'utf8'));
const recallTasks = (await readFile(new URL('../fixtures/recall/index.jsonl', import.meta.url), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const recallPrompts = JSON.parse(await readFile(new URL('../fixtures/recall/prompts.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-29T12:00:00Z');
const copy = () => structuredClone(fixture);
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

const GOLDEN = `
# Maya's loadout

This is how Maya works with Claude Code. Mined from 42 of their Claude Code sessions over 30 days and approved by them.

Use it for every task in this session. The rules always apply. Run the checks before you say you're done. Follow a playbook only when the loadout sends one with a prompt. When it's offered, ask first and follow it only after a yes. Then say "following Maya's loadout" once and follow its steps in order, with the skills, subagents and tools it names. Never invent steps they don't have. Commit, push, open a PR or deploy only when the user says so in this task, even inside a playbook. When nothing matches, work normally with the rest in mind.

## Rules they've enforced

Follow these. They come from times Maya had to correct an agent.

- Don't add comments that restate the code.
- Run the test you wrote before you edit anything else.
- Ask before adding a dependency.
- Only change what the task needs, no drive-by refactors.

## How they check work

- Run the tests after the last edit and before committing (they do this in 7 of 10 feature tasks).
- Open the app in the browser to confirm the fix (they do this in 4 of 9 bug fixes).
- Show proof that it works before they ask (they ask for it in 10 of 31 tasks).

## How they open a task

- Before starting, restate what done looks like and confirm it (their openings say it 19% of the time).
- Find the code it touches yourself before asking where it is (they name files 23% of the time).
- Their openings are short (about 14 words): read the code first and ask only what it can't answer.

## Playbooks

### Build a feature

When: Building or adding a feature. Opening prompts mention "add", "support", "build", "feature".

1. Spin up an Explore sub-agent.
2. Use the tdd skill.
3. Edit code.
4. Run tests.
5. Commit.

### Fix a bug

When: Fixing a bug, an error or a failing test. Opening prompts mention "fix", "failing", "broken", "error".

1. Use the diagnosing-bugs skill.
2. Edit code.
3. Run tests.
4. Use playwright (MCP).

### New idea or plan

When: Starting from a new idea, a plan or a concept. Opening prompts mention "grill", "idea", "plan".

1. Use the grilling skill.
2. Spin up an Explore sub-agent.

### Review

When: Reviewing code or a pull request. Opening prompts mention "review", "pr", "diff".

1. Spin up a general-purpose sub-agent.
2. Use the code-review skill.

## How they ask

Maya phrases requests and check-ins like this. Ask your own check-ins the same way.

> "grill me on this before you write any code"

> "keep it simple, no new abstractions"

> "what would you remove?"

## Kit

Skills:

- \`grilling\`, used 12 times
- \`tdd\`, used 8 times
- \`code-review\`, used 6 times
- \`diagnosing-bugs\`, used 5 times
- \`vercel:deploy\`, used 2 times (skill \`deploy\` from the \`vercel\` plugin; if it is missing, suggest \`/plugin install vercel\`)

MCP servers:

- \`playwright\`, used 6 times

If one is not connected, tell the user it can be added with \`claude mcp add\` and carry on without it.

Subagents: Maya's sessions use subagents 40% of the time, mostly \`Explore\`, \`general-purpose\`, on \`sonnet\`. Delegate the same kinds of work the same way.

## Their CLAUDE.md

Maya's own standing instructions to Claude. Follow them unless this project's CLAUDE.md or the user says otherwise.

\`\`\`markdown
- Use pnpm, not npm.
- Prefer early returns over nested ifs.
- Never commit .env files.
\`\`\`
`.slice(1);

await check('the fixture is valid', () => assert.deepEqual(validate(fixture), []));

await check('validate reports what is wrong', () => {
  assert.deepEqual(validate(null), ['loadout must be an object']);
  const bad = copy();
  bad.handle = 'Maya Chen';
  bad.version = 2;
  bad.playbooks[0].steps = [];
  bad.playbooks[1].id = 'feature';
  bad.patterns[0].text = 'x'.repeat(121);
  bad.kit.agents.share = 2;
  bad.rules[0].text = 'x'.repeat(141);
  bad.rules[1].id = 'no-restating-comments';
  bad.rules[2].from = 'vibes';
  bad.rules[3].lastSeen = 'Oct 12';
  bad.playbooks[2].sessions = 1.5;
  bad.checks[0].rate = 1.5;
  bad.checks[1].of = 0;
  bad.checks[2].when = 'sometimes';
  bad.openings.definesDone = -1;
  bad.claudeMd = { text: 'x'.repeat(3073), include: 'yes' };
  const errors = validate(bad);
  for (const want of ['handle', 'version', 'playbooks[0].steps', 'playbooks[1].id "feature" is repeated', 'patterns[0].text is over 120', 'kit.agents',
    'rules[0].text is over 140', 'rules[1].id "no-restating-comments" is repeated', 'rules[2].from', 'rules[3].lastSeen', 'playbooks[2].sessions', 'checks[0].rate', 'checks[1].of', 'checks[2].when',
    'openings.definesDone', 'claudeMd.text is over 3072', 'claudeMd.include']) {
    assert.ok(errors.some((e) => e.includes(want)), `missing error about ${want}: ${errors.join(' | ')}`);
  }
  const many = copy();
  many.rules = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, text: `Rule ${i}` }));
  assert.ok(validate(many).some((e) => e.includes('over 10')));
});

await check('v0.2 fields and provenance are optional, and CLAUDE.md renders only when included', () => {
  const prov = copy();
  prov.rules[0] = { ...prov.rules[0], from: 'memory', sessions: 3, lastSeen: '2026-10-12' };
  prov.playbooks[0] = { ...prov.playbooks[0], sessions: 5, lastSeen: '2026-10-12' };
  prov.patterns[0] = { ...prov.patterns[0], sessions: 2, lastSeen: '2026-10-01' };
  assert.deepEqual(validate(prov), []);
  assert.equal(renderLoadoutMd(prov), renderLoadoutMd(fixture), 'provenance never reaches LOADOUT.md');
  const old = copy();
  for (const k of ['rules', 'checks', 'openings', 'claudeMd']) delete old[k];
  assert.deepEqual(validate(old), []);
  const md = renderLoadoutMd(old);
  for (const h of ['## Rules', '## How they check', '## How they open', '## Their CLAUDE.md']) assert.ok(!md.includes(h), h);
  assert.ok(md.includes('## Playbooks') && md.includes('## Kit'));
  const off = copy();
  off.claudeMd.include = false;
  assert.ok(!renderLoadoutMd(off).includes('## Their CLAUDE.md'), 'CLAUDE.md renders only when included');
});

await check('renderLoadoutMd matches the golden output', () => assert.equal(renderLoadoutMd(fixture), GOLDEN));

await check('renderLoadoutMd is deterministic and pure', () => {
  const before = JSON.stringify(fixture);
  assert.equal(renderLoadoutMd(copy()), renderLoadoutMd(copy()));
  assert.equal(JSON.stringify(fixture), before);
});

await check('over 8 KB, lower sections are trimmed first and the rules never', () => {
  const big = copy();
  big.patterns = Array.from({ length: 80 }, (_, i) => ({ text: `${i} ${'a long recurring way of asking for something '.repeat(2)}`.slice(0, 120), seen: 2 }));
  big.rules = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, text: `${i} ${'never do the thing the owner had to correct an agent about '.repeat(3)}`.slice(0, 140) }));
  const md = renderLoadoutMd(big);
  assert.ok(Buffer.byteLength(md) <= MAX_LOADOUT_MD);
  assert.deepEqual(validate(big), []);
  for (const r of big.rules) assert.ok(md.includes(r.text.trim()), `rule ${r.id} kept`);
  // Bottom-up: CLAUDE.md and the kit go before playbooks, and the checks survive.
  assert.ok(!md.includes('## Their CLAUDE.md') && !md.includes('## Kit'));
  assert.ok(md.includes('## Playbooks') && md.includes('## How they check work'));
  assert.ok(md.includes('> "0 a long'), 'trims patterns from the end');
  const huge = copy();
  huge.displayName = 'M'.repeat(9000);
  assert.ok(validate(huge).some((e) => e.includes('8192 byte cap')));
});

await check('mined wording becomes instructions for the agent', () => {
  assert.equal(imperative('Runs tests'), 'Run tests');
  assert.equal(imperative('Pushes the branch'), 'Push the branch');
  assert.equal(imperative('Verifies the fix'), 'Verify the fix');
  assert.equal(imperative('Always runs lint'), 'Always runs lint');
  assert.equal(imperative('Grill the idea'), 'Grill the idea');
  const precise = copy();
  precise.openings = { medianWords: 80, withAttachment: 0.5, namesFiles: 0.7, definesDone: 0.8, usesPlanFirst: 0.6 };
  const md = renderLoadoutMd(precise);
  assert.ok(!md.includes('restate what done looks like'));
  for (const want of ['Plan first', 'Start from the files they name', 'attached screenshot', 'openings are detailed']) assert.ok(md.includes(want), want);
  const p = { ...fixture.playbooks[0], steps: [{ do: 'Explore the code first', uses: 'agent:Explore' }, { do: 'Plan', uses: 'mattpocock-skills:grilling' }] };
  const steps = renderPlaybookMd(fixture, p);
  assert.ok(steps.includes('1. Explore the code first: use `Explore`.') && steps.includes('2. Plan: use `mattpocock-skills:grilling`.'));
});

// Invented, labelled prompts: what an owner would want offered. Prints the scores, then asserts floors.
await check('playbooksFor offers what the labelled prompts want', () => {
  let offered = 0, wanted = 0, expected = 0, found = 0;
  const wrong = [];
  for (const { prompt, kind, expect } of prompts) {
    const ids = playbooksFor(fixture, prompt).map((p) => p.id);
    offered += ids.length;
    wanted += ids.filter((id) => expect.includes(id)).length;
    expected += expect.length;
    found += expect.filter((id) => ids.includes(id)).length;
    if (kind !== 'task') assert.deepEqual(ids, [], `no offer on ${kind}: "${prompt}"`);
    if (ids.some((id) => !expect.includes(id))) wrong.push(`"${prompt}" -> ${ids.join(', ')}`);
  }
  const precision = wanted / offered;
  const recall = found / expected;
  console.log(`     ${prompts.length} prompts: precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}${wrong.length ? `; wrong: ${wrong.join('; ')}` : ''}`);
  assert.ok(precision >= 0.9, `precision ${precision.toFixed(2)} under 0.9`);
  assert.ok(recall >= 0.7, `recall ${recall.toFixed(2)} under 0.7`);
});

await check('playbookFor is the best of playbooksFor, and at most two are offered', () => {
  assert.equal(playbookFor(fixture, 'Fix the failing login test')?.id, 'bug');
  assert.equal(playbookFor(fixture, 'fix this bug, then build the feature and add support')?.id, 'feature');
  assert.deepEqual(playbooksFor(fixture, 'fix this bug, then build the feature and add support').map((p) => p.id), ['feature', 'bug']);
  assert.equal(playbooksFor(fixture, 'fix the failing build, review the diff, add support for the plan idea').length, 2);
  assert.equal(playbookFor(fixture, 'build it'), null);
  assert.equal(playbookFor(fixture, ''), null);
});

await check('renderOfferMd asks before anything runs, with the steps in short', () => {
  const one = renderOfferMd(fixture, [fixture.playbooks[0]]);
  assert.ok(one.startsWith("Maya's loadout has a playbook for this prompt, offered, not accepted."));
  assert.ok(one.includes("> Maya's loadout has a playbook for this: **Build a feature** (Explore, tdd, edit code, run tests, commit). Want me to follow it?"));
  assert.ok(one.includes('only after a yes') && one.includes('5. Commit.') && one.includes('before committing'));
  const two = renderOfferMd(fixture, [fixture.playbooks[1], fixture.playbooks[0]]);
  assert.ok(two.includes('**Fix a bug** (diagnosing-bugs, edit code, run tests, playwright) or **Build a feature** (') && two.includes('Which one, or neither?'));
  assert.ok(two.includes('### Fix a bug') && two.includes('### Build a feature') && two.includes('Open the app in the browser'));
  assert.ok(two.length <= MAX_PLAYBOOK_MD);
});

await check('renderPlaybookMd carries the top rules and its checks, under 2 KB', () => {
  const md = renderPlaybookMd(fixture, fixture.playbooks[1]);
  assert.ok(md.startsWith('Following Maya\'s loadout: this prompt matches the playbook "Fix a bug".'));
  assert.ok(md.includes('1. Use the diagnosing-bugs skill.'));
  for (const r of fixture.rules.slice(0, 3)) assert.ok(md.includes(`- ${r.text}.`), r.id);
  assert.ok(!md.includes(fixture.rules[3].text));
  assert.ok(md.includes('Open the app in the browser to confirm the fix') && md.includes('Show proof that it works'));
  assert.ok(!md.includes('before committing'), 'feature checks stay out of a bug fix');
  const huge = { ...fixture.playbooks[0], steps: Array.from({ length: 60 }, (_, i) => ({ do: `step number ${i} of a long playbook`, uses: 'tdd' })) };
  const cut = renderPlaybookMd(fixture, huge);
  assert.ok(cut.length <= MAX_PLAYBOOK_MD);
  for (const r of fixture.rules.slice(0, 3)) assert.ok(cut.includes(`- ${r.text}.`), `${r.id} survives the cap`);
});

await check('withoutForgotten drops items by ref, or by text when the id changed', () => {
  const before = copy();
  const out = withoutForgotten(before, [
    { ref: 'rule:old-slug', text: fixture.rules[1].text },
    { ref: 'playbook:bug' },
    { ref: 'open:definesDone' },
    { ref: 'skill:tdd' },
    { ref: 'claude-md' },
  ]);
  assert.deepEqual(before, fixture, 'input is not mutated');
  assert.deepEqual(out.rules.map((r) => r.id), fixture.rules.filter((_, i) => i !== 1).map((r) => r.id));
  assert.ok(!out.playbooks.some((p) => p.id === 'bug') && out.kit.skills.every((s) => s.name !== 'tdd') && !out.claudeMd);
  assert.equal(out.openings.definesDone, undefined);
  assert.deepEqual(validate(out), []);
  assert.equal(playbookFor(out, 'Fix the failing login test'), null);
  assert.ok(!renderLoadoutMd(out).includes('restate what done looks like'));
  const refs = forgettable(out).map((e) => e.ref);
  assert.ok(refs.includes('check:asks-for-proof') && refs.includes('mcp:playwright') && !refs.includes('playbook:bug'));
  assert.equal(pickItem(forgettable(fixture), 'the comment rule').item?.ref, 'rule:no-restating-comments');
  assert.equal(pickItem(forgettable(fixture), 'the test').item, null);
});

await check('writePack and readPack round trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loadout-pack-'));
  try {
    const out = await writePack(fixture, dir);
    assert.equal(out, join(dir, 'maya.loadout'));
    assert.deepEqual(await readPack(out), fixture);
    assert.deepEqual(await readPack(join(out, 'loadout.json')), fixture);
    assert.equal(await readFile(join(out, 'LOADOUT.md'), 'utf8'), GOLDEN);
    assert.ok((await readFile(join(out, 'README.md'), 'utf8')).includes('/loadout:use maya'));
    const bad = copy();
    bad.handle = '!';
    await assert.rejects(writePack(bad, dir), /invalid loadout/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Invented, labelled prompts over an invented index of 40 tasks in 3 repos: which past task, if any, the owner
// would want recalled. Precision counts every task recalled; recall, the prompts that got a right one.
await check('recallFor recalls what the labelled prompts want, and stays silent otherwise', () => {
  let sent = 0, right = 0, wanted = 0, found = 0;
  const wrong = [];
  for (const { prompt, repo, kind, expect } of recallPrompts) {
    const ids = recallFor(prompt, recallTasks, { repo, now: NOW }).map((h) => h.task.id);
    sent += ids.length;
    right += ids.filter((id) => expect.includes(id)).length;
    if (expect.length) wanted++;
    if (ids.some((id) => expect.includes(id))) found++;
    if (kind !== 'recall') assert.deepEqual(ids, [], `silent on ${kind}: "${prompt}"`);
    if (ids.some((id) => !expect.includes(id))) wrong.push(`"${prompt}" -> ${ids.join(', ')}`);
  }
  const precision = right / sent;
  const recall = found / wanted;
  console.log(`     ${recallPrompts.length} prompts: precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}${wrong.length ? `; wrong: ${wrong.join('; ')}` : ''}`);
  assert.ok(precision >= 0.9, `precision ${precision.toFixed(2)} under 0.9`);
  assert.ok(recall >= 0.6, `recall ${recall.toFixed(2)} under 0.6`);
});

await check('recallFor skips the current session, dedupes retries, and prefers the same repo', () => {
  const csv = 'Add CSV export to the customers page';
  const [first, ...more] = recallFor(csv, recallTasks, { repo: 'shop', now: NOW });
  assert.equal(first.task.ask, 'add a CSV export to the reports page', 'the newer retry wins');
  assert.ok(!more.some((h) => h.task.ask === 'add CSV export to the reports page'), 'its near-identical first try is not sent too');
  assert.match(first.why, /shares csv, export.*same repo/);
  const others = recallFor(csv, recallTasks, { repo: 'shop', now: NOW, exclude: [first.task.session] });
  assert.equal(others[0].task.ask, 'add CSV export to the reports page');
  assert.deepEqual(recallFor(csv, recallTasks, { repo: 'shop', now: NOW, exclude: [first.task.id, others[0].task.id] }), []);
  const ci = 'set up github actions to build the electron releases';
  assert.equal(recallFor(ci, recallTasks, { repo: 'notes-app', now: NOW })[0].task.repo, 'notes-app');
  assert.equal(recallFor('csv', recallTasks, { now: NOW }).length, 0);
  assert.equal(recallFor('csv', recallTasks, { now: NOW, loose: true, limit: 5 }).length, 2, 'asked on purpose: one term, and both tries');
  assert.deepEqual(recallFor(csv, [], {}), []);
  // A session run from the parent folder that edited files under shop/ is shop's work too.
  const parent = { ...recallTasks[0], id: 'p:0', session: 'p', repo: 'work', files: ['shop/src/reports/export.ts'] };
  assert.match(recallFor(csv, [parent], { repo: 'shop', now: NOW })[0].why, /same repo/);
  assert.doesNotMatch(recallFor(csv, [{ ...parent, files: ['blog/a.md'] }], { repo: 'shop', now: NOW })[0]?.why ?? '', /same repo/);
});

await check('quiet: slash commands, chat, short prompts and follow-ups', () => {
  for (const p of ['/loadout:recall csv', 'ok, ship it', 'fix it', 'also add a test for that edge case', 'deploy', '']) assert.ok(quiet(p), p);
  for (const p of ['how did I deploy to staging last time?', 'add a dark mode toggle to the account settings']) assert.ok(!quiet(p), p);
  assert.deepEqual(['exports', 'exporting', 'exported', 'caching', 'cache', 'categories', 'boxes'].map(stem), ['export', 'export', 'export', 'cach', 'cach', 'category', 'box']);
});

await check('renderRecall says where it comes from and stays under 1200 characters; recallBanner is one line', () => {
  const hits = recallFor('add stripe webhook signature verification for paypal', recallTasks, { repo: 'billing-api', now: NOW });
  const md = renderRecall(hits, { now: NOW });
  assert.ok(md.startsWith("From the user's own past Claude Code sessions on this machine."));
  assert.ok(md.includes('loadout recalled · Aug 7 · billing-api\nLast time "add stripe webhook signature verification": you used Explore → tdd. You corrected: "never log the raw webhook body". You decided: "verify with the raw body before JSON parsing". It ended: "Webhooks with a bad signature get a 400; tests pass."'), md);
  assert.equal(recallBanner(hits), `loadout recalled: ${hits[0].task.ask}${hits.length > 1 ? ` +${hits.length - 1}` : ''}`);
  const long = { ...recallTasks[0], ask: 'x '.repeat(400), corrections: ['c '.repeat(200)], decisions: ['d '.repeat(200), 'e '.repeat(200)], outcome: 'o '.repeat(300) };
  for (const many of [[long], [long, long, long]]) assert.ok(renderRecall(many.map((task) => ({ task }))).length <= MAX_RECALL_MD);
  assert.ok(!renderRecall([{ task: { ...recallTasks[0], at: '2025-12-01T00:00:00Z' } }], { now: NOW }).includes('· Dec 1 ·'), 'another year shows the year');
});

console.log(`${passed} pack checks passed`);
