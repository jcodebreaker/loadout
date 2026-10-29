// Mines redacted sessions into a Loadout: per goal class, the ordered skills/agents/MCP/actions this person
// reaches for, plus the phrasings they repeat and their kit. Deterministic; --llm only rewrites wording.
import { spawn } from 'node:child_process';

const log = (...args) => console.error('loadout:', ...args);

// Goal classes, in tie-break order: specific intents first, "feature" last because "add"/"build" are everywhere.
// Keywords are whole words so the hook's trigger match (pack.playbookFor) can use the same words. A strong word
// names the goal on its own ("mockup"); a weak one ("ui", "fix", "push") turns up in any kind of turn, so a
// prompt needs two of them, or one strong word, to count. Turns that match nothing are skipped.
const CLASSES = [
  { id: 'bug', name: 'Fix a bug', when: 'Fixing a bug, an error or a failing test.',
    strong: ['bug', 'bugs', 'broken', 'crash', 'crashes', 'crashing', 'regression', 'debug', 'flaky', 'failing'],
    weak: ['fix', 'fixes', 'fixing', 'error', 'errors', 'breaks', 'fails'] },
  { id: 'review', name: 'Review', when: 'Reviewing code or a pull request.',
    strong: ['audit', 'critique'],
    weak: ['review', 'reviewing', 'diff', 'pr'] },
  { id: 'refactor', name: 'Refactor', when: 'Refactoring or simplifying existing code.',
    strong: ['refactor', 'refactoring', 'restructure', 'dedupe'],
    weak: ['cleanup', 'simplify', 'rename', 'tidy'] },
  { id: 'docs', name: 'Write docs', when: 'Writing docs, a README or an ADR.',
    strong: ['readme', 'documentation', 'adr', 'changelog'],
    weak: ['docs', 'doc', 'document'] },
  { id: 'design', name: 'Design the UI', when: 'Designing UI or making a mockup.',
    strong: ['mockup', 'mockups', 'mock-up', 'mock-ups', 'wireframe', 'figma', 'css', 'styling'],
    weak: ['design', 'mock', 'ui', 'ux', 'layout'] },
  { id: 'idea', name: 'New idea or plan', when: 'Starting from a new idea, a plan or a concept.',
    strong: ['idea', 'ideas', 'brainstorm', 'brainstorming', 'grill'],
    weak: ['concept', 'pitch', 'imagine', 'plan', 'planning'] },
  { id: 'research', name: 'Research', when: 'Researching, investigating or comparing options.',
    strong: ['research'],
    weak: ['investigate', 'compare', 'explore', 'survey', 'evaluate'] },
  { id: 'ship', name: 'Ship it', when: 'Shipping: pushing, merging or releasing.',
    strong: ['ship', 'release', 'deploy'],
    weak: ['push', 'publish', 'merge', 'launch'] },
  { id: 'feature', name: 'Build a feature', when: 'Building or adding a feature.',
    strong: ['feature', 'implement', 'scaffold'],
    weak: ['build', 'add', 'create', 'support', 'integrate'] },
].map((c) => ({ ...c, words: [...c.strong, ...c.weak] }));

// Built-in slash commands arrive as skills (<command-name>) but say nothing about how someone works.
const BUILTINS = new Set(['add-dir', 'agents', 'bashes', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'exit',
  'export', 'help', 'hooks', 'ide', 'init', 'login', 'logout', 'mcp', 'memory', 'model', 'output-style', 'permissions',
  'plugin', 'privacy-settings', 'release-notes', 'resume', 'rewind', 'status', 'statusline', 'terminal-setup', 'theme',
  'todos', 'upgrade', 'usage', 'vim', 'fast', 'effort']);
// Skills that fire because the harness requires them (publishing a page, editing settings, a built-in review),
// not because the person chose them: never steps or kit.
const HARNESS = new Set(['artifact-design', 'artifact-capabilities', 'artifact-diagramming', 'update-config', 'keybindings-help',
  'init', 'reload-plugins', 'review', 'security-review']);

const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WEB = new Set(['WebSearch', 'WebFetch']);
const GIT = { commit: 'commits', push: 'pushes' };
const PLAIN = new Set(['reads code', 'edits code']);
const isPlan = (e) => e.kind === 'plan' || (e.kind === 'command' && e.name === 'plan');
const isEdit = (e) => e.kind === 'tool' && EDITS.has(e.name);

// Skills, agents and MCP servers are the distinctive signal, so they qualify at a modest share of a big class
// (and in ≥2 sessions, so one long session can't carry them). Generic steps everyone takes must be the norm.
const DISTINCT_MIN = 0.15;
const DISTINCT_SESSIONS_MIN = 1 / 3;
const GENERIC_MIN = 0.5;
const LIFT_MIN = 1.5;
const MAX_PLAYBOOKS = 6;
const MAX_PATTERNS = 12;
const isDistinct = (key) => /^(skill|agent|mcp):/.test(key);
const hasPlaceholder = (s) => /[‹›]/.test(String(s)); // redact.mjs leaves ‹path›, ‹name›, ...

// A skill says what a turn is for more reliably than its wording: a turn that ran a grilling skill is
// planning whatever the prompt said. Matched on the skill's own name (after any plugin prefix); first hit wins.
const SKILL_HINTS = [
  [/grill|brainstorm|plan|domain-model|prototype|interview/, 'idea'],
  [/hallmark|design|mockup|frontend|shadcn|\bui\b/, 'design'],
  [/diagnos|debug|bug/, 'bug'],
  [/review|audit/, 'review'],
  [/refactor|simplif/, 'refactor'],
  [/research/, 'research'],
  [/\bdocs?\b|readme|\badr\b/, 'docs'],
  [/deploy|release|ship/, 'ship'],
  [/tdd|scaffold/, 'feature'],
];
const LLM_TIMEOUT_MS = 60_000;

const skillName = (name) => String(name || '').replace(/^\//, '').trim();
// A skill the person chose: named, not built in or harness-mandated, untouched by redaction.
const ownSkill = (name) => { const n = skillName(name); return !!n && !BUILTINS.has(n) && !HARNESS.has(n) && !hasPlaceholder(n); };
const ms = (at) => { const t = Date.parse(at); return Number.isFinite(t) ? t : null; };
const byCountThenName = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const rate = (n, of) => (of ? Math.round((n / of) * 100) / 100 : 0);
const words = (text) => String(text || '').toLowerCase().match(/[a-z][a-z0-9'-]*/g) || [];
// Provenance for the review page: distinct sessions and the last day (UTC, YYYY-MM-DD) one of them started.
const provenance = (ids, days) => {
  const last = [...ids].map((id) => days.get(id)).filter(Boolean).sort().pop();
  return { sessions: ids.size, ...(last ? { lastSeen: last } : {}) };
};

// One step token per event, or null for events that carry no workflow signal (plain Bash, TodoWrite, ...).
// Subagents contribute only their skills and MCP servers: their own reads/edits are the subagent's business.
function token(e, { inSubagent = false } = {}) {
  if (e.kind === 'skill') return ownSkill(e.name) ? `skill:${skillName(e.name)}` : null;
  if (e.kind === 'agent') return inSubagent ? null : `agent:${e.type || 'general-purpose'}`;
  if (e.kind === 'mcp') return e.server && !hasPlaceholder(e.server) ? `mcp:${e.server}` : null;
  if (inSubagent) return null;
  if (e.kind === 'test') return 'runs tests'; // a 'check' of how 'test' duplicates it, so checks add no step
  if (isPlan(e)) return 'plans in plan mode';
  if (e.kind === 'git') return GIT[e.verb] || null;
  if (e.kind === 'tool') {
    if (READS.has(e.name)) return 'reads code';
    if (EDITS.has(e.name)) return 'edits code';
    if (WEB.has(e.name)) return 'searches the web';
  }
  return null;
}

// Turn rule: a turn starts at a prompt and runs to the next one. Events before the first prompt are dropped.
// Subagent rule: a subagent belongs to the main `agent` event that spawned it, found as the latest agent event
// of the same type at or before the subagent's first timestamp; without timestamps, the i-th subagent of a
// type pairs with the i-th unclaimed agent event of that type; failing both, the session's last turn.
export function turnsOf(session) {
  const turns = [];
  const agentAt = []; // [{ turn, index, type, t, claimed }]
  for (const e of session.events || []) {
    if (e.kind === 'prompt') { turns.push({ prompt: e, events: [], attached: new Map(), checks: new Map() }); continue; }
    const turn = turns[turns.length - 1];
    if (!turn) continue;
    if (e.kind === 'agent') agentAt.push({ turn, index: turn.events.length, type: e.type, t: ms(e.at), claimed: false });
    turn.events.push(e);
  }
  for (const sub of session.subagents || []) {
    const t = (sub.events || []).map((e) => ms(e.at)).find((x) => x !== null) ?? null;
    let spawn = null;
    if (t !== null) {
      const timed = agentAt.filter((a) => a.type === sub.type && a.t !== null && a.t <= t);
      spawn = timed.sort((a, b) => b.t - a.t || (a.claimed - b.claimed))[0] || null;
    }
    spawn ||= agentAt.find((a) => a.type === sub.type && !a.claimed) || null;
    if (spawn) spawn.claimed = true;
    const turn = spawn?.turn || turns[turns.length - 1];
    if (!turn) continue;
    const at = spawn ? spawn.index : turn.events.length;
    const list = turn.attached.get(at) || [];
    for (const e of sub.events || []) { const k = token(e, { inSubagent: true }); if (k) list.push(k); }
    turn.attached.set(at, list);
    turn.checks.set(at, [...(turn.checks.get(at) || []), ...(sub.events || []).filter((e) => e.kind === 'check' || e.kind === 'test' || e.kind === 'file')]);
  }
  // `events`: the main thread's, with each subagent's checks (and, read with detail, its files) placed where it was spawned.
  return turns.map((turn) => ({
    prompt: turn.prompt, steps: stepsOf(turn),
    events: [...turn.events.flatMap((e, i) => [e, ...(turn.checks.get(i) || [])]), ...(turn.checks.get(turn.events.length) || [])],
  }));
}

// Ordered steps for a turn: consecutive repeats collapse (agents keep a count), and a stretch of plain
// reads/edits collapses to its distinct order, so `read edit read edit` is just "reads code → edits code".
function stepsOf(turn) {
  const raw = [];
  turn.events.forEach((e, i) => {
    const k = token(e);
    if (k) raw.push({ key: k, count: 1, after: turn.attached.get(i) || [] });
    else if (turn.attached.has(i)) raw.push({ key: null, count: 0, after: turn.attached.get(i) });
  });
  if (turn.attached.has(turn.events.length)) raw.push({ key: null, count: 0, after: turn.attached.get(turn.events.length) });

  const out = [];
  let pending = []; // subagent tokens waiting for the end of the current agent run
  const flush = () => { for (const k of pending) push(k); pending = []; };
  const push = (key, count = 1) => {
    const last = out[out.length - 1];
    if (last && last.key === key) { last.count += count; return; }
    if (PLAIN.has(key)) {
      // Inside a stretch of plain steps, a step already seen in that stretch adds nothing.
      for (let j = out.length - 1; j >= 0 && PLAIN.has(out[j].key); j--) if (out[j].key === key) return;
    }
    out.push({ key, count });
  };
  for (const r of raw) {
    if (r.key) {
      const last = out[out.length - 1];
      if (!(r.key.startsWith('agent:') && last && last.key === r.key)) flush();
      push(r.key, r.count);
    }
    for (const k of r.after) if (!pending.includes(k)) pending.push(k);
  }
  flush();
  return out;
}

// Prompt-only class: strong words score 2, weak ones 1, and a class needs 2. Highest score wins, ties go to
// the earlier class.
export function classify(text) {
  const seen = new Set(words(text));
  let best = null;
  for (const c of CLASSES) {
    const hits = c.words.filter((w) => seen.has(w));
    const score = hits.reduce((n, w) => n + (c.strong.includes(w) ? 2 : 1), 0);
    if (score >= 2 && (!best || score > best.score)) best = { id: c.id, hits, score };
  }
  return best && { id: best.id, hits: best.hits };
}

// A turn's class: the first skill it ran that hints at a class, else the opening prompt's keywords.
// `hits` are always prompt words of the chosen class, since they become the playbook's trigger words. `at` is
// that skill's step index: a slash-invoked skill arrives without a prompt of its own, so what ran before it in
// the turn belonged to the previous request.
export function classifyTurn(text, steps) {
  const ws = new Set(words(text));
  for (const [at, s] of steps.entries()) {
    if (!s.key.startsWith('skill:')) continue;
    const own = s.key.slice(6).split(':').pop();
    const hint = SKILL_HINTS.find(([re]) => re.test(own));
    if (hint) return { id: hint[1], hits: CLASSES.find((c) => c.id === hint[1]).words.filter((w) => ws.has(w)), at };
  }
  const c = classify(text);
  return c && { ...c, at: 0 };
}

const stepDo = (key, count) => {
  if (key.startsWith('skill:')) return `Uses the ${key.slice(6).split(':').pop()} skill`;
  if (key.startsWith('agent:')) {
    const type = key.slice(6);
    return count > 1 ? `Spins up ${count} ${type} sub-agents` : `Spins up ${/^[aeiou]/i.test(type) ? 'an' : 'a'} ${type} sub-agent`;
  }
  if (key.startsWith('mcp:')) return `Uses ${key.slice(4)} (MCP)`;
  return key[0].toUpperCase() + key.slice(1);
};
const stepUses = (key) => (key.startsWith('skill:') ? key.slice(6) : key.startsWith('agent:') || key.startsWith('mcp:') ? key : undefined);

// Playbook steps: items are "step#k" (the k-th occurrence in a turn, so "runs tests" twice survives).
// Keep distinctive items in ≥2 sessions and either ≥15% of the class's turns or ≥1/3 of its sessions (a skill
// run once per session drowns in a long session's follow-ups), generic ones in ≥50%, then order them by
// pairwise majority within turns: a step's score is the share of the steps it ran alongside that it precedes in
// most such turns, minus the share it follows (-1..1); a step that never ran alongside another scores by its
// median relative position (0 first → 1, last → -1). Ties go to the lower median position, then name.
// Mean absolute position let a step that often runs alone ("edits code") jump ahead of the skill that opens
// the task whenever both ran. A distinctive step must also be ≥1.5× likelier in
// this class than across all classified turns (`overall`: key -> share of turns): a tool used everywhere
// describes the person's kit, not this playbook. Only a plain step may repeat, and never back to back.
function playbookSteps(turns, overall) {
  const items = new Map(); // item -> { turns, counts: [], sessions: Set }
  const seqs = turns.map(({ steps, session }) => {
    const nth = new Map();
    return steps.map((s) => {
      const k = (nth.get(s.key) || 0) + 1;
      nth.set(s.key, k);
      return { item: `${s.key}#${k}`, key: s.key, count: s.count, session };
    });
  });
  for (const seq of seqs) for (const s of seq) {
    const it = items.get(s.item) || { key: s.key, turns: 0, counts: [], sessions: new Set() };
    it.turns++; it.counts.push(s.count); it.sessions.add(s.session);
    items.set(s.item, it);
  }
  const sessions = new Set(turns.map((t) => t.session)).size;
  const share = (key) => turns.filter((t) => t.steps.some((s) => s.key === key)).length / turns.length;
  const qualifies = (item, v) => (isDistinct(v.key)
    ? item.endsWith('#1') && v.sessions.size >= 2 && share(v.key) >= LIFT_MIN * (overall.get(v.key) || 0)
      && (v.turns / turns.length >= DISTINCT_MIN || v.sessions.size / sessions >= DISTINCT_SESSIONS_MIN)
    : v.turns / turns.length >= GENERIC_MIN);
  const kept = new Set([...items].filter(([k, v]) => qualifies(k, v)).map(([k]) => k));
  const pos = new Map(); // item -> relative positions in its turns
  const before = new Map(); // "a\0b" -> turns where a ran before b
  for (const seq of seqs) {
    const ks = seq.filter((s) => kept.has(s.item)).map((s) => s.item);
    ks.forEach((a, i) => {
      const p = pos.get(a) || []; p.push(ks.length > 1 ? i / (ks.length - 1) : 0); pos.set(a, p);
      for (const b of ks.slice(i + 1)) before.set(`${a}\0${b}`, (before.get(`${a}\0${b}`) || 0) + 1);
    });
  }
  const score = new Map([...kept].map((a) => {
    let net = 0, met = 0;
    for (const b of kept) {
      const ab = before.get(`${a}\0${b}`) || 0, ba = before.get(`${b}\0${a}`) || 0;
      if (ab + ba) { net += Math.sign(ab - ba); met++; }
    }
    return [a, met ? net / met : 1 - 2 * median(pos.get(a))];
  }));
  const steps = [];
  for (const item of [...kept].sort((a, b) => score.get(b) - score.get(a) || median(pos.get(a)) - median(pos.get(b)) || cmp(a, b))) {
    const key = item.slice(0, item.lastIndexOf('#'));
    if (steps.length && steps[steps.length - 1].key === key) continue;
    steps.push({ key, count: median(items.get(item).counts) });
  }
  return steps.map(({ key, count }) => {
    const step = { do: stepDo(key, count) };
    const uses = stepUses(key);
    if (uses) step.uses = uses;
    return step;
  });
}

// Pattern phrasing: split prompts into clauses, strip lead-ins and polite wrappers ("can you ..."), then keep
// only instructions that read like a person typed them: no questions, no fillers, no pasted terminal output.
// A habit is rarely a whole clause ("spin up a fable sub-agent to review your plan"), so patterns are spans
// of 3-10 words starting at an action verb anywhere in a clause, merged across light rewordings.
const FILLERS = new Set(['ok', 'okay', 'so', 'now', 'please', 'pls', 'and', 'then', 'also', 'alright', 'great', 'cool', 'lets', "let's", 'right', 'hey', 'oh', 'well', 'yes', 'yeah', 'perfect', 'nice', 'awesome', 'good', 'but', 'actually', 'anyway', 'hmm', 'wait']);
// Lead-ins dropped from the front of a clause ("first of all make a mockup" → "make a mockup").
const LEADS = ['first of all', 'go ahead and', 'sounds good', 'makes sense', 'thank you', 'thanks', 'in that case', 'for now', 'at this point',
  'i want you to', "i'd like you to", 'i would like you to', 'i need you to', 'you should', 'you can', 'we should', 'we need to', 'just'];
// Politeness dropped from the end ("make a mockup first please" → "make a mockup first").
const TAIL = /\s+(?:please|pls|thanks|thank you|for me|ok|okay|now)$/;
// Clauses (and spans) that start like this are conversation, not instructions. Matched without apostrophes.
const NOISE = ['i dont know', 'im not sure', 'not sure', 'let me know', 'i think', 'i guess', 'i mean',
  'i feel like', 'i see', 'no worries', 'never mind', 'nevermind', 'my bad', 'fair enough', 'got it', 'of course', 'sounds good',
  'makes sense', 'go ahead', 'thank you', 'thanks', 'looks good', 'all good', 'that works', 'it works', 'same thing', 'you know',
  'keep going', 'do it', 'try again', 'one more thing', 'as i said', 'like i said', 'by the way', 'no problem', 'it seems',
  'dont know', 'dont see', 'dont get', 'dont understand', 'you get what', 'something like'];
const POLITE = /^(?:can|could|would|will) (?:you|we)\s+/;
const QUESTION = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'which', 'is', 'are', 'does', 'did', 'can', 'could', 'should', 'will', 'would', 'was', 'were', 'have', 'has', 'am']);
const STOP = new Set(['the', 'a', 'an', 'it', 'this', 'that', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'is', 'be', 'me', 'you', 'we', 'i', 'my', 'do', 'just', 'all', 'again', 'now', 'then', 'go', 'ahead', 'keep', 'going', 'sounds', 'good', 'looks', 'thanks', 'thank', 'yes', 'ok', 'push', 'commit', 'try', 'continue', 'one', 'more', 'please', 'next', 'done', 'like', 'sure', 'what', 'about', 'some', 'thing', 'things', 'stuff',
  'look', 'much', 'many', 'want', 'think', 'worry', 'need', 'know', 'see', 'mean', 'really', 'very', 'thing', 'here', 'there']);
// A span never ends on a word that leaves it hanging ("give me a", "make sure we").
const DANGLING = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'is', 'are', 'be', 'me', 'you', 'we', 'i', 'my', 'your',
  'our', 'it', 'its', "it's", 'this', 'that', 'these', 'those', 'so', 'but', 'like', 'if', 'as', 'at', 'by', 'from', 'what', 'how', 'when', 'which',
  'who', 'where', 'can', 'will', 'would', 'should', 'do', 'does', 'have', 'has', 'was', 'were', 'not', 'no', 'just', 'some', 'any', 'all', 'up',
  'about', 'much', 'many', 'more', 'out', 'there', 'here', 'than', 'into', 'over', 'very', 'really', 'gonna', 'want', 'think',
  'feel', 'make', 'check', 'get', 'go', 'look', 'see', 'use', 'something', 'similar']);
// Action verbs: a span starts at one. LEAD_VERBS are fine at a clause's start, too vague mid-clause.
const VERBS = new Set(['make', 'spin', 'fire', 'use', 'run', 'write', 'add', 'build', 'keep', 'check', 'read', 'start', 'create', 'ask', 'grill',
  'open', 'show', 'fix', 'test', 'review', 'draft', 'plan', 'put', 'split', "don't", 'dont', 'never', 'always', 'avoid', 'stop', 'give',
  'find', 'rebase', 'ship', 'deploy', 'push', 'commit', 'merge', 'update', 'remove', 'delete', 'rename', 'explain', 'summarize', 'compare',
  'research', 'investigate', 'design', 'mock', 'sketch', 'dispatch', 'follow', 'send', 'record', 'list', 'cut', 'drop', 'move', 'wire',
  'verify', 'launch', 'kill', 'restart', 'rebuild', 'clean', 'prototype', 'brainstorm', 'refactor', 'simplify', 'document', 'mockup',
  'implement', 'search', 'clone', 'improve', 'iterate', 'polish', 'describe']);
const LEAD_VERBS = new Set([...VERBS, 'do', 'go', 'look', 'take', 'let']);
const SPAN_MIN = 3, SPAN_MAX = 10;
const NUMERIC = /^\d[\d.,:/x]*(?:[a-z]{0,3}|%)$/; // 0, 0b, 89, 1.2gb, 10ms, 12:30, 3x, 40%
const isNoise = (s) => { const t = s.replace(/'/g, ''); return NOISE.some((n) => t === n || t.startsWith(`${n} `)); };

// Pasted terminal or log output: shell prompts, home paths, user@host, flags, aligned columns, or rows of
// numbers and short tokens. Checked on the raw clause, before whitespace is collapsed.
function looksLikeOutput(raw, ws) {
  if (/\$ |(?:^|\s)%\s*$|@|~\/|^\s*[>#❯➜]\s|(?:^|\s)--?[a-z][\w-]*(?:=|\s|$)/i.test(raw)) return true;
  if (/\S(?: {2,}|\t)\S/.test(raw.trim())) return true;
  if (ws.filter((w) => NUMERIC.test(w)).length / ws.length > 0.15) return true;
  return ws.length >= 5 && ws.filter((w) => w.length <= 2).length / ws.length > 0.5;
}

// The person's instruction clauses in a prompt, lightly cleaned: [{ text, rank }], rank 2 when the clause
// starts with an action verb or was a polite request.
export function phrases(text) {
  const out = [];
  for (const part of String(text || '').split(/(?<=[.!?;,\n])|\b(?:and then|and also)\b/i)) {
    if (!part.trim() || hasPlaceholder(part)) continue;
    const isQ = /\?\s*$/.test(part);
    let s = part.toLowerCase().replace(/[‘’]/g, "'").replace(/[`"“”()[\]{}<>*_]/g, ' ').replace(/[.!?;,:]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s || looksLikeOutput(part.replace(/[.!?;,]+\s*$/, ''), s.split(' '))) continue;
    for (let changed = true; changed;) {
      changed = false;
      const ws = s.split(' ');
      if (ws.length && FILLERS.has(ws[0])) { s = ws.slice(1).join(' '); changed = true; continue; }
      const lead = LEADS.find((l) => s === l || s.startsWith(`${l} `));
      if (lead) { s = s.slice(lead.length).trim(); changed = true; continue; }
      if (TAIL.test(s)) { s = s.replace(TAIL, ''); changed = true; }
    }
    const polite = POLITE.test(s);
    s = s.replace(POLITE, '');
    const ws = s.split(' ').filter(Boolean);
    if (ws.length < SPAN_MIN || isNoise(s)) continue;
    if (!polite && (isQ || QUESTION.has(ws[0]))) continue;
    const leads = LEAD_VERBS.has(ws[0]);
    if (!leads && !ws.some((w) => VERBS.has(w))) continue;
    out.push({ text: s, rank: polite || leads ? 2 : 1 });
  }
  return out;
}

// Merge key for near-duplicates: no hyphens, apostrophes or articles, light stemming ("sub-agents" = "sub agent").
const stem = (w) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w.replace(/([^s])s$/, '$1'));
const spanKey = (ws) => ws.join(' ').replace(/-/g, ' ').replace(/'/g, '').split(' ').filter((w) => w && !['a', 'an', 'the'].includes(w)).map(stem).join(' ');

// Candidate spans of a clause: from each action verb (or a lead verb at the start), 3-10 words, ending on a
// word that completes it and holding at least one content word beyond the verb.
function spans({ text, rank }) {
  const ws = text.split(' ');
  const out = [];
  ws.forEach((w, i) => {
    if (!(VERBS.has(w) || (i === 0 && LEAD_VERBS.has(w)))) return;
    for (let n = SPAN_MIN; n <= SPAN_MAX && i + n <= ws.length; n++) {
      const span = ws.slice(i, i + n);
      if (DANGLING.has(span[n - 1]) || isNoise(span.join(' ')) || ['you', 'we', 'i'].includes(span[1])) continue; // "do you want"
      if (!span.slice(1).some((x) => x.length >= 4 && !STOP.has(x) && !NUMERIC.test(x))) continue;
      out.push({ text: span.join(' '), key: spanKey(span), lead: i === 0 && rank === 2 });
    }
  });
  return out;
}

// A pattern is a span seen in ≥2 sessions, never from a pasted prompt. Most sessions first, then verb-first,
// then the longer (more specific) span; a span overlapping one already chosen adds nothing. The text shown is
// the person's most frequent wording.
function minePatterns(sessions, days) {
  const found = new Map(); // key -> { sessions: Set, forms: Map, lead }
  for (const s of sessions) for (const e of s.events || []) {
    if (e.kind !== 'prompt' || e.hadPaste || /pasted_content/.test(e.text || '')) continue;
    for (const c of phrases(e.text)) for (const p of spans(c)) {
      const f = found.get(p.key) || { sessions: new Set(), forms: new Map(), lead: false };
      f.sessions.add(s.id); f.lead ||= p.lead;
      f.forms.set(p.text, (f.forms.get(p.text) || 0) + 1);
      found.set(p.key, f);
    }
  }
  const within = (a, b) => ` ${b} `.includes(` ${a} `);
  const chosen = [];
  const ranked = [...found]
    .filter(([, f]) => f.sessions.size >= 2)
    .sort((a, b) => b[1].sessions.size - a[1].sessions.size || b[1].lead - a[1].lead
      || b[0].split(' ').length - a[0].split(' ').length || cmp(a[0], b[0]));
  for (const [key, f] of ranked) {
    if (chosen.length >= MAX_PATTERNS) break;
    if (chosen.some((c) => within(key, c.key) || within(c.key, key))) continue;
    const text = [...f.forms].sort(byCountThenName)[0][0];
    if (text.length <= 120) chosen.push({ key, text, seen: f.sessions.size, ids: f.sessions }); // seen = distinct sessions
  }
  return chosen.map(({ text, seen, ids }) => ({ text, seen, ...provenance(ids, days) }));
}

// Turns with their class and whether the prompt opens a task (not `midTask`; sessions read before v0.2 carry no
// `midTask`, so there only a session's first prompt opens one). Plan mode entered just before typing lands at
// the end of the previous turn, so a plan with no edit after it carries over to the next turn.
function turnsWith(session) {
  const turns = turnsOf(session);
  return turns.map((t, i) => {
    const prev = turns[i - 1]?.events || [];
    const carried = prev.findLastIndex(isPlan) > prev.findLastIndex(isEdit) ? [{ kind: 'plan' }] : [];
    return { ...t, events: [...carried, ...t.events], cls: classifyTurn(t.prompt.text, t.steps)?.id || null,
      opener: !(t.prompt.midTask ?? i > 0), next: turns[i + 1]?.prompt || null };
  });
}

// Rules: what the person had to correct. A prompt is a correction when it carries a marker ("no", "stop",
// "don't", "you forgot", ...); `midTask` is true for nearly every prompt, so it adds nothing. A prompt right
// after an interrupt or a rejected tool is one by definition. From each, the instruction clause is rewritten as an imperative ("you forgot to update the
// README" → "Update the README"), with the same junk filters as patterns.
const MARK_LEAD = ['not like that', 'not that', 'hold on', 'no no', 'no', 'nope', 'nah', 'stop', 'wait', 'actually', 'wrong', 'again', 'oops', 'ugh', 'instead'];
const MARK_ANY = /\b(?:don'?t|do not|never|always|instead|you forgot|you forget|you didn'?t|you did not|you missed|i said|i told you|not like that|stop \w+ing)\b/i;
const REWRITES = [
  [/^you (?:forgot|forget) to /i, ''],
  [/^you (?:forgot|forget|missed) /i, "don't forget "],
  [/^i (?:said|told you|asked you|asked)(?: to)? /i, ''],
  [/^(?:i|we) (?:don'?t|do not) want (?:you |them )?(?:to )?/i, "don't "],
  [/^(?:you|we) (?:should ?n[o']t|must ?n[o']t|should never|must never|can'?t|cannot) /i, "don't "],
  [/^(?:do not|dont) /i, "don't "],
];
const NO_THEN = new Set([...FILLERS, 'no', 'dont', "don't", 'do', 'never', 'always', 'stop', 'wait', 'you', 'i', 'we', 'not']);
const RULE_VERBS = new Set([...LEAD_VERBS, 'leave', 'revert', 'undo', 'skip', 'wait', 'include', 'mention', 'call', 'set', 'change', 'reuse', 'prefer',
  'only', 'be', 'stay', 'retry', 'ignore', 'pass', 'match', 'forget', 'touch', 'hardcode', 'mock', 'install', 'import', 'export', 'stick', 'avoid']);
const RULE_NOISE = ['dont worry', 'dont mind', 'dont bother', 'dont care', 'dont have', 'dont think', 'dont need', 'dont like'];
const RULE_DROP = new Set(['a', 'an', 'the', 'any', 'to', 'it', 'this', 'that', 'dont', 'do', 'not', 'never', 'always', 'please', 'just', 'me', 'you', 'we', 'i', 'my', 'your', 'our']);
const RULE_MAX = 10, RULE_WORDS_MAX = 16;

export function ruleClauses(text, { forced = false } = {}) {
  const out = [];
  let carry = false;
  for (const part of String(text || '').split(/(?<=[.!?;,\n])|\b(?:and then|and also)\b/i)) {
    if (!part.trim() || hasPlaceholder(part) || /\?\s*$/.test(part)) continue;
    let s = part.replace(/[‘’]/g, "'").replace(/[`"“”()[\]{}<>*_]/g, ' ').replace(/[.!?;,:]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s || looksLikeOutput(part.replace(/[.!?;,]+\s*$/, ''), s.toLowerCase().split(' '))) continue;
    let marked = MARK_ANY.test(s);
    for (let changed = true; changed;) {
      changed = false;
      const low = s.toLowerCase();
      const ws = low.split(' ');
      const mark = MARK_LEAD.find((m) => low === m || low.startsWith(`${m} `));
      // "stop adding X" is the instruction itself; "no plan card either" is not "plan card either".
      if (mark && !(mark === 'stop' && /ing$/.test(ws[1] || '')) && !(mark === 'no' && ws[1] && !NO_THEN.has(ws[1]))) { s = s.slice(mark.length).trim(); marked = changed = true; continue; }
      const re = REWRITES.find(([r]) => r.test(s));
      if (re) { s = s.replace(re[0], re[1]); changed = true; continue; }
      const lead = FILLERS.has(ws[0]) ? ws[0] : LEADS.find((l) => low === l || low.startsWith(`${l} `));
      if (lead) { s = s.slice(lead.length).trim(); changed = true; continue; }
      if (POLITE.test(low)) { s = s.replace(new RegExp(POLITE.source, 'i'), ''); changed = true; continue; }
      if (TAIL.test(low)) { s = s.slice(0, low.replace(TAIL, '').length); changed = true; }
    }
    if (!s) { carry ||= marked; continue; }
    marked ||= MARK_ANY.test(s); // a rewrite can surface the marker ("you should not" → "don't")
    const ws = s.toLowerCase().split(' ');
    const ok = ws.length >= 2 && !['i', 'you', 'we'].includes(ws[1]) && ws.length <= RULE_WORDS_MAX && s.length <= 140 && RULE_VERBS.has(ws[0])
      && !DANGLING.has(ws[ws.length - 1]) && !isNoise(s.toLowerCase()) && !RULE_NOISE.some((n) => s.toLowerCase().replace(/'/g, '').startsWith(n));
    if (!ok || !(marked || carry || (forced && !out.length))) continue;
    const neg = /^(?:don't|never|stop|avoid)$/.test(ws[0]);
    const set = ruleSet(ws);
    out.push({ text: s[0].toUpperCase() + s.slice(1), neg, set });
    carry = false;
  }
  return out;
}

// A rule's content words, the clustering key.
const ruleSet = (ws) => [...new Set(ws.map((w) => w.replace(/'/g, '')).filter((w) => !RULE_DROP.has(w)).map(stem))];

// Near-duplicates (same polarity, ≥60% of content words shared) merge; the text shown is the most frequent
// wording. Rules seen in ≥2 sessions come first, most sessions first; then every rule from memory (`memories`:
// redacted [{ text, why, repo, modified }]), one sighting plus the sessions that said it too, starting off when it
// names a repo, the rest by sessions then the most recently saved; then up to RULE_MAX said only once, most often first, which the review page shows switched off. A memory
// keeps its own wording. `from` is where most sightings came from, or 'memory'.
function mineRules(sessions, memories = [], days = new Map()) {
  const found = new Map(); // text -> { neg, set, sessions: Set, n, from: {correction, interrupt, denied} }
  for (const s of sessions) {
    let denied = false;
    for (const e of s.events || []) {
      if (e.kind === 'denied') denied = true;
      if (e.kind !== 'prompt') continue;
      const from = e.afterInterrupt ? 'interrupt' : denied ? 'denied' : 'correction';
      denied = false;
      if (e.hadPaste || /pasted_content/.test(e.text || '')) continue;
      for (const r of ruleClauses(e.text, { forced: from !== 'correction' })) {
        const f = found.get(r.text) || { neg: r.neg, set: r.set, sessions: new Set(), n: 0, from: { correction: 0, interrupt: 0, denied: 0 } };
        f.sessions.add(s.id); f.n++; f.from[from]++;
        found.set(r.text, f);
      }
    }
  }
  const jaccard = (a, b) => { const B = new Set(b); const both = a.filter((x) => B.has(x)).length; return both / (a.length + b.length - both || 1); };
  const clusters = memories.map((m) => ({ neg: /^(?:don't|dont|never|stop|avoid)\b/i.test(m.text), set: ruleSet(words(m.text)),
    sessions: new Set(), forms: [], from: {}, memory: m }));
  for (const [text, f] of [...found].sort((a, b) => b[1].sessions.size - a[1].sessions.size || b[1].n - a[1].n || cmp(a[0], b[0]))) {
    const c = clusters.find((x) => x.neg === f.neg && jaccard(x.set, f.set) >= 0.6);
    if (!c) { clusters.push({ neg: f.neg, set: f.set, sessions: new Set(f.sessions), forms: [[text, f.n]], from: { ...f.from } }); continue; }
    f.sessions.forEach((id) => c.sessions.add(id));
    c.forms.push([text, f.n]);
    for (const k in f.from) c.from[k] = (c.from[k] || 0) + f.from[k];
  }
  const used = new Set();
  const named = clusters.map((c) => ({ c, n: c.forms.reduce((t, f) => t + f[1], 0),
    text: c.memory?.text ?? c.forms.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || cmp(a[0], b[0]))[0][0] }));
  const twice = named.filter(({ c }) => !c.memory && c.sessions.size >= 2).sort((a, b) => b.c.sessions.size - a.c.sessions.size || cmp(a.text, b.text));
  const kept = named.filter(({ c }) => c.memory).sort((a, b) => a.c.memory.repo - b.c.memory.repo || b.c.sessions.size - a.c.sessions.size
    || cmp(String(b.c.memory.modified ?? ''), String(a.c.memory.modified ?? '')) || cmp(a.text, b.text));
  const once = named.filter(({ c }) => !c.memory && c.sessions.size === 1).sort((a, b) => b.n - a.n || cmp(a.text, b.text));
  return [...twice.slice(0, RULE_MAX), ...kept, ...once.slice(0, RULE_MAX)]
    .map(({ c, text }) => {
      const base = `rule-${text.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')}`;
      let id = base;
      for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
      used.add(id);
      const where = provenance(c.sessions, days);
      if (c.memory) {
        const m = c.memory;
        return { id, text, seen: 1 + c.sessions.size, from: 'memory', ...(c.sessions.size ? where : {}), ...(m.why ? { why: m.why } : {}), include: !m.repo };
      }
      const from = ['correction', 'interrupt', 'denied'].reduce((best, k) => (c.from[k] > c.from[best] ? k : best), 'correction');
      return { id, text, seen: c.sessions.size, from, ...where };
    });
}

// Checks: verification habits as honest rates over the turns they apply to, counting the main thread's and
// subagents' checks alike (presence per turn, so many browser clicks count once). Kept at rate ≥0.3 over ≥5
// turns; a habit with less data is not reported. Browser actions include every click, so only a screenshot
// is evidence that the UI was looked at.
const CHECK_RATE_MIN = 0.3, CHECK_OF_MIN = 5, MULTI_EDIT = 3;
const PROOF = /\b(?:show me|prove|proof|run it|screenshots?|the output|evidence)\b/i;
const isCheck = (e, how) => (e.kind === 'check' && e.how === how) || (e.kind === 'test' && how === 'test');
function mineChecks(sessions) {
  const tally = new Map(); // id -> { text, when, hit, of }
  const count = (id, text, when, hit) => { const t = tally.get(id) || { text, when, hit: 0, of: 0 }; t.of++; t.hit += hit ? 1 : 0; tally.set(id, t); };
  for (const s of sessions) for (const t of turnsWith(s)) {
    const ev = t.events;
    const edits = ev.filter(isEdit).length;
    const commit = ev.findLastIndex((e) => e.kind === 'git' && e.verb === 'commit');
    if ((t.cls === 'feature' || t.cls === 'bug') && commit >= 0) {
      const edit = ev.slice(0, commit).findLastIndex(isEdit);
      count('tests-before-commit', 'Runs the tests before committing', 'feature', ev.slice(edit + 1, commit).some((e) => isCheck(e, 'test')));
    }
    if (t.cls === 'design' && edits) count('browser-on-ui', 'Checks in the browser on UI tasks', 'design', ev.some((e) => isCheck(e, 'screenshot')));
    if (edits >= MULTI_EDIT) count('plan-before-multi-file', 'Uses plan mode before multi-file changes', 'any', ev.slice(0, ev.findIndex(isEdit)).some(isPlan));
    if (edits) count('asks-for-proof', 'Asks for proof that it works', 'any', !!t.next && !t.next.hadPaste && PROOF.test(t.next.text || ''));
  }
  return [...tally]
    .map(([id, t]) => ({ id, text: t.text, rate: rate(t.hit, t.of), of: t.of, when: t.when }))
    .filter((c) => c.rate >= CHECK_RATE_MIN && c.of >= CHECK_OF_MIN)
    .sort((a, b) => b.rate - a.rate || b.of - a.of || cmp(a.id, b.id));
}

// Openings: how the person starts a task, over every opening prompt (`of`). Plan first: plan mode before the
// turn's first edit.
const DONE = /\b(?:should|so that|until|done when|make sure|expected|expect|must|the goal|success|passes)\b/i;
function mineOpenings(sessions) {
  const opens = sessions.flatMap((s) => turnsWith(s).filter((t) => t.opener));
  const of = opens.length;
  const share = (pred) => rate(opens.filter(pred).length, of);
  return {
    medianWords: of ? median(opens.map(({ prompt: p }) => p.words ?? words(p.text).length)) : 0,
    withAttachment: share(({ prompt: p }) => !!p.hadPaste || (p.images || 0) > 0),
    namesFiles: share(({ prompt: p }) => !!p.namesFile),
    definesDone: share(({ prompt: p }) => DONE.test(p.text || '')),
    usesPlanFirst: share(({ events }) => isPlan(events.find((e) => isPlan(e) || isEdit(e)) || {})),
    of,
  };
}

// Kit counts are distinct sessions using the item (main thread or any subagent), most used first. A skill or
// server seen once is an experiment, not kit, and a name redaction touched is not worth sharing.
function mineKit(sessions) {
  const skills = new Map(), mcp = new Map(), types = new Map(), models = new Map();
  let withAgents = 0;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const s of sessions) {
    const sk = new Set(), mc = new Set(), ty = new Set(), mo = new Set();
    const all = [...(s.events || []), ...(s.subagents || []).flatMap((a) => a.events || [])];
    for (const e of all) {
      if (e.kind === 'skill' && ownSkill(e.name)) sk.add(skillName(e.name));
      if (e.kind === 'mcp' && e.server && !hasPlaceholder(e.server)) mc.add(e.server);
      if (e.kind === 'agent') { ty.add(e.type || 'general-purpose'); if (e.model) mo.add(e.model); }
    }
    for (const a of s.subagents || []) { if (a.type) ty.add(a.type); if (a.model) mo.add(a.model); }
    if (ty.size) withAgents++;
    sk.forEach((k) => bump(skills, k)); mc.forEach((k) => bump(mcp, k)); ty.forEach((k) => bump(types, k)); mo.forEach((k) => bump(models, k));
  }
  const sorted = (m) => [...m].sort(byCountThenName);
  const repeated = (m) => sorted(m).filter(([, n]) => n >= 2);
  return {
    skills: repeated(skills).map(([name, seen]) => ({ name, seen })),
    mcp: repeated(mcp).map(([server, seen]) => ({ server, seen })),
    agents: {
      share: sessions.length ? Math.round((withAgents / sessions.length) * 100) / 100 : 0,
      types: sorted(types).map(([k]) => k),
      models: sorted(models).map(([k]) => k),
    },
  };
}

function mineStats(sessions) {
  const days = new Set();
  let prompts = 0, subagents = 0;
  const skills = new Set();
  for (const s of sessions) {
    for (const at of [s.startedAt, ...(s.events || []).map((e) => e.at)]) {
      const t = ms(at);
      if (t !== null) days.add(Math.floor(t / 86_400_000));
    }
    let spawns = 0;
    for (const e of s.events || []) {
      if (e.kind === 'prompt') prompts++; // the person's prompts only; a subagent's brief is Claude's
      if (e.kind === 'agent') spawns++;
    }
    for (const e of [...(s.events || []), ...(s.subagents || []).flatMap((a) => a.events || [])]) {
      if (e.kind === 'skill' && ownSkill(e.name)) skills.add(skillName(e.name));
    }
    subagents += Math.max(spawns, (s.subagents || []).length);
  }
  const span = days.size ? Math.max(...days) - Math.min(...days) + 1 : 0; // inclusive calendar days (UTC)
  return { sessions: sessions.length, days: span, prompts, skills: skills.size, subagents };
}

// `memories`: redacted feedback memories, [{ text, why, repo, modified }], seeded into the rules.
export async function mine(sessions, { handle, displayName, llm = false, memories = [] } = {}) {
  sessions = [...(sessions || [])].sort((a, b) => cmp(String(a.startedAt || ''), String(b.startedAt || '')) || cmp(String(a.id), String(b.id)));
  const days = new Map(sessions.filter((s) => ms(s.startedAt) !== null).map((s) => [s.id, new Date(ms(s.startedAt)).toISOString().slice(0, 10)]));
  const byClass = new Map(); // id -> { turns: [{ steps, session }], sessions: Set, hits: Map }
  for (const s of sessions) for (const t of turnsOf(s)) {
    if (!t.steps.length) continue;
    const c = classifyTurn(t.prompt.text, t.steps);
    if (!c) continue;
    const g = byClass.get(c.id) || { turns: [], sessions: new Set(), hits: new Map() };
    g.turns.push({ steps: t.steps.slice(c.at), session: s.id }); g.sessions.add(s.id);
    for (const w of c.hits) g.hits.set(w, (g.hits.get(w) || 0) + 1);
    byClass.set(c.id, g);
  }
  // Share of all classified turns that use each step, the baseline for a step's lift.
  const overall = new Map();
  const classified = [...byClass.values()].flatMap((g) => g.turns);
  for (const t of classified) for (const key of new Set(t.steps.map((s) => s.key))) overall.set(key, (overall.get(key) || 0) + 1);
  for (const [key, n] of overall) overall.set(key, n / classified.length);
  const playbooks = [];
  for (const c of CLASSES) {
    const g = byClass.get(c.id);
    if (!g || g.sessions.size < 2) continue;
    const steps = playbookSteps(g.turns, overall);
    // Only generic steps is what every developer does, and one lone tool is not a routine: nothing to port.
    if (steps.length < 2 || !steps.some((st) => st.uses)) continue;
    // Skill-classified turns may have no keyword in the prompt; fall back to the class's own words for the hook.
    const trigger = g.hits.size ? [...g.hits].sort(byCountThenName).slice(0, 4).map(([w]) => w) : c.words.slice(0, 3);
    playbooks.push({ id: c.id, name: c.name, when: c.when, trigger, steps, seen: g.turns.length, ...provenance(g.sessions, days) });
  }
  playbooks.sort((a, b) => b.seen - a.seen || cmp(a.id, b.id));
  playbooks.splice(MAX_PLAYBOOKS);

  const loadout = {
    handle, displayName, version: 1, builtAt: new Date().toISOString(),
    playbooks,
    rules: mineRules(sessions, memories, days),
    checks: mineChecks(sessions),
    openings: mineOpenings(sessions),
    patterns: minePatterns(sessions, days),
    kit: mineKit(sessions),
    stats: mineStats(sessions),
    removed: { paths: 0, secrets: 0, emails: 0, hosts: 0, names: 0, code: 0, urls: 0 },
  };
  return llm ? polish(loadout) : loadout;
}

// --llm: the user's own `claude -p` rewrites only name, when and steps[].do. It sees the deterministic
// loadout (redacted patterns included, never raw prompts). Any failure keeps the deterministic result.
async function polish(loadout) {
  const input = {
    playbooks: loadout.playbooks.map(({ id, name, when, trigger, steps }) => ({ id, name, when, trigger, steps: steps.map((s) => s.do) })),
    patterns: loadout.patterns.map((p) => p.text),
    kit: { skills: loadout.kit.skills.map((s) => s.name), mcp: loadout.kit.mcp.map((m) => m.server), agents: loadout.kit.agents.types },
  };
  const prompt = [
    'You polish the wording of a developer\'s mined agent workflow. Reply with JSON only, no prose, no code fences.',
    'Shape: {"playbooks":[{"id":string,"name":string,"when":string,"steps":[string]}]}.',
    'Keep every id and the exact number and order of steps. name: at most 5 words. when: one plain sentence.',
    'Each step: one short imperative sentence (at most 15 words) naming the same skill, agent or tool. Invent nothing.',
    '',
    JSON.stringify(input),
  ].join('\n');
  try {
    const out = await runClaude(prompt);
    const envelope = JSON.parse(out);
    if (envelope.is_error) throw new Error('claude reported an error');
    return applyRewrite(loadout, String(envelope.result ?? ''));
  } catch (err) {
    log(`--llm skipped, kept the deterministic loadout (${err.message})`);
    return loadout;
  }
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out after 60s')); }, LLM_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}`)); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// Validates the model's reply and merges only name/when/steps[].do. Throws on any shape mismatch so the
// caller falls back as a whole: a half-merged loadout would be harder to trust than either version.
export function applyRewrite(loadout, text) {
  const json = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const str = (v, max) => typeof v === 'string' && v.trim() && v.length <= max;
  if (!json || !Array.isArray(json.playbooks)) throw new Error('reply has no playbooks array');
  const byId = new Map(json.playbooks.map((p) => [p?.id, p]));
  const playbooks = loadout.playbooks.map((p) => {
    const r = byId.get(p.id);
    if (!r) throw new Error(`reply is missing playbook ${p.id}`);
    if (!str(r.name, 60) || !str(r.when, 200)) throw new Error(`bad name/when for ${p.id}`);
    if (!Array.isArray(r.steps) || r.steps.length !== p.steps.length || !r.steps.every((s) => str(s, 160))) {
      throw new Error(`bad steps for ${p.id}`);
    }
    return { ...p, name: r.name.trim(), when: r.when.trim(), steps: p.steps.map((s, i) => ({ ...s, do: r.steps[i].trim() })) };
  });
  return { ...loadout, playbooks };
}
