#!/usr/bin/env node
// Manual live test: runs the plugin inside real Claude Code (costs a few cheap model calls).
// Not part of `npm run check`. Run by hand:
//
//   node scripts/live-test.mjs                 all steps (7 claude runs)
//   node scripts/live-test.mjs fresh session   only the named steps
//
// Every run gets a temp LOADOUT_HOME and a temp cwd, loads the plugin with --plugin-dir,
// skips user settings (so the owner's own plugins and hooks stay out) and writes no session.
// Env: LIVE_MODEL (default haiku), LIVE_KEEP=1 keeps the temp dirs, raw logs go to <tmp>/logs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { playbookFor } from '../src/pack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'loadout.mjs');
const fixture = join(root, 'fixtures', 'loadout-example.json');
const model = process.env.LIVE_MODEL || 'haiku';
const tmp = mkdtempSync(join(tmpdir(), 'loadout-live-'));
const logs = join(tmp, 'logs');
mkdirSync(logs);
let runs = 0;

function loadoutCli(home, ...args) {
  return execFileSync('node', [cli, ...args], { env: { ...process.env, LOADOUT_HOME: home }, encoding: 'utf8' });
}

// A LOADOUT_HOME with the fixture published and turned on through the CLI. With `second`,
// a copy under the handle "lee" is installed too (it only shows up in `loadout list`).
function activeHome({ second = false } = {}) {
  const home = mkdtempSync(join(tmp, 'home-'));
  const out = mkdtempSync(join(tmp, 'out-'));
  mkdirSync(join(home, 'drafts'));
  copyFileSync(fixture, join(home, 'drafts', 'maya.json'));
  loadoutCli(home, 'publish', '--handle', 'maya', '--out', out);
  if (second) {
    writeFileSync(join(out, 'lee.json'), JSON.stringify({ ...JSON.parse(readFileSync(fixture, 'utf8')), handle: 'lee', displayName: 'Lee' }));
    loadoutCli(home, 'use', join(out, 'lee.json'));
  }
  loadoutCli(home, 'use', join(out, 'maya.loadout'));
  return home;
}

// Claude Code creates ~/.claude/projects/<cwd>/memory/ even with --no-session-persistence.
// Remove it again when it is empty, so the owner's next `loadout build` never sees these runs.
function forgetProject(cwd) {
  const dir = join(homedir(), '.claude', 'projects', realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  try {
    if (readdirSync(dir, { recursive: true, withFileTypes: true }).every((e) => e.isDirectory())) rmSync(dir, { recursive: true });
  } catch {}
}

// "SessionStart 67ms" lines for the loadout plugin's own hooks, from the debug log.
function hookTimes(debugLog) {
  try {
    return [...readFileSync(debugLog, 'utf8').matchAll(/Hooks: (\w+)[^\n]*\(plugin loadout@inline\) finished with status (\d+) \((\d+)ms\)/g)]
      .map((m) => `${m[1]} exit ${m[2]} ${m[3]}ms`).join(', ');
  } catch {
    return '?';
  }
}

function claude(name, prompt, home, extra = []) {
  runs++;
  const cwd = mkdtempSync(join(tmp, 'cwd-'));
  const args = [
    '-p', prompt,
    '--plugin-dir', root,
    '--model', model,
    '--max-turns', '3',
    '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--debug-file', join(logs, `${name}.debug.log`),
    ...extra,
  ];
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn('claude', args, { cwd, env: { ...process.env, LOADOUT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      forgetProject(cwd);
      writeFileSync(join(logs, `${name}.ndjson`), stdout);
      writeFileSync(join(logs, `${name}.stderr`), stderr);
      const events = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      const result = events.findLast((e) => e.type === 'result') ?? {};
      done({ name, code, ms: Date.now() - started, stderr, events, text: String(result.result ?? ''), result, hooks: hookTimes(join(logs, `${name}.debug.log`)) });
    });
  });
}

// Hook lifecycle events for one hook event name (SessionStart, UserPromptSubmit).
const hookEvents = (run, event) => run.events.filter((e) => e.type === 'system' && /hook/.test(e.subtype ?? '') && JSON.stringify(e).includes(event));
const hookOutput = (run, event) => hookEvents(run, event).map((e) => [e.output, e.stdout, e.stderr].filter(Boolean).join('\n')).join('\n');
const loadoutHookErrors = (run) => run.events.filter((e) => e.type === 'system' && /hook/.test(e.subtype ?? '') && /loadout/.test(JSON.stringify(e)) && ((e.exit_code != null && e.exit_code !== 0) || e.outcome === 'error'));
// A skill's ! line that failed its permission check (stream-json does not carry the expanded skill text).
const deniedShell = (run) => {
  try {
    return readFileSync(join(logs, `${run.name}.debug.log`), 'utf8').match(/Shell command permission check failed[^\n]*/g) ?? [];
  } catch {
    return [];
  }
};

const results = [];
function check(step, label, ok, evidence = '') {
  results.push({ step, label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${label}${evidence ? `\n      ${String(evidence).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
}
const has = (s, ...needles) => needles.every((n) => s.toLowerCase().includes(n.toLowerCase()));
const summary = (step, run) => console.log(`      (${step}: exit ${run.code}, ${(run.ms / 1000).toFixed(1)}s, cost $${run.result.total_cost_usd?.toFixed?.(4) ?? '?'}, stderr ${run.stderr.trim() ? JSON.stringify(run.stderr.trim().slice(0, 200)) : 'empty'}, loadout hooks: ${run.hooks || 'none'})`);

const STEPS = {
  async fresh() {
    const home = mkdtempSync(join(tmp, 'home-'));
    const run = await claude('fresh', 'Reply with just the word OK.', home);
    summary('fresh', run);
    check('5', 'no active loadout: run succeeds', run.code === 0 && has(run.text, 'ok'), run.text);
    check('5', 'no active loadout: hooks inject nothing', !/loadout/i.test(hookOutput(run, 'SessionStart') + hookOutput(run, 'UserPromptSubmit')), hookOutput(run, 'SessionStart') || '(empty)');
    check('5', 'no active loadout: no hook errors, stderr empty', loadoutHookErrors(run).length === 0 && !run.stderr.trim());
  },

  async session() {
    const home = activeHome();
    const run = await claude('session', 'Do not use any tools. Whose loadout is in your context, and what are its playbook names? Answer in one line.', home);
    summary('session', run);
    check('2', 'SessionStart hook output carries LOADOUT.md', has(hookOutput(run, 'SessionStart'), "Maya's loadout", 'Playbooks'), hookOutput(run, 'SessionStart').slice(0, 160));
    check('2', 'Claude names the owner and the playbooks', has(run.text, 'maya', 'build a feature', 'fix a bug', 'review'), run.text);
  },

  async match() {
    const home = activeHome();
    const prompt = 'Do not do this task and do not use any tools. Task: fix the broken login bug. Which playbook was offered to you for this prompt, and what is its first step? One line.';
    if (playbookFor(JSON.parse(readFileSync(fixture, 'utf8')), prompt)?.id !== 'bug') throw new Error('match prompt no longer selects the bug playbook offline');
    const run = await claude('match', prompt, home);
    summary('match', run);
    check('3', 'UserPromptSubmit hook offers "Fix a bug"', has(hookOutput(run, 'UserPromptSubmit'), 'playbook for this prompt, offered', 'Fix a bug'), hookOutput(run, 'UserPromptSubmit').slice(0, 160));
    check('3', 'UserPromptSubmit hook returns the "loadout: Fix a bug" cue', has(hookOutput(run, 'UserPromptSubmit'), 'loadout: Fix a bug'), hookOutput(run, 'UserPromptSubmit').slice(0, 160));
    check('3', 'Claude quotes the playbook and its first step', has(run.text, 'fix a bug') && /diagnos|reproduce/i.test(run.text), run.text);
  },

  async nomatch() {
    const home = activeHome();
    const prompt = 'Do not use any tools. What is 2+2? Then say whether a playbook was injected for this specific prompt (not at session start). One line.';
    if (playbookFor(JSON.parse(readFileSync(fixture, 'utf8')), prompt)) throw new Error('nomatch prompt matches a playbook offline');
    const run = await claude('nomatch', prompt, home);
    summary('nomatch', run);
    check('3', 'non-matching prompt: UserPromptSubmit injects nothing', !has(hookOutput(run, 'UserPromptSubmit'), 'playbook for this prompt'), hookOutput(run, 'UserPromptSubmit') || '(empty)');
    check('3', 'non-matching prompt: Claude answers normally', run.code === 0 && run.text.includes('4'), run.text);
  },

  async status() {
    const home = activeHome({ second: true });
    const run = await claude('status', '/loadout:status', home);
    summary('status', run);
    check('4', '/loadout:status: ! lines passed the permission check', deniedShell(run).length === 0, deniedShell(run).join(' | '));
    check('4', '/loadout:status: Claude reports maya on and lee installed (lee only comes from `loadout list`)', has(run.text, 'maya', 'lee'), run.text);
  },

  async off() {
    const home = activeHome();
    const run = await claude('off', '/loadout:off', home);
    summary('off', run);
    check('4', '/loadout:off: active.json removed', !existsSync(join(home, 'active.json')), deniedShell(run).join(' | '));
    check('4', '/loadout:off: Claude reports it stopped', /stop|off|turned/i.test(run.text), run.text);
  },

  async use() {
    const home = activeHome();
    loadoutCli(home, 'off');
    // The fixture's kit names invented plugins and a bundled skill, so `use` always prints what's missing.
    const bundled = join(homedir(), '.claude', 'skills', 'small-diffs');
    const hadBundled = existsSync(bundled);
    const run = await claude('use', '/loadout:use maya', home);
    summary('use', run);
    check('4', '/loadout:use maya: active.json is back', existsSync(join(home, 'active.json')), deniedShell(run).join(' | '));
    // The skill's second ! line (status --md) must see the loadout the first one just turned on.
    check('4', '/loadout:use maya: Claude reports it loaded', has(run.text, 'maya') && !/didn.t load|isn.t on|is not on|no loadout/i.test(run.text), run.text);
    check('4', '/loadout:use maya: Claude passes on the missing kit', /craft-skills|\/plugin (marketplace|install)/i.test(run.text), run.text);
    check('4', '/loadout:use maya: no bundled skill installed without asking', hadBundled || !existsSync(bundled));
  },
};

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(STEPS)) {
  if (!STEPS[name]) throw new Error(`unknown step ${name}; steps: ${Object.keys(STEPS).join(', ')}`);
  console.log(`\n== ${name}`);
  await STEPS[name]();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, ${runs} claude runs. Logs: ${logs}`);
if (!process.env.LIVE_KEEP && !failed.length) rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
