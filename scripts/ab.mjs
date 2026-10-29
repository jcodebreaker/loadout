#!/usr/bin/env node
// A/B pilot: does an active loadout change what Claude Code does on a real task?
// Manual and paid (real `claude -p` runs). Not part of `npm run check`.
//
//   node scripts/ab.mjs                         every task x both arms x AB_REPS
//   node scripts/ab.mjs --dry                   print the plan, run nothing
//   node scripts/ab.mjs --tasks bug --reps 1    a subset
//
// Each run copies fixtures/ab/toy into a fresh temp git repo and gives Claude a fresh
// LOADOUT_HOME. Arm "plain": nothing active. Arm "loaded": docs/example/maya.loadout turned on
// with `loadout use` and `loadout suggest auto`. Both arms load the plugin with --plugin-dir,
// skip user settings, plugins, MCP servers and session files, run in acceptEdits with a narrow
// tool allowlist and a turn cap.
// After a run the script reads the stream, diffs the temp repo, runs its tests and a hidden check.
//
// Env / flags: AB_MODEL (sonnet), AB_REPS (2), AB_MAX_TURNS (12), AB_BUDGET (1.00 USD per run),
// AB_JOBS (3 runs at once), AB_KEEP=1 keeps the temp dirs, AB_CLAUDE (the claude binary). Point
// AB_CLAUDE at the real binary when `claude` on PATH is a wrapper that adds its own hooks: such
// hooks change timing and permissions, and every row records any hook that isn't the plugin's.
// Results: fixtures/ab/results.json.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(root, 'fixtures', 'ab');
const cli = join(root, 'bin', 'loadout.mjs');
const pack = join(root, 'docs', 'example', 'maya.loadout');
// The pack can change under us (it is generated); record which LOADOUT.md the loaded arm saw.
const packHash = createHash('sha256').update(readFileSync(join(pack, 'LOADOUT.md'))).digest('hex').slice(0, 12);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const dry = argv.includes('--dry');
const model = flag('model', process.env.AB_MODEL || 'sonnet');
const reps = Number(flag('reps', process.env.AB_REPS || 2));
const maxTurns = String(flag('max-turns', process.env.AB_MAX_TURNS || 12));
const budget = String(flag('budget', process.env.AB_BUDGET || '1.00'));
const jobs = Number(flag('jobs', process.env.AB_JOBS || 3));
const out = flag('out', join(fx, 'results.json'));
const allTasks = JSON.parse(readFileSync(join(fx, 'tasks.json'), 'utf8'));
const pick = flag('tasks', '');
const tasks = pick ? allTasks.filter((t) => pick.split(',').includes(t.id)) : allTasks;
const arms = flag('arms', 'plain,loaded').split(',');

// The only tools a run may use. Anything else that needs permission is denied (print mode
// cannot prompt), and the denial is counted.
const ALLOWED = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(node --test*)', 'Bash(node *.mjs)', 'Bash(git diff*)', 'Bash(git status*)'];
const DISALLOWED = ['WebFetch', 'WebSearch'];
const claudeBin = process.env.AB_CLAUDE || 'claude';

const tmp = mkdtempSync(join(tmpdir(), 'loadout-ab-'));
const env = (home) => ({ ...process.env, LOADOUT_HOME: home });
const sh = (cmd, args, cwd, extraEnv = process.env) => spawnSync(cmd, args, { cwd, env: extraEnv, encoding: 'utf8', timeout: 120_000 });

// Claude Code creates ~/.claude/projects/<cwd>/ even with --no-session-persistence (an empty
// memory/ folder, and subagent .meta.json files when a run uses the Agent tool). The cwd is always
// a fresh temp dir this script made, so that project folder only ever holds this run: remove it,
// so a later `loadout build` never mines these runs.
function forgetProject(cwd) {
  if (!realpathSync(cwd).startsWith(realpathSync(tmp))) return;
  rmSync(join(homedir(), '.claude', 'projects', realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
}

function setup(task, arm, rep) {
  const dir = mkdtempSync(join(tmp, `${task.id}-${arm}-${rep}-`));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  cpSync(join(fx, 'toy'), repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=ab', '-c', 'user.email=ab@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'start');
  execFileSync('mkdir', ['-p', home]);
  if (arm === 'loaded') {
    execFileSync('node', [cli, 'use', pack], { env: env(home), stdio: 'ignore' });
    // Nobody is there to answer an offer under -p: the loaded arm follows the playbook without asking.
    execFileSync('node', [cli, 'suggest', 'auto'], { env: env(home), stdio: 'ignore' });
  }
  const status = execFileSync('node', [cli, 'status'], { env: env(home), encoding: 'utf8' }).trim();
  return { dir, repo, home, status };
}

function claude(prompt, cwd, home, logBase) {
  const args = [
    '-p', prompt,
    '--plugin-dir', root,
    '--model', model,
    '--max-turns', maxTurns,
    '--max-budget-usd', budget,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ...ALLOWED,
    '--disallowedTools', ...DISALLOWED,
    '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(claudeBin, args, { cwd, env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(killer);
      forgetProject(cwd);
      writeFileSync(`${logBase}.ndjson`, stdout);
      writeFileSync(`${logBase}.stderr`, stderr);
      const events = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
      done({ code, ms: Date.now() - started, events, stderr });
    });
  });
}

const TEST_CMD = /\bnode\s+(--test|test\/)|\bnpm\s+(run\s+)?test\b/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function measure(run, repo, task) {
  const tools = [];
  const texts = [];
  const errors = new Map();
  for (const e of run.events) {
    for (const b of e.message?.content ?? []) {
      if (e.type === 'assistant' && b.type === 'tool_use') tools.push({ id: b.id, name: b.name, input: b.input ?? {} });
      if (e.type === 'assistant' && b.type === 'text' && b.text?.trim()) texts.push(b.text.trim());
      if (e.type === 'user' && b.type === 'tool_result' && b.is_error) errors.set(b.tool_use_id, String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 200));
    }
  }
  const result = run.events.findLast((e) => e.type === 'result') ?? {};
  const hookText = (name) => run.events.filter((e) => e.type === 'system' && /hook/.test(e.subtype ?? '') && JSON.stringify(e).includes(name)).map((e) => [e.output, e.stdout].filter(Boolean).join('')).join('');
  const deniedIds = new Set((result.permission_denials ?? []).map((d) => d.tool_use_id));
  const denied = tools.filter((t) => deniedIds.has(t.id) || (errors.has(t.id) && /requires approval|permission/i.test(errors.get(t.id))));
  const isDenied = new Set(denied.map((t) => t.id));
  const isTest = (t) => t.name === 'Bash' && TEST_CMD.test(t.input.command ?? '');
  const testIdx = tools.map((t, i) => (isTest(t) && !isDenied.has(t.id) ? i : -1)).filter((i) => i >= 0);
  const editIdx = tools.map((t, i) => (EDIT_TOOLS.has(t.name) ? i : -1)).filter((i) => i >= 0);

  // Diff, including new files, against the starting commit.
  sh('git', ['add', '-A', '-N'], repo);
  const numstat = sh('git', ['diff', '--numstat'], repo).stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [a, d, file] = l.split('\t');
    return { file, added: Number(a) || 0, deleted: Number(d) || 0 };
  });
  const testsAfter = sh('node', ['--test'], repo);
  copyFileSync(join(fx, task.hidden), join(repo, '.ab-hidden.test.mjs'));
  const hidden = sh('node', ['--test', '.ab-hidden.test.mjs'], repo);

  const allText = texts.join('\n\n');
  const final = String(result.result ?? texts.at(-1) ?? '');
  return {
    exit: run.code,
    stopReason: result.subtype ?? 'none',
    otherHooks: [...new Set(run.events.filter((e) => e.type === 'system' && e.hook_event && !['SessionStart', 'UserPromptSubmit'].includes(e.hook_event)).map((e) => e.hook_event))],
    hookSessionStart: /Maya's loadout/.test(hookText('SessionStart')),
    hookPlaybook: (hookText('UserPromptSubmit').match(/matches the playbook \\?"([^"\\]+)/) ?? [])[1] ?? null,
    triedTests: tools.some(isTest),
    ranTests: testIdx.length > 0,
    testedAfterLastEdit: editIdx.length > 0 && testIdx.length > 0 && Math.max(...testIdx) > Math.max(...editIdx),
    testsPass: testsAfter.status === 0,
    hiddenPass: hidden.status === 0,
    changedTest: numstat.some((f) => /(^|\/)test\/|\.test\./.test(f.file)),
    changedCode: numstat.some((f) => f.file.startsWith('src/')),
    filesChanged: numstat.map((f) => f.file),
    linesChanged: numstat.reduce((s, f) => s + f.added + f.deleted, 0),
    endedWithQuestion: /\?\s*(\*\*)?\s*$/m.test(final.split('\n').slice(-6).join('\n')) && /\b(should|would you|do you want|which|prefer|confirm|before i)\b/i.test(final),
    restatedDone: /\b(done when|done means|definition of done|success (looks like|criteria)|acceptance criteria|expected (total|result|behavio)|should (now )?(be|equal|return))\b/i.test(allText),
    saidFollowing: /following maya'?s loadout/i.test(allText),
    toolCalls: tools.length,
    toolNames: Object.fromEntries([...new Set(tools.map((t) => t.name))].map((n) => [n, tools.filter((t) => t.name === n).length])),
    denied: denied.map((t) => (t.name === 'Bash' ? `Bash(${String(t.input.command).slice(0, 40)})` : t.name === 'Skill' ? `Skill(${t.input.skill ?? t.input.command ?? '?'})` : t.name)),
    turns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? run.ms,
    costUsd: result.total_cost_usd ?? 0,
    final: final.slice(0, 1500),
  };
}

const plan = [];
for (let rep = 1; rep <= reps; rep++) for (const task of tasks) for (const arm of arms) plan.push({ task, arm, rep });
console.log(`${plan.length} runs on ${model}, max ${maxTurns} turns, $${budget} cap each, ${jobs} at once. Temp: ${tmp}`);
if (dry) {
  for (const p of plan) console.log(`  ${p.task.id} ${p.arm} #${p.rep}: ${p.task.prompt}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

const rows = [];
let next = 0;
async function worker() {
  while (next < plan.length) {
    const { task, arm, rep } = plan[next++];
    const s = setup(task, arm, rep);
    const run = await claude(task.prompt, s.repo, s.home, join(s.dir, 'run'));
    const m = { task: task.id, arm, rep, loadoutStatus: s.status, ...measure(run, s.repo, task) };
    rows.push(m);
    console.log(`${task.id.padEnd(8)} ${arm.padEnd(6)} #${rep}  exit ${m.exit} ${m.stopReason}, ${m.turns} turns, ${m.toolCalls} tools, ${m.linesChanged} lines, tests ${m.testsPass ? 'pass' : 'FAIL'}, hidden ${m.hiddenPass ? 'pass' : 'FAIL'}, $${m.costUsd.toFixed(3)}${m.denied.length ? `, denied ${m.denied.join(' ')}` : ''}${m.otherHooks.length ? `, OTHER HOOKS ${m.otherHooks.join(' ')}` : ''}`);
    if (!process.env.AB_KEEP) rmSync(s.dir, { recursive: true, force: true });
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, plan.length) }, worker));

rows.sort((a, b) => a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm) || a.rep - b.rep);
writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), model, packHash, maxTurns: Number(maxTurns), allowed: ALLOWED, rows }, null, 2)}\n`);

// Per task and arm: how many runs did each thing, plus mean turns/tools/lines/seconds and total cost.
const yes = (rs, k) => `${rs.filter((r) => r[k]).length}/${rs.length}`;
const mean = (rs, k) => (rs.reduce((s, r) => s + (r[k] ?? 0), 0) / rs.length);
console.log('\n| task | arm | tried tests | ran tests | tested after last edit | tests pass | hidden check | changed a test | asked / stopped | restated done | "following Maya" | lines | tools | turns | sec | cost |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const t of [...tasks.map((x) => x.id), 'all']) {
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm && (t === 'all' || r.task === t));
    if (!rs.length) continue;
    console.log(`| ${t} | ${arm} | ${yes(rs, 'triedTests')} | ${yes(rs, 'ranTests')} | ${yes(rs, 'testedAfterLastEdit')} | ${yes(rs, 'testsPass')} | ${yes(rs, 'hiddenPass')} | ${yes(rs, 'changedTest')} | ${yes(rs, 'endedWithQuestion')} | ${yes(rs, 'restatedDone')} | ${yes(rs, 'saidFollowing')} | ${mean(rs, 'linesChanged').toFixed(0)} | ${mean(rs, 'toolCalls').toFixed(1)} | ${mean(rs, 'turns').toFixed(1)} | ${(mean(rs, 'durationMs') / 1000).toFixed(0)} | $${rs.reduce((s, r) => s + r.costUsd, 0).toFixed(2)} |`);
  }
}
console.log(`\nTotal cost $${rows.reduce((s, r) => s + r.costUsd, 0).toFixed(2)}. Results: ${out}`);
if (!process.env.AB_KEEP) rmSync(tmp, { recursive: true, force: true });
