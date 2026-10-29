// dropRedacted: items that became a redaction placeholder after redactDeep never ship.
import assert from 'node:assert/strict';
import { claudeMdDraft, dropRedacted, forPack, markIncluded, switchOff } from '../src/clean.mjs';

const loadout = {
  handle: 'maya',
  playbooks: [
    { id: 'fix-bug', name: 'Fix a bug', steps: [{ do: 'runs tests' }, { do: 'checks the logs', uses: '‹name›' }, { do: '‹name›' }, { do: 'opens ‹path›' }] },
    { id: 'repo', name: 'Work in ‹name›', steps: [{ do: '‹name› ‹path›' }] },
  ],
  patterns: [{ text: 'Plan first, then build', seen: 3 }, { text: 'Look at ‹name› first', seen: 2 }],
  rules: [{ id: 'deps', text: 'Ask before adding a dependency', seen: 3 }, { id: 'repo', text: 'Never touch ‹path›', seen: 2 }],
  checks: [{ id: 'tests', text: 'Runs the tests before committing', rate: 0.7, of: 10, when: 'any' }, { id: 'svc', text: 'Curls ‹host› after deploys', rate: 0.5, of: 6, when: 'any' }],
  kit: { skills: [{ name: 'tdd', seen: 4 }, { name: '‹name›:deploy', seen: 2 }], mcp: [{ server: 'github', seen: 9 }, { server: '‹name›', seen: 48 }], agents: { share: 0 } },
  removed: { names: 6 },
};
const before = structuredClone(loadout);
const { value, dropped } = dropRedacted(loadout);

assert.deepEqual(loadout, before, 'input is not mutated');
assert.deepEqual(value.kit.skills.map((s) => s.name), ['tdd']);
assert.deepEqual(value.kit.mcp.map((m) => m.server), ['github']);
assert.deepEqual(value.patterns.map((p) => p.text), ['Plan first, then build']);
assert.deepEqual(value.playbooks.map((p) => p.id), ['fix-bug']);
assert.deepEqual(value.playbooks[0].steps.map((s) => s.do), ['runs tests', 'opens ‹path›']);
assert.deepEqual(value.rules.map((r) => r.id), ['deps']);
assert.deepEqual(value.checks.map((c) => c.id), ['tests']);
assert.deepEqual(dropped, { skills: 1, mcp: 1, steps: 3, patterns: 1, rules: 1, checks: 1, playbooks: 1 });
assert.deepEqual(value.removed, { names: 6 }, 'redaction counts are kept');
assert.ok(!JSON.stringify(value.kit).includes('‹'));
console.log('ok - dropRedacted drops placeholder kit items, steps, patterns, rules, checks and empty playbooks');

// CLAUDE.md: redacted and capped in the draft, off by default, and only in a pack when switched on, without the flag.
const ctx = { home: '/Users/maya', repoNames: [], extraNames: [] };
const { claudeMd, removed } = claudeMdDraft(`- Keep tests offline.\n- My notes live in /Users/maya/notes.md\n${'- a long standing instruction\n'.repeat(200)}`, ctx);
assert.equal(claudeMd.include, false);
assert.ok(!claudeMd.text.includes('/Users/maya') && removed.paths >= 1, 'redacted');
assert.ok(Buffer.byteLength(claudeMd.text) <= 3072 && claudeMd.text.endsWith('…\n'), 'capped at a line');
assert.equal(claudeMdDraft('  \n', ctx).claudeMd, null);
const draft = markIncluded({ ...structuredClone(value), claudeMd });
assert.ok(draft.rules.every((r) => r.include === true) && draft.claudeMd.include === false);
assert.equal(markIncluded({ rules: [{ id: 'once', text: 'Keep it short', seen: 1 }] }).rules[0].include, false, 'said once starts off');
// A memory rule keeps the switch mining gave it; only the first 10 that are on stay on; its Why never ships.
const memory = markIncluded({ rules: [
  { id: 'repo', text: 'Keep migrations reversible', seen: 1, from: 'memory', include: false },
  ...Array.from({ length: 11 }, (_, i) => ({ id: `m${i}`, text: `Rule ${i}`, seen: 1, from: 'memory', why: 'Because.', include: true })),
] }).rules;
assert.deepEqual(memory.map((r) => r.include), [false, ...Array(10).fill(true), false]);
assert.ok(forPack({ rules: memory }).rules.every((r) => !('why' in r)) && forPack({ rules: memory }).rules.length === 10);
assert.equal(forPack(draft).claudeMd, undefined, 'off by default');
draft.rules[0].include = false;
draft.claudeMd.include = true;
const pack = forPack(draft);
assert.deepEqual(pack.rules, []);
assert.deepEqual(pack.claudeMd, { text: claudeMd.text });
assert.deepEqual(forPack(pack).claudeMd, pack.claudeMd, 'a pack keeps it on reload');
assert.ok(!JSON.stringify(pack).includes('"include"'));
console.log('ok - CLAUDE.md and repo-bound memory rules start off, at most 10 rules start on, and packs carry only what was switched on, without flags or Why');

// A rebuild starts what the owner forgot switched off, matched by text when the mined id changed.
const rebuilt = markIncluded(structuredClone(value));
assert.equal(switchOff(rebuilt, [{ ref: 'rule:old-id', text: 'Ask before adding a dependency' }, { ref: 'check:tests' }]), 2);
assert.deepEqual([forPack(rebuilt).rules, forPack(rebuilt).checks], [[], []]);
console.log('ok - switchOff turns forgotten items off in a draft, and packs leave them out');
console.log('3 clean checks passed');
