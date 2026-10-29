// Local recall index: one line per task from the owner's own Claude Code sessions, in
// $LOADOUT_HOME/recall/index.jsonl. Text stays as written (it never leaves this machine) except secrets, which
// never enter it. Incremental: only session files whose size or mtime changed since state.json are re-read.
import { readFileSync, readdirSync, renameSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readSession } from '../sessions.mjs';
import { ruleClauses, turnsOf } from '../mine.mjs';
import { redactSecrets } from '../redact.mjs';
import { loadoutHome } from '../pack.mjs';
import { stem } from './query.mjs';

const ASK_MAX = 300, OUTCOME_MAX = 200, CORRECTION_MAX = 120, DECISION_MAX = 160;
// Bumped when tasks are cut or described differently, so the next build redoes every session.
const BUILD = 2;
const MAX_CORRECTIONS = 3, MAX_DECISIONS = 3, MAX_FILES = 8, MAX_TERMS = 60;
const STOP = new Set(('the and for with this that from into onto then than them they their there here what when where which who why how ' +
  'are was were been being has have had does did done can could should would will just also only very really please thanks okay ' +
  'yes not but all any some more most other such its it\'s our your you we me my out off over under again now let lets let\'s ' +
  'make sure want need like get got use using see look one two new old way thing things stuff about after before still even ' +
  'add don doesn didn won isn mjs js ts tsx jsx json md src lib index').split(' '));
// "let's go with X", "go with X", "use X instead of Y", "stick with X": the owner settling a choice.
const DECIDE = /^(?:(?:ok(?:ay)?|yes|yeah|no|right|fine|great|good)[,\s]+)*(?:(?:let'?s|lets|we'?ll|i'?ll|we should|i want to)\s+(?:go with|use|keep|stick with|pick|choose|do)\b|(?:go|going) with\b|stick with\b|(?:use|keep|pick|choose|prefer)\b.+\b(?:instead of|rather than|not|over)\b)/i;

export const recallDir = (home = loadoutHome()) => join(home, 'recall');
const indexPath = (home) => join(recallDir(home), 'index.jsonl');
const statePath = (home) => join(recallDir(home), 'state.json');
const defaultClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Every task in the index, oldest session first; [] when there is none.
export function readIndex(home = loadoutHome()) {
  let text;
  try {
    text = readFileSync(indexPath(home), 'utf8');
  } catch {
    return [];
  }
  const tasks = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const t = JSON.parse(line);
      if (t?.v === 1 && typeof t.id === 'string') tasks.push(t);
    } catch {}
  }
  return tasks;
}

export async function buildIndex({ home = loadoutHome(), claudeDir = defaultClaudeDir(), since = '90d', full = false } = {}) {
  const t0 = performance.now();
  const sinceMs = sinceTime(since);
  const incognito = readIncognito(home);
  const old = full ? { files: {} } : readState(home);
  const files = {};
  const changed = [];
  const projects = join(claudeDir, 'projects');
  for (const proj of list(projects)) {
    for (const file of list(join(projects, proj))) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(projects, proj, file);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs || incognito.has(basename(file, '.jsonl'))) continue;
      const prev = old.files[path];
      files[path] = { mtimeMs: st.mtimeMs, size: st.size, tasks: prev?.tasks ?? 0 };
      if (!prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) changed.push(path);
    }
  }
  const gone = Object.keys(old.files).filter((p) => !files[p]);
  if (!full && !changed.length && !gone.length) {
    const tasks = Object.values(files).reduce((n, f) => n + f.tasks, 0);
    return { tasks, sessions: Object.keys(files).length, ms: Math.round(performance.now() - t0) };
  }

  // Tasks of unchanged files stay as they are; changed files are re-read; anything else (gone, too old, incognito) goes.
  const redo = new Set(changed);
  const same = new Set(Object.keys(files).filter((p) => !redo.has(p)).map((p) => basename(p, '.jsonl')));
  const keep = full ? [] : readIndex(home).filter((t) => same.has(t.session));
  const fresh = [];
  for (const path of changed) {
    let session = null;
    try {
      session = await readSession(path, { detail: true });
    } catch (err) {
      console.error(`loadout: skipped a session file (${err.message})`);
    }
    const tasks = session ? tasksOf(session) : [];
    files[path].tasks = tasks.length;
    fresh.push(...tasks);
  }
  const tasks = [...keep, ...fresh].sort((a, b) => cmp(a.at, b.at) || cmp(a.id, b.id));
  mkdirSync(recallDir(home), { recursive: true });
  writeAtomic(indexPath(home), tasks.map((t) => `${JSON.stringify(t)}\n`).join(''));
  writeAtomic(statePath(home), `${JSON.stringify({ v: 1, build: BUILD, files, at: new Date().toISOString() })}\n`);
  return { tasks: tasks.length, sessions: Object.keys(files).length, ms: Math.round(performance.now() - t0) };
}

// Drop these sessions' tasks now (incognito), without waiting for the next build.
export function purgeSessions(ids, home = loadoutHome()) {
  const drop = new Set(ids);
  const tasks = readIndex(home);
  const kept = tasks.filter((t) => !drop.has(t.session));
  if (kept.length === tasks.length) return 0;
  writeAtomic(indexPath(home), kept.map((t) => `${JSON.stringify(t)}\n`).join(''));
  return tasks.length - kept.length;
}

// A task opens on an informative prompt that comes after a long idle gap (not mid-task) or that is a clear new
// request: an imperative opener, enough content words, and little overlap with the task running so far. A filler
// prompt ("continue", "ok", a lone link) never opens one; it carries on the task in hand. Main thread and
// subagents both count.
export function tasksOf(session) {
  const groups = [];
  for (const turn of turnsOf(session)) {
    const p = turn.prompt;
    const cur = groups[groups.length - 1];
    const words = content(p.text);
    const opens = !cur || (informative(p.text) && (!p.midTask || newRequest(p.text, words, cur.seen)));
    if (opens) groups.push({ turns: [], seen: new Set() });
    const g = groups[groups.length - 1];
    g.turns.push(turn);
    for (const w of words) g.seen.add(stem(w));
  }
  const out = [];
  for (const { turns } of groups) {
    const opener = turns.find((t) => informative(t.prompt.text));
    if (!opener) continue;
    const ask = line(askText(opener.prompt.text), ASK_MAX);
    const events = turns.flatMap((t) => t.events);
    const decisions = uniq([
      ...events.filter((e) => e.kind === 'answer').map(answerText),
      ...turns.flatMap((t) => decided(t.prompt.text)),
    ].map((d) => d && line(d, DECISION_MAX))).slice(0, MAX_DECISIONS);
    // A file in a Claude Code worktree is the repo's own file: drop the .claude/worktrees/<name>/ part.
    const files = uniq(events.filter((e) => e.kind === 'file').map((e) => redactSecrets(e.path.replace(/(^|\/)\.claude\/worktrees\/[^/]+\//, '$1')))).slice(0, MAX_FILES);
    const others = turns.filter((t) => t !== opener && !t.prompt.hadPaste && informative(t.prompt.text)).map((t) => redactSecrets(t.prompt.text));
    out.push({
      v: 1,
      id: `${session.id}:${out.length}`,
      session: session.id,
      at: opener.prompt.at,
      repo: session.cwdName ?? null,
      branch: opener.prompt.branch ?? null,
      ask,
      steps: uniq(turns.flatMap((t) => t.steps.map((s) => s.key)).filter((k) => /^(?:skill|agent|mcp):/.test(k)).map((k) => k.replace(/^skill:/, ''))),
      corrections: uniq(turns.filter((t) => t !== turns[0] && t.prompt.midTask && !t.prompt.hadPaste)
        .flatMap((t) => ruleClauses(t.prompt.text, { forced: t.prompt.afterInterrupt }).map((r) => line(r.text, CORRECTION_MAX)))).slice(0, MAX_CORRECTIONS),
      decisions,
      checks: uniq(events.filter((e) => e.kind === 'check').map((e) => e.how)),
      outcome: outcomeOf(events),
      files,
      // The ask's terms first, then decisions and files, then the rest of the task's prompts, up to the cap.
      terms: terms([ask, ...decisions, ...files, ...others].join('\n')),
    });
  }
  return out;
}

// Prompts that carry no request on their own.
const FILLER = /^(?:continue|go on|keep going|carry on|clear|ok(?:ay)?|k|y|v|yes|yeah|yep|no|nope|sure|thanks|thank you|nice|cool|great|good|perfect|done|next|again|so|hi|hello|hey|yo|wait|go|do it|proceed|im back|b)\b[\s.!?]*$/i;
const LINK = /^(?:https?:\/\/\S+|[~.]?\/\S+|@\S+)\s*/;
// Leading links and paths say where, not what: "/a/b/notes.md read this" asks "read this".
const askText = (text) => { let s = String(text || '').trim(); while (LINK.test(s)) s = s.replace(LINK, ''); return s || String(text || '').trim(); };
const content = (text) => (redactSecrets(askText(text)).replace(/‹\w+›/g, ' ').toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
// Starts with a letter (not pasted output or a path alone), isn't filler, and names at least three things.
const informative = (text) => { const s = askText(text); return /^["'(]?[a-z]/i.test(s) && !FILLER.test(s) && content(s).length >= 3; };
// "add …", "can you build …", "so let's set up …", "I want you to write …": a request near the start, not a reply.
const ASKING = /\b(?:(?:can|could|would|will) (?:you|we)|i (?:want|need|would like)|i wanna|let'?s|lets|please)\b/;
const VERBS = new Set(('add build make create write rewrite implement fix refactor check review research design redo redesign set setup ' +
  'deploy remove delete rename move explain show generate prepare clone investigate update change test run start draft plan find ' +
  'compare migrate port install upgrade wire integrate ship publish record split merge replace convert clean look think help try ' +
  'give tell list read summarize mock sketch spawn audit debug analyze document improve optimize simplify').split(' '));
function newRequest(text, words, seen) {
  const head = askText(text).toLowerCase().split(/\s+/).slice(0, 8);
  if (words.length < 6 || !(ASKING.test(head.join(' ')) || head.slice(0, 6).some((w) => VERBS.has(w.replace(/[^a-z]/g, ''))))) return false;
  const stems = [...new Set(words.map(stem))];
  return stems.filter((w) => seen.has(w)).length / stems.length < 0.25;
}

// "Which store should hold the export, and why?" → "Server-side (Recommended)": the question's first clause, the
// label without the boilerplate, and any notes, each short.
function answerText(e) {
  const question = short(String(e.question).split(/(?<=\?)|[,;:—–]\s|\s[-–—(]|\.\s/)[0].replace(/\?$/, ''), 60);
  const answer = short(String(e.answer).replace(/\s*\((?:recommended|default|suggested)\)\s*/gi, ' '), 60);
  if (!answer) return null;
  return `${question} → ${answer}${e.notes ? ` (${short(e.notes, 60)})` : ''}`;
}
const short = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// The last thing the assistant said that reports a result; failing that, the last real reply. Errors and
// interruptions are not outcomes.
const NOT_OUTCOME = /^(?:API Error|Error:|\[Request interrupted|Request interrupted|No response requested|Prompt is too long|Credit balance|.*\b(?:rate limit|overloaded_error)\b)/i;
const REPORTS = /\b(?:done|added|fixed|pushed|merged|pass(?:es|ed|ing)?|wrote|written|created|updated|removed|renamed|implemented|built|shipped|committed|deployed|published|works|working now|ready|finished|landed|opened)\b/i;
function outcomeOf(events) {
  const said = events.filter((e) => e.kind === 'say' && e.text && !NOT_OUTCOME.test(e.text.trim()));
  const best = said.filter((e) => REPORTS.test(e.text)).pop() ?? said.pop();
  return best ? line(best.text, OUTCOME_MAX) || null : null;
}

// Sentences of a prompt that settle a choice.
function decided(text) {
  return String(text || '').split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter((s) => s.length <= DECISION_MAX * 2 && DECIDE.test(s))
    .map((s) => s.replace(/^(?:(?:ok(?:ay)?|yes|yeah|no|right|fine|great|good)[,\s]+)+/i, '').replace(/[.!]+$/, ''))
    .filter((s) => content(s).length >= 2); // "let's do it" settles nothing
}

// Search terms: lowercased words, one per stem (the query side stems them its own way), in order of weight.
export function terms(text) {
  const out = new Map();
  for (const w of String(text).replace(/‹\w+›|\b[a-z][\w+.-]*:\/\/\S+/gi, ' ').toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    if (!out.has(stem(w))) out.set(stem(w), w);
    if (out.size >= MAX_TERMS) break;
  }
  return [...out.values()];
}

// One line, secrets out, cut to max characters.
function line(text, max) {
  const s = redactSecrets(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function sinceTime(since) {
  if (since == null) return 0;
  const m = /^(\d+)d$/.exec(String(since));
  if (m) return Date.now() - Number(m[1]) * 86_400_000;
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) throw new Error(`--since takes days, like 90d (got "${since}")`);
  return t;
}

function readState(home) {
  try {
    const s = JSON.parse(readFileSync(statePath(home), 'utf8'));
    return s?.v === 1 && s.build === BUILD && s.files && typeof s.files === 'object' ? s : { files: {} };
  } catch {
    return { files: {} };
  }
}

function readIncognito(home) {
  try {
    const s = JSON.parse(readFileSync(join(home, 'incognito.json'), 'utf8')).sessions;
    return new Set(Array.isArray(s) ? s.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function list(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
