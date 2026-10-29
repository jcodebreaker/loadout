// Local recall, the query side: which of the owner's past tasks (recall/index.jsonl, built by index.mjs) a
// prompt touches, and the short note the prompt hook sends about them. Pure functions except the small readers
// and the per-session state. Better silent than noise: a prompt has to clearly be about the same work.
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadoutHome, saveSessionState, sessionState } from '../pack.mjs';

export const MAX_RECALL_MD = 1200;

// Words that say nothing about which work a prompt is about: function words, chat, generic coding verbs, and the
// way people ask about the past ("what did I decide about", "last time").
const STOP = new Set(`a an the to of for in on and or with is are was were be been it its this that these those as at by
from not no when while we i me my you your our us do does did done into after before then than too also only use using
used one per if so but all any some can could would should will just please let lets s t don doesn isn won what whats
how why where which who there here get got make made need needs want wants like look new way ways thing things
add added adding fix fixed fixing update change changes set up work works working run running try see check
code file files src lib ts js mjs tsx jsx md json index test tests
decide decided decision decisions remember last time times before again previously earlier ago ever
yes ok okay thanks thank sure great good bug bugs issue error broken wrong between two both even every nothing something
push pushed commit branch merge repo pr
have has had having am being really freaking fucking bit little kind kinda think thought dont don't them they their well know
give happen happening meanwhile finish finished about talk talking doing right now current currently basically actually literally maybe`.split(/\s+/));
const CHAT = new Set(['yes', 'yeah', 'yep', 'no', 'nope', 'ok', 'okay', 'k', 'thanks', 'thank', 'thx', 'sure', 'great', 'perfect', 'cool', 'nice', 'lgtm', 'good', 'awesome', 'hi', 'hello', 'hey', 'morning', 'sounds', 'looks']);
// Words that point back at what this session is already doing ("fix it", "same for invoices").
const BACK = new Set(['it', 'that', 'this', 'them', 'those', 'these', 'same', 'too', 'also']);
// ...and phrases that point at earlier sessions, which make a short prompt worth a look.
const PAST = /\b(last time|before|again|previously|earlier|did i|have i|had i|i did|we did)\b/;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const words = (text) => String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];

// A light stemmer, the same on both sides: exports, exporting, exported -> export; caching, cache -> cach.
export function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

const terms = (text) => {
  const out = new Set();
  // A link says where, not what: its host and path words would match any other link.
  for (const w of words(String(text ?? '').replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' '))) {
    if (w.length < 2 || STOP.has(w) || /^\d$/.test(w)) continue;
    const s = stem(w);
    if (!STOP.has(s)) out.add(s);
  }
  return [...out];
};

// Prompts the hook never recalls for: slash commands, chat, short ones, and follow-ups that point back at the
// work in hand ("now fix it", "also add a test for that edge case").
export function quiet(prompt) {
  const text = oneLine(prompt).toLowerCase();
  if (!text || text.startsWith('/')) return true;
  if (CHAT.has(words(text)[0])) return true;
  const n = terms(text).length;
  const past = PAST.test(text);
  if (!past && n < 5 && words(text).some((w) => BACK.has(w))) return true;
  return n < (past ? 2 : 3);
}

// Past tasks that `prompt` is about, best first, as { task, score, why }. A task must share two distinctive
// terms with the prompt and cover half of the prompt (by term weight) or 60% of its own ask, and score at least
// half the best hit's. Same repo and branch, and recency, only reorder what passed. `exclude` takes task ids and
// session ids (the current session's own tasks never come back). `loose` is for asking on purpose: one shared
// term is enough, no quiet rules, and retries of a task each show. `counts` ({ n, df }) weighs terms over the
// whole index when `tasks` is only the candidates readCandidates found.
export function recallFor(prompt, tasks, { repo = null, branch = null, now = Date.now(), exclude = [], limit = 2, loose = false, counts = null } = {}) {
  if (!loose && quiet(prompt)) return [];
  const q = terms(prompt);
  if (!q.length || !Array.isArray(tasks) || !tasks.length) return [];
  const skip = new Set(exclude);
  const df = new Map(q.map((t) => [t, counts?.df.get(t) ?? 0]));
  const docs = [];
  for (const task of tasks) {
    if (typeof task?.ask !== 'string' || skip.has(task.id) || skip.has(task.session)) continue;
    const ask = terms(task.ask);
    const all = new Set([...ask, ...terms(`${(task.terms ?? []).join(' ')} ${(task.decisions ?? []).join(' ')}`)]);
    const matched = q.filter((t) => all.has(t));
    if (!counts) for (const t of matched) df.set(t, df.get(t) + 1);
    if (matched.length) docs.push({ task, ask, matched });
  }
  const n = Math.max(counts?.n ?? 0, tasks.length);
  const idf = (t) => Math.log(1 + Math.max(0, n - df.get(t) + 0.5) / (df.get(t) + 0.5));
  const qWeight = q.reduce((s, t) => s + idf(t), 0);
  const hits = [];
  for (const { task, ask, matched } of docs) {
    const sameRepo = inRepo(task, repo);
    const inAsk = matched.filter((t) => ask.includes(t));
    if (!loose && (matched.length < 2 || !inAsk.length)) continue;
    // Terms only from the task's later prompts count less: the ask says what the task was.
    const weight = matched.reduce((s, t) => s + idf(t) * (ask.includes(t) ? 1 : 0.7), 0);
    const own = ask.length ? inAsk.length / ask.length : 0;
    const cover = Math.max(weight / qWeight, own);
    const floor = sameRepo || !repo ? 0.5 : 0.55;
    if (!loose && weight / qWeight < floor && own < floor + 0.1) continue;
    const days = Math.max(0, (now - Date.parse(task.at)) / 86_400_000) || 0;
    const boost = (sameRepo ? 1.5 : 1) * (sameRepo && branch && task.branch === branch ? 1.1 : 1) * (1 + 0.25 * Math.exp(-days / 45));
    hits.push({ task, ask, score: weight * cover * boost, why: [`shares ${matched.join(', ')}`, sameRepo && 'same repo'].filter(Boolean).join('; ') });
  }
  hits.sort((a, b) => b.score - a.score || String(b.task.at).localeCompare(String(a.task.at)));
  // Near-identical asks (a task retried in a new session) count once in the hook: the better one.
  const kept = [];
  for (const h of hits) {
    if (!loose && h.score < hits[0].score / 2) break;
    if (!loose && kept.some((k) => similar(k.ask, h.ask))) continue;
    kept.push(h);
    if (kept.length >= limit) break;
  }
  return kept.map(({ task, score, why }) => ({ task, score: Math.round(score * 100) / 100, why }));
}

// Sessions often run from a parent folder and work in a repo below it, so a task is in `repo` when it ran there
// or touched files under a folder of that name.
function inRepo(task, repo) {
  if (!repo) return false;
  if (task.repo === repo) return true;
  return (Array.isArray(task.files) ? task.files : []).some((f) => typeof f === 'string' && f.split('/')[0] === repo);
}

function similar(a, b) {
  const sb = new Set(b);
  const both = a.filter((t) => sb.has(t)).length;
  return both / (new Set([...a, ...b]).size || 1) >= 0.6;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function day(iso, now = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const year = d.getUTCFullYear() === new Date(now).getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}`;
}
// At most n characters, cut at a word when there is one near the end.
const clip = (s, n) => {
  const t = oneLine(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
// grilling, Explore, chrome: a step as the owner would name it.
const stepName = (s) => String(s).replace(/^(agent|mcp):/, '').split(':').pop();
const quoted = (list, n) => (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 2).map((x) => `"${clip(x, n)}"`).join(', ');

// One past task in a few sentences, as in the hook note and `loadout recall`.
export function describe(task) {
  const steps = [...new Set((task.steps ?? []).map(stepName))];
  const out = [`Last time "${clip(task.ask, 140)}"${steps.length ? `: you used ${steps.join(' → ')}.` : '.'}`];
  const corrected = quoted(task.corrections, 120);
  const decided = quoted(task.decisions, 140);
  if (corrected) out.push(`You corrected: ${corrected}.`);
  if (decided) out.push(`You decided: ${decided}.`);
  if (task.outcome) out.push(`It ended: "${clip(task.outcome, 160)}"`);
  return out.join(' ');
}

const heading = (task, now) => ['loadout recalled', day(task.at, now), task.repo].filter(Boolean).join(' · ');

// The note Claude gets: what this is, then each task, under MAX_RECALL_MD.
export function renderRecall(hits, { now = Date.now() } = {}) {
  let md = "From the user's own past Claude Code sessions on this machine. Use it if it fits this task; it may be out of date. Don't recite it; if it changes what you do, say so in a few words.";
  for (const { task } of hits) {
    const part = `\n\n${heading(task, now)}\n${describe(task)}`;
    if (md.length + part.length > MAX_RECALL_MD) {
      if (md.length < 400) md = clip(md + part, MAX_RECALL_MD);
      break;
    }
    md += part;
  }
  return md;
}

// The one line the user sees.
export const recallBanner = (hits) => `loadout recalled: ${clip(hits[0].task.ask, 60)}${hits.length > 1 ? ` +${hits.length - 1}` : ''}`;

// The index lines that could be about `prompt` (two of its terms appear in the raw line, or one when `loose`),
// parsed, with how many lines each term appears in, for recallFor. Parsing only those keeps the prompt hook fast
// on a big index. Sessions marked incognito since the index was built stay out. Nothing when the index is missing.
export function readCandidates(prompt, { home = loadoutHome(), loose = false } = {}) {
  const none = { tasks: [], counts: { n: 0, df: new Map() } };
  let text;
  try {
    text = readFileSync(join(home, 'recall', 'index.jsonl'), 'utf8');
  } catch {
    return none;
  }
  const q = terms(prompt);
  // A term's stem as it shows up inside the words it came from (category for categories).
  const keys = q.map((t) => (t.endsWith('y') ? t.slice(0, -1) : t));
  let incognito = [];
  try {
    incognito = JSON.parse(readFileSync(join(home, 'incognito.json'), 'utf8')).sessions ?? [];
  } catch {}
  const hidden = new Set(incognito);
  const df = new Map(q.map((t) => [t, 0]));
  const tasks = [];
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    n++;
    const low = line.toLowerCase();
    let found = 0;
    for (const [i, k] of keys.entries()) {
      if (!low.includes(k)) continue;
      found++;
      df.set(q[i], df.get(q[i]) + 1);
    }
    if (found < (loose ? 1 : 2)) continue;
    try {
      const t = JSON.parse(line);
      if (t && typeof t === 'object' && !hidden.has(t.session)) tasks.push(t);
    } catch {}
  }
  return { tasks, counts: { n, df } };
}

// On unless the owner turned it off (`loadout recall off`).
export function recallOn(home = loadoutHome()) {
  try {
    return JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).recall !== false;
  } catch {
    return true;
  }
}

// Which task ids this session has already been reminded of.
export function recalledIn(sessionId, home = loadoutHome()) {
  const r = sessionState(sessionId, home).recalled;
  return Array.isArray(r) ? r : [];
}
export function markRecalled(sessionId, ids, home = loadoutHome()) {
  saveSessionState(sessionId, { recalled: [...new Set([...recalledIn(sessionId, home), ...ids])] }, home);
}

// The repo and branch a hook event's cwd is in, the way the index names them. Reads .git/HEAD, no git process.
export function whereIs(cwd) {
  if (typeof cwd !== 'string' || !cwd) return { repo: null, branch: null };
  let branch = null;
  try {
    let git = join(cwd, '.git');
    if (statSync(git).isFile()) git = resolve(cwd, /gitdir:\s*(.+)/.exec(readFileSync(git, 'utf8'))[1].trim());
    branch = /ref: refs\/heads\/(.+)/.exec(readFileSync(join(git, 'HEAD'), 'utf8'))?.[1].trim() ?? null;
  } catch {}
  return { repo: basename(cwd), branch };
}
