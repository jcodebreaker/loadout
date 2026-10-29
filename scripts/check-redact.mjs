// Offline check for src/redact.mjs: a table of tricky inputs, their exact outputs and counts.
// Fake secrets are assembled from pieces so no scanner mistakes this file for a leak.
import assert from 'node:assert/strict';
import { redactText, redactSession, redactDeep } from '../src/redact.mjs';

const ctx = { home: '/Users/jdoe-dev', repoNames: ['acme-web', 'Orbital'], extraNames: ['Globex Corp'] };
const j = (...parts) => parts.join('');
const fill = (n, s = 'aB3x') => s.repeat(Math.ceil(n / s.length)).slice(0, n);

// [label, input, expected output, expected non-zero counts]
const cases = [
  // Secrets by shape
  ['openai key', j('use sk-', 'proj-', fill(40), ' here'), 'use ‹secret› here', { secrets: 1 }],
  ['anthropic key', j('key sk-', 'ant-', 'api03-', fill(30)), 'key ‹secret›', { secrets: 1 }],
  ['github pat classic', j('gh', 'p_', fill(36)), '‹secret›', { secrets: 1 }],
  ['github oauth', j('gh', 'o_', fill(36)), '‹secret›', { secrets: 1 }],
  ['github fine-grained', j('github_', 'pat_', fill(60)), '‹secret›', { secrets: 1 }],
  ['slack bot', j('xo', 'xb-', '1234-5678-', fill(20)), '‹secret›', { secrets: 1 }],
  ['slack user', j('xo', 'xp-', '1234-5678-', fill(20)), '‹secret›', { secrets: 1 }],
  ['aws access key', j('AK', 'IA', 'ABCDEFGH12345678'), '‹secret›', { secrets: 1 }],
  ['google api key', j('AI', 'za', fill(35)), '‹secret›', { secrets: 1 }],
  ['stripe live secret', j('sk', '_live_', fill(24)), '‹secret›', { secrets: 1 }],
  ['stripe live publishable', j('pk', '_live_', fill(24)), '‹secret›', { secrets: 1 }],
  [
    'jwt',
    j('auth with eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    'auth with ‹secret›',
    { secrets: 1 },
  ],
  [
    'pem block',
    j('here:\n-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow', fill(60), '\n', fill(60), '\n-----END RSA PRIVATE KEY-----\nthanks'),
    'here:\n‹secret›\nthanks',
    { secrets: 1 },
  ],
  ['unterminated pem', j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nb3Blbn', fill(40)), '‹secret›', { secrets: 1 }],
  ['env line', 'set DATABASE_PASSWORD=hunter2 and STRIPE_KEY="abc def"', 'set DATABASE_PASSWORD=‹secret› and STRIPE_KEY=‹secret›', { secrets: 2 }],
  ['export env line', 'export OPENAI_BASE=whatever', 'export OPENAI_BASE=‹secret›', { secrets: 1 }],
  ['token next to word', j('my token is ', fill(24, '9f3a')), 'my token is ‹secret›', { secrets: 1 }],
  ['password with colon', j('password: "', fill(18), '"'), 'password: "‹secret›"', { secrets: 1 }],
  ['bearer header', j('curl -H "Authorization: Bearer ', fill(30), '"'), 'curl -H "Authorization: Bearer ‹secret›"', { secrets: 1 }],
  ['bare long hex', `hash ${'0123456789abcdef'.repeat(2)} done`, 'hash ‹secret› done', { secrets: 1 }],
  ['bare long base64', `blob ${fill(48)} done`, 'blob ‹secret› done', { secrets: 1 }],

  // Contact and network
  ['email', 'ping jane.doe+ops@example.co.uk today', 'ping ‹email› today', { emails: 1 }],
  ['url', 'see https://dash.example.com/a?b=1, then', 'see ‹url›, then', { urls: 1 }],
  ['url with creds', 'postgres://admin:pw@db.internal:5432/app', '‹url›', { urls: 1 }],
  ['github url too', 'clone https://github.com/someorg/private-repo.', 'clone ‹url›.', { urls: 1 }],
  ['scp git remote', 'push to git@github.com:someorg/thing.git', 'push to ‹url›', { urls: 1 }],
  ['hostname', 'ssh into build-01.corp.example.com:2222 now', 'ssh into ‹host› now', { hosts: 1 }],
  ['internal host', 'the api at billing.internal is slow', 'the api at ‹host› is slow', { hosts: 1 }],
  ['ipv4', 'server 10.0.12.7:8080 and 192.168.1.1', 'server ‹host› and ‹host›', { hosts: 2 }],
  ['ipv6', 'bind fe80:0:0:0:1ff:fe23:4567:890a', 'bind ‹host›', { hosts: 1 }],

  // Shell prompts and machine names
  ['zsh prompt', 'jsmith@jsmiths-macbook-air loadout % npm test', '‹host› npm test', { hosts: 1 }],
  ['bash prompt', 'jsmith@devbox:~/work/app$ ls', '‹host› ls', { hosts: 1 }],
  ['bash prompt abs', 'output:\nroot@web1:/var/www# ls -la', 'output:\n‹host› ls -la', { hosts: 1 }],
  ['bracket prompt', '[jsmith@devbox app]$ make', '‹host› make', { hosts: 1 }],
  ['powershell prompt', String.raw`PS C:\Users\Jane\proj> dir`, '‹host› dir', { hosts: 1 }],
  ['user at host', 'logged in as jsmith@devbox fine', 'logged in as ‹host› fine', { hosts: 1 }],
  ['package tags kept', 'npx skills@latest and react@18', 'npx skills@latest and react@18', {}],
  ['macbook names', 'on Janes-MacBook-Pro and bobs-mbp and lab-mac-mini-2', 'on ‹host› and ‹host› and ‹host›', { hosts: 3 }],
  ['pc names', 'from build-pc, ops-thinkpad, my-laptop', 'from ‹host›, ‹host›, ‹host›', { hosts: 3 }],
  ['dot local lan home', 'ping studio.local, nas.lan and router.home', 'ping ‹host›, ‹host› and ‹host›', { hosts: 3 }],
  ['real leak shape', 'jdoe-dev@jdoe-macbook-air acme-web % git status', '‹host› git status', { hosts: 1 }],

  // Paths
  ['unix abs path', 'open /opt/data/report.csv please', 'open ‹path› please', { paths: 1 }],
  ['home path', 'edit /Users/jdoe-dev/work/app/src/main.ts.', 'edit ‹path›.', { paths: 1 }],
  ['tilde path', 'read ~/notes/plan.md and ~bob/x', 'read ‹path› and ‹path›', { paths: 2 }],
  ['windows path', String.raw`run C:\Users\Jane\proj\build.ps1 now`, 'run ‹path› now', { paths: 1 }],
  ['windows forward', 'at D:/work/thing', 'at ‹path›', { paths: 1 }],
  ['unc path', String.raw`copy \\fileserver\share\q3.xlsx`, 'copy ‹path›', { paths: 1 }],
  ['path in backticks', 'look at `/srv/app/config.yml`', 'look at `‹path›`', { paths: 1 }],
  ['path in quotes', `cat '/etc/hosts' and "/var/log/x.log"`, `cat '‹path›' and "‹path›"`, { paths: 2 }],
  ['quoted path with spaces', 'see `/Users/jdoe-dev/My Docs/a.txt` and "~/Old Stuff/b"', 'see `‹path›` and "‹path›"', { paths: 2 }],
  ['single root', 'clean /tmp first', 'clean ‹path› first', { paths: 1 }],

  // Names
  ['repo name any case', 'ship ACME-WEB and acme-web and orbital', 'ship ‹name› and ‹name› and ‹name›', { names: 3 }],
  ['multi-word name', 'call globex corp tomorrow', 'call ‹name› tomorrow', { names: 1 }],
  ['name whole word only', 'orbitals are fine but Orbital is not', 'orbitals are fine but ‹name› is not', { names: 1 }],
  ['home username', 'ask jdoe-dev', 'ask ‹name›', { names: 1 }],

  // Code
  ['code fence', 'fix this:\n```js\nconst a = 1;\n```\nok?', 'fix this:\n‹code›\nok?', { code: 1 }],
  ['open code fence', 'here\n```\nsecret stuff', 'here\n‹code›', { code: 1 }],
  ['long inline code', 'run `' + 'x'.repeat(50) + '` now', 'run ‹code› now', { code: 1 }],
  ['short inline code', 'run `npm test` now', 'run `npm test` now', {}],
  [
    'js stack trace',
    'TypeError: boom\n    at foo (src/a.js:10:5)\n    at bar (node:internal/x:2:3)\nwhy?',
    'TypeError: boom\n‹code›\nwhy?',
    { code: 1 },
  ],
  [
    'python traceback',
    'Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    main()\nValueError: no',
    '‹code›\nValueError: no',
    { code: 1 },
  ],

  // Must survive unchanged
  ['plain ask', 'make a mockup first', 'make a mockup first', {}],
  ['skill ask', 'use the tdd skill', 'use the tdd skill', {}],
  ['slash command', '/loadout:use maya then /review', '/loadout:use maya then /review', {}],
  ['relative path', 'edit src/redact.mjs and README.md', 'edit src/redact.mjs and README.md', {}],
  ['js file names', 'node.js and next.config.js, e.g. this', 'node.js and next.config.js, e.g. this', {}],
  ['times and versions', 'at 10:30:00 bump to v1.2.3', 'at 10:30:00 bump to v1.2.3', {}],
  ['scoped package', 'install @types/node', 'install @types/node', {}],
  ['code property chain', 'read process.env.HOME first', 'read process.env.HOME first', {}],
  ['and/or', 'tests and/or docs, 50/50', 'tests and/or docs, 50/50', {}],
  ['word token alone', 'the token is generated by the backend', 'the token is generated by the backend', {}],
  ['keyboard', 'add a keyboardShortcut1234567 hint', 'add a keyboardShortcut1234567 hint', {}],
  ['placeholder idempotent', '‹path› ‹secret› ‹url›', '‹path› ‹secret› ‹url›', {}],
];

let n = 0;
for (const [label, input, expected, counts] of cases) {
  const { text, removed } = redactText(input, ctx);
  assert.equal(text, expected, `${label}: text`);
  const want = { paths: 0, secrets: 0, emails: 0, hosts: 0, names: 0, code: 0, urls: 0, ...counts };
  assert.deepEqual(removed, want, `${label}: counts`);
  // A second pass must find nothing new.
  assert.equal(redactText(text, ctx).text, text, `${label}: idempotent`);
  n++;
}
console.log(`ok redactText: ${n} cases`);

// Counts hold numbers only, never the removed values.
{
  const secret = j('gh', 'p_', fill(36));
  const { removed } = redactText(`a ${secret} b`, ctx);
  assert.ok(Object.values(removed).every((v) => typeof v === 'number'));
  assert.ok(!JSON.stringify(removed).includes(secret));
}
assert.deepEqual(redactText('', ctx).removed.paths, 0);
assert.equal(redactText(undefined, ctx).text, '');

// redactSession: prompts in the main thread and subagents, other events untouched, input not mutated.
{
  const session = {
    id: 's1',
    source: 'claude-code',
    startedAt: '2026-01-01T00:00:00Z',
    cwdName: 'Acme-Web',
    events: [
      { kind: 'prompt', text: 'fix /Users/jdoe-dev/x/y.ts for orbital', at: 1, hadPaste: false },
      { kind: 'skill', name: 'tdd', at: 2 },
      { kind: 'tool', name: 'Bash', at: 3 },
    ],
    subagents: [{ type: 'Explore', model: 'haiku', events: [{ kind: 'prompt', text: 'mail a@b.io', at: 4, hadPaste: false }] }],
  };
  const before = structuredClone(session);
  const { session: out, removed } = redactSession(session, ctx);
  assert.deepEqual(session, before, 'redactSession mutated its input');
  assert.equal(out.events[0].text, 'fix ‹path› for ‹name›');
  assert.deepEqual(out.events[1], session.events[1]);
  assert.notEqual(out.events[1], session.events[1]);
  assert.equal(out.subagents[0].events[0].text, 'mail ‹email›');
  assert.equal(out.cwdName, '‹name›');
  assert.deepEqual(removed, { paths: 1, secrets: 0, emails: 1, hosts: 0, names: 2, code: 0, urls: 0 });
  assert.equal(out.id, 's1');

  const plain = redactSession({ ...session, cwdName: 'loadout' }, ctx).session;
  assert.equal(plain.cwdName, 'loadout');
  console.log('ok redactSession');
}

// redactDeep: nested objects and arrays, non-strings kept, input not mutated.
{
  const obj = {
    handle: 'maya',
    version: 1,
    ok: true,
    nothing: null,
    playbooks: [{ name: 'ship acme-web', steps: [{ do: 'open https://x.example.com', uses: 'tdd' }], seen: 3 }],
    patterns: [{ text: 'mail ops@example.com', seen: 2 }],
    nested: { deeper: [['/home/maya/repo/file.txt', 7]] },
  };
  const before = structuredClone(obj);
  const { value, removed } = redactDeep(obj, ctx);
  assert.deepEqual(obj, before, 'redactDeep mutated its input');
  assert.equal(value.handle, 'maya');
  assert.equal(value.version, 1);
  assert.equal(value.ok, true);
  assert.equal(value.nothing, null);
  assert.equal(value.playbooks[0].name, 'ship ‹name›');
  assert.equal(value.playbooks[0].steps[0].do, 'open ‹url›');
  assert.equal(value.playbooks[0].steps[0].uses, 'tdd');
  assert.equal(value.playbooks[0].seen, 3);
  assert.equal(value.patterns[0].text, 'mail ‹email›');
  assert.deepEqual(value.nested.deeper, [['‹path›', 7]]);
  assert.deepEqual(removed, { paths: 1, secrets: 0, emails: 1, hosts: 0, names: 1, code: 0, urls: 1 });
  assert.equal(redactDeep('x@y.io', ctx).value, '‹email›');
  console.log('ok redactDeep');
}

// Fast enough to run over months of prompts.
{
  const big = 'please make the mockup and run the tdd skill on src/a.mjs, then /review. '.repeat(2000);
  const t = performance.now();
  redactText(big, ctx);
  const ms = performance.now() - t;
  assert.ok(ms < 500, `slow: ${ms}ms`);
  console.log(`ok speed: ${big.length} chars in ${ms.toFixed(0)}ms`);
}

// A repo name also goes when written apart ("starfield" as "Star Field" or "star-field"),
// and a long part of a dashed name counts on its own; ordinary parts like "server" stay.
{
  const c = { home: '', repoNames: ['nova-starfield', 'web-server'], extraNames: [] };
  assert.equal(redactText('Star Field must never say helper; the star-field app; Starfield', c).text, '‹name› must never say helper; the ‹name› app; ‹name›');
  assert.equal(redactText('restart the server', c).text, 'restart the server');
  console.log('ok repo names written apart, and long parts of dashed names');
}
