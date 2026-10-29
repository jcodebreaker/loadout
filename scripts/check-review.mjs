// Review server: serves the page, reads the draft, saves only allowed edits, and resolves on publish.
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LOADOUT_NO_OPEN = '1';
const { startReview, checkEdit } = await import('../src/review/server.mjs');

const dir = mkdtempSync(join(tmpdir(), 'loadout-review-'));
const draftPath = join(dir, 'maya.json');
copyFileSync(fileURLToPath(new URL('../fixtures/draft-example.json', import.meta.url)), draftPath);
const onDisk = () => JSON.parse(readFileSync(draftPath, 'utf8'));
const original = onDisk();

let passed = 0;
const settled = (p) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('done did not resolve')), 2000))]);
const ok = (name) => (passed++, console.log(`ok - ${name}`));
const { url, close, done } = await startReview({ draftPath });
const post = (path, value) =>
  fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

try {
  const page = await fetch(url + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Review your loadout<\/title>/);
  ok('GET / serves the review page');

  assert.deepEqual(await (await fetch(url + '/api/draft')).json(), original);
  ok('GET /api/draft returns the draft');

  const edit = structuredClone(original);
  edit.playbooks[0].name = 'Spec first feature';
  edit.playbooks[1].include = false;
  edit.patterns[0].include = false;
  edit.kit.skills[2].include = false;
  edit.kit.mcp[1].include = false;
  edit.rules[0].include = false;
  edit.rules[1].text = 'Ask before adding any dependency';
  edit.claudeMd.include = true;
  assert.equal((await post('/api/draft', edit)).status, 200);
  const saved = onDisk();
  assert.equal(saved.playbooks[0].name, 'Spec first feature');
  assert.equal(saved.playbooks[1].include, false);
  assert.equal(saved.patterns[0].include, false);
  assert.equal(saved.kit.skills[2].include, false);
  assert.equal(saved.kit.mcp[1].include, false);
  assert.equal(saved.rules[0].include, false);
  assert.equal(saved.rules[1].text, 'Ask before adding any dependency');
  assert.equal(saved.claudeMd.include, true);
  ok('POST /api/draft saves toggles (rules and CLAUDE.md too), a rename and a reworded rule');

  const bad = [
    ['the handle', (d) => (d.handle = 'someone-else')],
    ['a new top-level field', (d) => (d.extra = true)],
    ['a new field on a playbook', (d) => (d.playbooks[0].note = 'x')],
    ['a pattern text', (d) => (d.patterns[0].text = 'Something else')],
    ['a removed item', (d) => d.patterns.pop()],
    ['a non-boolean include', (d) => (d.kit.skills[0].include = 'yes')],
    ['an empty playbook name', (d) => (d.playbooks[0].name = ' ')],
    ['an empty rule', (d) => (d.rules[0].text = ' ')],
    ['a rule id', (d) => (d.rules[0].id = 'other')],
    ['the removed counts', (d) => (d.removed.secrets = 0)],
    ['a rule source', (d) => (d.rules[1].from = 'interrupt')],
    ['a rule count', (d) => (d.rules[0].seen = 99)],
    ['a removed rule', (d) => d.rules.pop()],
    ['a non-boolean rule include', (d) => (d.rules[0].include = 1)],
    ['a check rate', (d) => (d.checks[0].rate = 1)],
    ['a check include', (d) => (d.checks[0].include = false)],
    ['the openings', (d) => (d.openings.medianWords = 10)],
    ['the CLAUDE.md text', (d) => (d.claudeMd.text += '\nextra')],
    ['dropping the CLAUDE.md', (d) => (d.claudeMd = null)],
    ['a non-boolean CLAUDE.md include', (d) => (d.claudeMd.include = 'on')],
  ];
  for (const [what, change] of bad) {
    const d = structuredClone(saved);
    change(d);
    assert.equal((await post('/api/draft', d)).status, 400, what);
  }
  assert.deepEqual(onDisk(), saved);
  ok(`POST /api/draft rejects ${bad.length} read-only changes with 400 and leaves the file alone`);

  const older = structuredClone(original);
  delete older.rules; delete older.checks; delete older.openings; older.claudeMd = null;
  const olderEdit = structuredClone(older);
  olderEdit.patterns[0].include = false;
  assert.equal(checkEdit(older, olderEdit), null);
  assert.notEqual(checkEdit(older, { ...olderEdit, claudeMd: { text: 'x', include: true } }), null);
  assert.notEqual(checkEdit(older, { ...olderEdit, rules: [] }), null);
  ok('a draft without rules or CLAUDE.md still saves toggles, and neither can be added');

  assert.match(await (await fetch(url + '/')).text(), />Close without publishing</);
  assert.equal((await post('/api/done', {})).status, 200);
  assert.deepEqual(await settled(done), { publish: true });
  ok('POST /api/done resolves { publish: true } and closes');

  const viaPage = await startReview({ draftPath });
  assert.equal((await fetch(viaPage.url + '/api/close', { method: 'POST' })).status, 200);
  assert.deepEqual(await settled(viaPage.done), { publish: false });
  ok('POST /api/close resolves { publish: false }');

  const viaClose = await startReview({ draftPath });
  viaClose.close();
  assert.deepEqual(await settled(viaClose.done), { publish: false });
  ok('close() (Ctrl-C) resolves { publish: false }');
} finally {
  close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} review checks passed`);
