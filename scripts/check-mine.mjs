// Offline check: mine invented sessions with two clear habits plus noise and assert the exact Loadout.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mine, turnsOf, classify, classifyTurn, phrases, ruleClauses, applyRewrite } from '../src/mine.mjs';
import { memoryRule, readMemories } from '../src/memory.mjs';
import { MAX_SKILL_BYTES, skillFiles, withSources } from '../src/sources.mjs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Builds a Session in PLAN.md's shape. Each event gets the next minute after `start`.
function session(id, start, script, subagents = []) {
  let t = Date.parse(start);
  const at = () => new Date((t += 60_000)).toISOString();
  const ev = ([kind, a, b]) => {
    // A prompt's third item is `true` (pasted) or v0.2 fields ({ midTask, afterInterrupt, images, ... }).
    if (kind === 'prompt') return { kind, text: a, at: at(), hadPaste: b === true, ...(typeof b === 'object' ? b : {}) };
    if (kind === 'interrupt' || kind === 'plan') return { kind, at: at() };
    if (kind === 'denied') return { kind, tool: a, at: at() };
    if (kind === 'command') return { kind, name: a, at: at() };
    if (kind === 'check') return { kind, how: a, ok: b ?? null, at: at() };
    if (kind === 'skill') return { kind, name: a, at: at() };
    if (kind === 'agent') return { kind, type: a, model: b, background: false, at: at() };
    if (kind === 'tool') return { kind, name: a, at: at() };
    if (kind === 'mcp') return { kind, server: a, tool: b, at: at() };
    if (kind === 'git') return { kind, verb: a, at: at() };
    if (kind === 'test') return { kind, ok: a, at: at() };
    throw new Error(kind);
  };
  const events = script.map(ev);
  const subs = subagents.map(({ type, model, script: s }) => ({ type, model, events: s.map(ev) }));
  return { id, source: 'claude-code', startedAt: start, cwdName: 'demo', events, subagents: subs };
}

const gp = (script = [['tool', 'Read']]) => ({ type: 'general-purpose', model: 'opus', script });
const ideaRun = [['skill', 'mattpocock-skills:grilling'], ['agent', 'general-purpose', 'opus'], ['agent', 'general-purpose', 'opus'], ['agent', 'general-purpose', 'opus'], ['skill', 'hallmark']];

const sessions = [
  session('s1', '2026-10-01T09:00:00.000Z', [
    ['prompt', 'New idea: a voice pill for standups. Grill me first, then spin up a sub-agent for each.'],
    ...ideaRun,
    ['prompt', 'what does this function do?'],
    ['tool', 'Read'],
    ['prompt', 'ok make a mockup first'],
    ['skill', '/clear'],
    ['tool', 'Write'],
  ], [gp([['mcp', 'context7', 'docs'], ['tool', 'Read']]), gp(), gp()]),
  session('s2', '2026-10-01T14:00:00.000Z', [
    ['prompt', 'the login form is broken, fix it. run the tests before you touch anything'],
    ['skill', 'mattpocock-skills:diagnosing-bugs'],
    ['tool', 'Read'], ['tool', 'Grep'], ['tool', 'Bash'], ['test', false],
    ['tool', 'Edit'], ['tool', 'Read'], ['tool', 'Edit'], ['test', true], ['git', 'commit'],
    ['prompt', 'push'],
    ['git', 'push'],
    // Noise typed straight into prompts, in two sessions: log rows, fillers, redacted text.
    ['prompt', 'build cache 0 0 0b 0b'],
    ['prompt', 'fire all cylinders'],
    ["prompt", "i don't know, let me know when its up"],
    ['prompt', 'open ‹path› and fix it'],
  ]),
  session('s3', '2026-10-02T10:00:00.000Z', [
    ['prompt', 'I have an idea for a recipe app. grill me first.'],
    ...ideaRun,
    ['skill', '‹name›-helper'],
    // A pasted prompt: its words may recur, but never as a pattern.
    ['prompt', 'check the staging cluster config below. spin up a sub-agent for each', true],
  ], [gp([['mcp', 'context7', 'docs']]), gp(), gp()]),
  session('s4', '2026-10-02T15:00:00.000Z', [
    ['prompt', 'tests are failing on the parser, fix it'],
    ['tool', 'Read'], ['test', false], ['tool', 'Edit'], ['test', true], ['git', 'commit'],
    ['prompt', 'check the staging cluster config below', true],
    // No keyword, but the skill makes it an idea/plan turn.
    ['prompt', 'next one'],
    ['skill', 'mattpocock-skills:grill-with-docs'],
    ['prompt', 'push it'],
    ['git', 'push'],
  ]),
  session('s5', '2026-10-05T08:00:00.000Z', [
    ['prompt', 'brainstorm a new idea for onboarding. grill me first. spin up a sub-agent for each. can you make a mockup first?'],
    ['skill', 'mattpocock-skills:grilling'], ['tool', 'WebSearch'],
    ['agent', 'general-purpose', 'opus'], ['agent', 'general-purpose', 'opus'], ['agent', 'general-purpose', 'opus'],
    ['skill', 'hallmark'], ['skill', '‹name›-helper'],
  ], [gp(), gp(), gp()]),
  session('s6', '2026-10-05T11:00:00.000Z', [
    ['prompt', 'crash when saving. fix it, run the tests before you touch anything. use the blue staging bucket'],
    ['skill', 'mattpocock-skills:diagnosing-bugs'],
    ['tool', 'Read'], ['tool', 'Grep'], ['test', false], ['tool', 'Edit'], ['test', true], ['git', 'commit'], ['git', 'push'],
    ['prompt', 'use the blue staging bucket'],
    ['prompt', 'build cache 0 0 0b 0b. local volumes 1 1 89'],
    ['prompt', 'dev@box ~/app % make test'],
    ['prompt', 'fire all cylinders!'],
    ["prompt", "i don't know, let me know when its up"],
    ['prompt', 'open ‹path› and fix it'],
  ]),
  session('s7', '2026-10-05T16:00:00.000Z', [
    ['prompt', 'what does this function do?'],
    ['tool', 'Read'], ['skill', 'mattpocock-skills:tdd'],
    ['prompt', "let's go"],
    ['skill', 'mattpocock-skills:grill-with-docs'],
    ['prompt', 'first of all, make a mockup first'],
    ['prompt', 'refactor the parser module'],
    ['agent', 'Explore', 'haiku'], ['tool', 'Edit'],
  ], [{ type: 'Explore', model: 'haiku', script: [['tool', 'Grep']] }]),
];

const strip = ({ builtAt, ...rest }) => rest;
const loadout = await mine(sessions, { handle: 'maya', displayName: 'Maya' });
assert.match(loadout.builtAt, /^\d{4}-\d\d-\d\dT/);

assert.deepEqual(strip(loadout), {
  handle: 'maya', displayName: 'Maya', version: 1,
  // Sessions without v0.2 fields: no corrections or checks to report, openings from each session's first prompt.
  rules: [],
  checks: [],
  openings: { medianWords: 14, withAttachment: 0, namesFiles: 0, definesDone: 0, usesPlanFirst: 0, of: 7 },
  playbooks: [
    {
      id: 'idea', name: 'New idea or plan', when: 'Starting from a new idea, a plan or a concept.',
      trigger: ['grill', 'idea', 'brainstorm'],
      steps: [
        { do: 'Uses the grill-with-docs skill', uses: 'mattpocock-skills:grill-with-docs' }, // skill-classified turns
        { do: 'Uses the grilling skill', uses: 'mattpocock-skills:grilling' },
        { do: 'Spins up 3 general-purpose sub-agents', uses: 'agent:general-purpose' },
        { do: 'Uses context7 (MCP)', uses: 'mcp:context7' }, // from the subagents
        { do: 'Uses the hallmark skill', uses: 'hallmark' },
      ],
      seen: 5, sessions: 5, lastSeen: '2026-10-05', // provenance: distinct sessions, the last day one started
    },
    {
      id: 'bug', name: 'Fix a bug', when: 'Fixing a bug, an error or a failing test.',
      trigger: ['fix', 'broken', 'crash', 'failing'],
      steps: [
        { do: 'Uses the diagnosing-bugs skill', uses: 'mattpocock-skills:diagnosing-bugs' },
        { do: 'Reads code' }, { do: 'Runs tests' }, { do: 'Edits code' }, { do: 'Runs tests' }, { do: 'Commits' },
      ],
      seen: 3, sessions: 3, lastSeen: '2026-10-05',
    },
    // "ship" (2 sessions, only "Pushes") is dropped: nothing distinctive to port.
  ],
  patterns: [
    // Most sessions first, then verb-first, then the more specific (longer) wording.
    { text: 'grill me first', seen: 3, sessions: 3, lastSeen: '2026-10-05' },
    { text: 'make a mockup first', seen: 3, sessions: 3, lastSeen: '2026-10-05' },
    { text: 'run the tests before you touch anything', seen: 2, sessions: 2, lastSeen: '2026-10-05' },
    { text: 'spin up a sub-agent for each', seen: 2, sessions: 2, lastSeen: '2026-10-05' },
    { text: 'fire all cylinders', seen: 2, sessions: 2, lastSeen: '2026-10-05' },
  ],
  kit: {
    // tdd (one session) and the redacted ‹name›-helper are not kit.
    skills: [
      { name: 'hallmark', seen: 3 }, { name: 'mattpocock-skills:grilling', seen: 3 },
      { name: 'mattpocock-skills:diagnosing-bugs', seen: 2 }, { name: 'mattpocock-skills:grill-with-docs', seen: 2 },
    ],
    mcp: [{ server: 'context7', seen: 2 }],
    agents: { share: 0.57, types: ['general-purpose', 'Explore'], models: ['opus', 'haiku'] },
  },
  stats: { sessions: 7, days: 5, prompts: 27, skills: 5, subagents: 10 },
  removed: { paths: 0, secrets: 0, emails: 0, hosts: 0, names: 0, code: 0, urls: 0 },
});
console.log('ok   playbooks, patterns, kit and stats match the habits in the fixtures');

// A pasted prompt never becomes a pattern, even when it recurs across sessions.
assert.ok(!loadout.patterns.some((p) => p.text.includes('staging cluster')));
// A phrase repeated inside one session only is not a pattern.
assert.ok(!loadout.patterns.some((p) => p.text.includes('blue staging bucket')));
// Questions and stock replies are not patterns; built-in /clear is not a skill.
assert.ok(!loadout.patterns.some((p) => p.text.includes('what does')));
assert.ok(!loadout.kit.skills.some((s) => s.name === 'clear'));
console.log('ok   pastes, one-session phrases, questions and built-in commands are excluded');

// Pasted terminal output, fillers and redacted clauses never become patterns; lead-ins are stripped.
for (const t of ['build cache 0 0 0b 0b', 'local volumes 1 1 89', 'jane@mac ~/code % npm run dev', 'NAME   STATUS   PORTS',
  'run npm test --watch', "i don't know", "i'm not sure what to build", 'let me know when its up', 'sounds good, makes sense',
  'thank you so much', 'open ‹path› and fix it', 'the tests are flaky again']) {
  assert.deepEqual(phrases(t), [], t);
}
assert.deepEqual(phrases('First of all, go ahead and make a mockup first. Fire all cylinders').map((p) => p.text), ['make a mockup first', 'fire all cylinders']);
console.log('ok   log output, fillers, placeholders and non-instructions are not patterns');

// Big classes: a distinctive step survives at 2 of 7 turns, a generic-only class is dropped, and at most
// 6 playbooks are kept, the most seen first. `everywhere` runs in every turn of every class: it is kit, so
// its lift (rate in the class ÷ rate overall) is 1 and it is in no playbook. A step used twice in a turn
// ("chrome" before and after the edit) appears once.
const turn = (prompt, ...script) => [['prompt', prompt], ...script];
const everywhere = ['mcp', 'everywhere', 'x'];
const many = [];
let day = 0;
const add = (id, turns) => turns.forEach((t, i) => many.push(session(`${id}-${i % 2}-${i}`, new Date(Date.UTC(2026, 9, 1 + (day++ % 20))).toISOString(), t)));
add('design', [0, 1, 2, 3, 4, 5, 6].map((i) => turn('tweak the layout css', ...(i < 2 ? [['skill', 'hallmark']] : []), everywhere, ['tool', 'Edit'])));
add('feature', [0, 1, 2].map(() => turn('implement a settings page', everywhere, ['tool', 'Edit'])));
add('bug', [0, 1].map(() => turn('fix the bug', ['skill', 'debugger'], everywhere, ['mcp', 'chrome', 'a'], ['tool', 'Edit'], ['mcp', 'chrome', 'b'])));
for (const [prompt, n] of [['audit this', 3], ['refactor this', 4], ['update the readme', 5], ['new idea', 6], ['research this', 8], ['ship it', 9]]) {
  add(prompt, Array.from({ length: n }, () => turn(prompt, everywhere, ['skill', `kit-${n}`], ['tool', 'Edit'])));
}
const big = await mine(many, { handle: 'big', displayName: 'Big' });
assert.deepEqual(big.playbooks.map((p) => [p.id, p.seen]), [['ship', 9], ['research', 8], ['design', 7], ['idea', 6], ['docs', 5], ['refactor', 4]]);
assert.deepEqual(big.playbooks.find((p) => p.id === 'design').steps, [{ do: 'Uses the hallmark skill', uses: 'hallmark' }, { do: 'Edits code' }]);
assert.ok(big.playbooks.every((p) => p.steps.every((st) => st.uses !== 'mcp:everywhere')));
const bigBug = await mine(many.filter((s) => s.id.startsWith('bug') || s.id.startsWith('ship')), { handle: 'big', displayName: 'Big' });
assert.deepEqual(bigBug.playbooks.find((p) => p.id === 'bug').steps.map((st) => st.do),
  ['Uses the debugger skill', 'Uses chrome (MCP)', 'Edits code']);
// A class whose only surviving step is one tool is not a routine either.
const lone = await mine([0, 1].map((i) => session(`lone-${i}`, `2026-10-0${i + 1}T09:00:00.000Z`, [['prompt', 'deploy it'], ['mcp', 'chrome', 'x']])),
  { handle: 'l', displayName: 'L' });
assert.deepEqual(lone.playbooks, []);
console.log('ok   distinctive steps need lift, repeats collapse, generic-only and one-step classes dropped, at most 6 playbooks');

// Patterns: rewordings merge ("sub-agents" / "a sub-agent", "can you" / "ok so ... please"), a verb mid-clause
// starts a span, and sub-spans of a chosen pattern add nothing. A prompt still carrying a paste marker, log
// rows and a phrase from one session only are never patterns.
const asks = [
  session('p1', '2026-10-01T09:00:00.000Z', [['prompt', 'Can you spin up sub-agents for each?'], ['prompt', 'honestly we always check the bundle size before merging'],
    ['prompt', 'build cache 0 0 0b 0b'], ['prompt', '<pasted_content id="1"> run the release script tonight'], ['prompt', 'rename the parser module']]),
  session('p2', '2026-10-02T09:00:00.000Z', [['prompt', 'ok so spin up a sub-agent for each please'], ['prompt', 'build cache 0 0 0b 0b'],
    ['prompt', '<pasted_content id="2"> run the release script tonight'], ['prompt', 'rename the parser module'], ['prompt', 'rename the parser module']]),
  session('p3', '2026-10-03T09:00:00.000Z', [['prompt', 'the parser looks slow, always check the bundle size before merging!']]),
];
assert.deepEqual((await mine(asks, { handle: 'p', displayName: 'P' })).patterns, [
  { text: 'always check the bundle size before merging', seen: 2, sessions: 2, lastSeen: '2026-10-03' },
  { text: 'spin up a sub-agent for each', seen: 2, sessions: 2, lastSeen: '2026-10-02' },
  { text: 'rename the parser module', seen: 2, sessions: 2, lastSeen: '2026-10-02' },
]);
console.log('ok   patterns merge near-duplicates, start at any verb and need two sessions');

// v0.2: six sessions, each with a feature task (plan, 3 edits, tests, commit) and a design task, follow-ups
// that correct the agent, an interrupt, a rejected tool and a harness skill.
const mid = { midTask: true };
const v2 = [0, 1, 2, 3, 4, 5].map((k) => session(`v${k}`, `2026-10-1${k}T09:00:00.000Z`, [
  ['prompt', 'implement the export button. it should download a csv', { midTask: false, words: 10, namesFile: k < 2, hadPaste: k === 0 }],
  ...(k < 4 ? [['plan']] : []),
  ...(k === 4 ? [['check', 'test', true]] : []), // a test before the edits is not a test before the commit
  ['tool', 'Edit'], ['tool', 'Edit'], ['tool', 'Edit'],
  ...(k < 3 ? [['check', 'test', true], ['test', true]] : []),
  ...(k === 3 ? [['agent', 'general-purpose', 'opus']] : []), // runs the tests in a subagent
  ['git', 'commit'],
  ...(k < 4 ? [['prompt', 'show me the output', mid]] : []),
  ['prompt', ["no, don't add comments", "no, don't add comments", "no, don't add comments", 'never add comments', 'stop adding comments', 'now add the footer'][k], mid],
  ...(k < 2 ? [['interrupt'], ['prompt', 'run the tests first', { midTask: true, afterInterrupt: true }]] : []),
  ...(k < 2 ? [['tool', 'Bash'], ['denied', 'Bash'], ['prompt', 'use pnpm, not npm', mid]] : []),
  ...(k < 2 ? [['prompt', 'you forgot to update the README', mid]] : []),
  ...(k === 0 ? [['prompt', "don't rename the files", mid]] : []), // one session only
  ...(k < 2 ? [['prompt', "no, don't touch the config below", { midTask: true, hadPaste: true }]] : []),
  ['prompt', 'now add the footer', mid], // a follow-up, not a correction
  ['prompt', 'tweak the layout css of the header', { midTask: false, words: 6, images: k === 1 ? 1 : 0 }],
  ['skill', 'artifact-design'], ['tool', 'Edit'],
  ...(k < 3 ? [['mcp', 'chrome', 'screenshot'], ['check', 'screenshot', true]] : [['check', 'browser', true]]), // a click is not a look
], k === 3 ? [{ type: 'general-purpose', model: 'opus', script: [['tool', 'Bash'], ['check', 'test', true]] }] : []));
// Feedback memories (already redacted by the CLI) seed the rules: the mined "don't add comments" corrections
// cluster into the memory that says the same, which keeps its own wording and Why.
const memories = [
  { text: 'Never add comments', why: 'Comments rot faster than code.', repo: false },
  { text: 'Keep migrations reversible', why: null, repo: true }, // names a repo: starts off
  { text: 'Ask before adding a dependency', why: null, repo: false },
];
const lv2 = await mine(v2, { handle: 'v', displayName: 'V', memories });
assert.deepEqual(lv2.rules, [
  { id: 'rule-run-the-tests-first', text: 'Run the tests first', seen: 2, from: 'interrupt', sessions: 2, lastSeen: '2026-10-11' },
  { id: 'rule-update-the-readme', text: 'Update the README', seen: 2, from: 'correction', sessions: 2, lastSeen: '2026-10-11' },
  { id: 'rule-use-pnpm', text: 'Use pnpm', seen: 2, from: 'denied', sessions: 2, lastSeen: '2026-10-11' },
  // "don't add comments" and "stop adding comments" join it; seen counts the memory once.
  { id: 'rule-never-add-comments', text: 'Never add comments', seen: 6, from: 'memory', sessions: 5, lastSeen: '2026-10-14', why: 'Comments rot faster than code.', include: true },
  { id: 'rule-ask-before-adding-a-dependency', text: 'Ask before adding a dependency', seen: 1, from: 'memory', include: true },
  { id: 'rule-keep-migrations-reversible', text: 'Keep migrations reversible', seen: 1, from: 'memory', include: false },
  // Said in one session: listed after the habits, and the review page shows it switched off.
  { id: 'rule-dont-rename-the-files', text: "Don't rename the files", seen: 1, from: 'correction', sessions: 1, lastSeen: '2026-10-10' },
]);
assert.deepEqual((await mine(v2, { handle: 'v', displayName: 'V' })).rules.slice(0, 1),
  [{ id: 'rule-dont-add-comments', text: "Don't add comments", seen: 5, from: 'correction', sessions: 5, lastSeen: '2026-10-14' }], 'without memory');
assert.deepEqual(lv2.checks, [
  { id: 'plan-before-multi-file', text: 'Uses plan mode before multi-file changes', rate: 0.67, of: 6, when: 'any' },
  { id: 'tests-before-commit', text: 'Runs the tests before committing', rate: 0.67, of: 6, when: 'feature' },
  { id: 'browser-on-ui', text: 'Checks in the browser on UI tasks', rate: 0.5, of: 6, when: 'design' },
  { id: 'asks-for-proof', text: 'Asks for proof that it works', rate: 0.33, of: 12, when: 'any' },
]);
assert.deepEqual(lv2.openings, { medianWords: 6, withAttachment: 0.17, namesFiles: 0.17, definesDone: 0.5, usesPlanFirst: 0.33, of: 12 });
assert.ok(!lv2.kit.skills.some((sk) => sk.name === 'artifact-design'));
assert.ok(lv2.playbooks.every((p) => p.steps.every((st) => st.uses !== 'artifact-design')));
// Under five tasks a habit has no data behind it, so nothing is reported.
assert.deepEqual((await mine(v2.slice(0, 2), { handle: 'v', displayName: 'V' })).checks, []);
assert.deepEqual(strip(await mine([...v2].reverse(), { handle: 'v', displayName: 'V', memories })), strip(lv2));
// Instructions come out as imperatives; marker-only and stock replies are dropped.
const rule = (t, o) => ruleClauses(t, o).map((r) => r.text);
assert.deepEqual(rule("no, don't add comments"), ["Don't add comments"]);
assert.deepEqual(rule('stop, run the tests first'), ['Run the tests first']);
assert.deepEqual(rule('you forgot to update the README'), ['Update the README']);
assert.deepEqual(rule('actually, use pnpm instead of npm please'), ['Use pnpm instead of npm']);
assert.deepEqual(rule('wait, i told you to keep it short'), ['Keep it short']);
assert.deepEqual(rule('do not touch the migrations'), ["Don't touch the migrations"]);
assert.deepEqual(rule('i dont want you to add comments'), ["Don't add comments"]);
assert.deepEqual(rule('you should not touch the db'), ["Don't touch the db"]);
for (const t of ['no that is wrong', 'no plan card either', "don't i will do it", "don't worry about it", 'no no no', 'now add the footer', 'stop, why is it slow?', 'no, open ‹path›']) assert.deepEqual(rule(t), [], t);
assert.deepEqual(rule('run the linter', { forced: true }), ['Run the linter']); // after an interrupt or a rejected tool
console.log('ok   rules, checks and openings are mined from corrections, checks and opening prompts');

// Memory files: nested `metadata.type`, MEMORY.md and files without frontmatter skipped, the repo name from the
// project's sessions. Descriptions become short rules.
const read = await readMemories({ dir: fileURLToPath(new URL('../fixtures/claude', import.meta.url)) });
assert.deepEqual(read.map((m) => [m.name, m.type, m.repoName]), [
  ['feedback-deploy-key', 'feedback', 'api'], ['feedback-migrations', 'feedback', 'api'], ['feedback-no-restating-comments', 'feedback', 'api'],
  ['feedback-offline-tests', 'feedback', 'api'], ['feedback-shop-smoke', 'feedback', 'api'], ['project-roadmap', 'project', 'api'],
]);
assert.equal(read[1].description, 'Never edit a migration that already ran; add a new one');
assert.equal(read[2].why, 'Comments that repeat the code drift from it and mislead reviewers.');
assert.equal(memoryRule(read[2].description), 'Avoid comments that restate the code; explain why, not what');
assert.equal(memoryRule(read[3].description), 'Prefer tests that run offline and never hit the network'); // over 140: cut at a clause
{ const cut = memoryRule(`Keep ${'every single word '.repeat(12)}`); assert.ok(cut.length <= 140 && cut.endsWith('every…'), cut); }
console.log('ok   feedback memories are read from nested frontmatter and tightened into rules');

// Ordering: steps follow their order within the turn. A step that often runs alone ("edits code") must not
// jump ahead of the steps it follows whenever they run together; harness skills are never steps.
const plan = [0, 1, 2, 3, 4, 5, 6].map((i) => session(`o${i}`, `2026-10-2${i}T09:00:00.000Z`, i < 3
  ? [['prompt', 'new idea: plan the onboarding'], ['skill', 'artifact-design'], ['skill', 'mattpocock-skills:grilling'], ['mcp', 'linear', 'x'], ['tool', 'Edit']]
  : [['prompt', 'new idea: plan the onboarding'], ['tool', 'Edit']]));
// A slash-invoked skill arrives mid-turn without a prompt: the edits before it were the previous request.
plan.push(session('o7', '2026-10-27T09:00:00.000Z', [['prompt', 'ok'], ['tool', 'Edit'], ['tool', 'Edit'], ['skill', 'mattpocock-skills:grilling'], ['mcp', 'linear', 'x']]),
  session('o8', '2026-10-27T11:00:00.000Z', [['prompt', 'ok'], ['tool', 'Edit'], ['skill', 'mattpocock-skills:grilling'], ['mcp', 'linear', 'x'], ['tool', 'Edit']]));
// Another class as the baseline the skill and MCP steps lift against.
plan.push(...[0, 1, 2, 3, 4, 5].map((i) => session(`r${i}`, `2026-10-2${i}T15:00:00.000Z`, [['prompt', 'refactor the parser'], ['tool', 'Edit']])));
assert.deepEqual((await mine(plan, { handle: 'o', displayName: 'O' })).playbooks.map((p) => p.steps.map((st) => st.do)),
  [['Uses the grilling skill', 'Uses linear (MCP)', 'Edits code']]);
console.log('ok   steps keep their order within the turn, harness skills are not steps or kit');

// Stable: same input in any order gives the same loadout.
assert.deepEqual(strip(await mine([...sessions].reverse(), { handle: 'maya', displayName: 'Maya' })), strip(loadout));
console.log('ok   output does not depend on session order');

// Units: classifier, phrase splitting, subagent attribution without timestamps.
assert.equal(classify('the build is broken, fix it').id, 'bug');
assert.equal(classify('implement a settings page').id, 'feature'); // one strong word
assert.equal(classify('add support for exports').id, 'feature'); // two weak words
assert.equal(classify('add a settings page'), null); // one weak word is not enough
assert.equal(classify('the ui looks off'), null);
assert.equal(classify('the ui is broken').id, 'bug');
assert.equal(classify('make a mockup of the ui').id, 'design');
assert.equal(classifyTurn('next one', [{ key: 'skill:mattpocock-skills:grilling' }]).id, 'idea'); // skill evidence
assert.equal(classify('sure'), null);
assert.deepEqual(phrases('Could you spin up a sub-agent for each? why is it slow?').map((p) => p.text), ['spin up a sub-agent for each']);
const untimed = {
  id: 'u', events: [{ kind: 'prompt', text: 'one' }, { kind: 'agent', type: 'Plan' }, { kind: 'prompt', text: 'two' }, { kind: 'agent', type: 'Plan' }],
  subagents: [{ type: 'Plan', events: [{ kind: 'skill', name: 'tdd' }] }, { type: 'Plan', events: [{ kind: 'mcp', server: 'linear' }] }],
};
assert.deepEqual(turnsOf(untimed).map((t) => t.steps.map((s) => s.key)), [['agent:Plan', 'skill:tdd'], ['agent:Plan', 'mcp:linear']]);
console.log('ok   classifier, phrase splitting and subagent attribution');

// --llm merge: only name/when/steps[].do change; any shape mismatch throws so mine() keeps the deterministic result.
const reply = JSON.stringify({ playbooks: loadout.playbooks.map((p) => ({ id: p.id, name: `${p.name}!`, when: 'When.', steps: p.steps.map((_, i) => `Step ${i}`), trigger: ['x'] })) });
const merged = applyRewrite(loadout, '```json\n' + reply + '\n```');
assert.equal(merged.playbooks[0].name, 'New idea or plan!');
assert.deepEqual(merged.playbooks[0].steps[0], { do: 'Step 0', uses: 'mattpocock-skills:grill-with-docs' });
assert.deepEqual(merged.playbooks[0].trigger, loadout.playbooks[0].trigger);
assert.deepEqual(merged.patterns, loadout.patterns);
assert.throws(() => applyRewrite(loadout, 'not json'));
assert.throws(() => applyRewrite(loadout, JSON.stringify({ playbooks: [{ id: 'bug', name: 'x', when: 'y', steps: ['one'] }] })));
console.log('ok   --llm rewrite merges only wording and rejects bad replies');

// Kit sources from the invented plugin files and skills folder in fixtures/claude.
const claudeFixture = fileURLToPath(new URL('../fixtures/claude', import.meta.url));
const sourced = withSources({
  skills: [{ name: 'grill-me' }, { name: 'mattpocock-skills:grilling' }, { name: 'context-tools:lookup' }, { name: 'gone:x' }, { name: 'simplify' }, { name: '..' }],
  mcp: [{ server: 'context7' }, { server: 'plugin_context_tools_docs' }, { server: 'plugin_other_srv' }],
  agents: { share: 0, types: [], models: [] },
}, claudeFixture, { home: '/home/demo', repoNames: ['secret-app'] });
assert.deepEqual(sourced.skills.map((s) => s.source), [
  { kind: 'personal', bundled: false },
  { kind: 'plugin', plugin: 'mattpocock-skills', marketplace: 'mattpocock', repo: 'mattpocock/skills' },
  { kind: 'plugin', plugin: 'context-tools', marketplace: 'acme-git', url: 'https://gitlab.com/acme/claude-plugins' },
  { kind: 'plugin', plugin: 'gone' },
  { kind: 'builtin' },
  { kind: 'builtin' },
]);
assert.deepEqual(sourced.mcp.map((m) => m.source), [
  { kind: 'personal' },
  { kind: 'plugin', plugin: 'context-tools', marketplace: 'acme-git', url: 'https://gitlab.com/acme/claude-plugins' },
  { kind: 'plugin', plugin: 'other' },
]);
// The bundle candidate: SKILL.md first, redacted, nothing ignored; no path, version or SHA anywhere.
assert.deepEqual(sourced.skills[0].files.map((f) => f.path), ['SKILL.md', 'references/checklist.md']);
assert.match(sourced.skills[0].files[0].text, /Keep notes in ‹path›/);
assert.ok(!/home\/demo|1\.2\.0|0000000/.test(JSON.stringify(sourced)));
// A private marketplace name stays out; the plugin is still named.
assert.deepEqual(withSources({ skills: [{ name: 'mattpocock-skills:tdd' }], mcp: [] }, claudeFixture, { repoNames: ['mattpocock'] }).skills[0].source,
  { kind: 'plugin', plugin: 'mattpocock-skills' });
// Claude Code's own marketplace stays even when a repo part ("claude") is a private name to the redactor.
assert.deepEqual(withSources({ skills: [{ name: 'code-review:review-pr' }], mcp: [] }, claudeFixture, { repoNames: ['claude-notes'] }).skills[0].source,
  { kind: 'plugin', plugin: 'code-review', marketplace: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official' });
// No plugin files at all: plugin skills keep their plugin name, bare names are built in.
assert.deepEqual(withSources({ skills: [{ name: 'a:b' }, { name: 'c' }], mcp: [] }, '/nonexistent').skills.map((s) => s.source), [{ kind: 'plugin', plugin: 'a' }, { kind: 'builtin' }]);
// Skill folders that can't be bundled: over the cap, a binary file, no SKILL.md. Links and private file names are skipped.
const sk = await mkdtemp(join(tmpdir(), 'loadout-skills-'));
try {
  const folder = async (name, files) => {
    await mkdir(join(sk, name), { recursive: true });
    for (const [f, body] of Object.entries(files)) await writeFile(join(sk, name, f), body);
    return join(sk, name);
  };
  assert.equal(skillFiles(await folder('big', { 'SKILL.md': 'x'.repeat(MAX_SKILL_BYTES + 1) })), null);
  assert.equal(skillFiles(await folder('bin', { 'SKILL.md': 'ok', 'logo.png': Buffer.from([137, 80, 0, 1]) })), null);
  assert.equal(skillFiles(await folder('none', { 'notes.md': 'ok' })), null);
  const ok = await folder('ok', { 'SKILL.md': 'Use it in secret-app.', 'secret-app.md': 'x' });
  await symlink('/etc/hosts', join(ok, 'hosts'));
  assert.deepEqual(skillFiles(ok, { repoNames: ['secret-app'] }), [{ path: 'SKILL.md', text: 'Use it in ‹name›.' }]);
} finally {
  await rm(sk, { recursive: true, force: true });
}
console.log('ok   kit sources: plugin and marketplace, built in or personal, and bundle candidates');
