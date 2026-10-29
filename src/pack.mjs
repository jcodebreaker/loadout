// Loadout <-> folder, and the LOADOUT.md Claude reads. Pure functions except writePack/readPack
// and the small state helpers the CLI and hooks share.
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MAX_LOADOUT_MD = 8 * 1024;
export const MAX_PLAYBOOK_MD = 2 * 1024;
export const MAX_CLAUDE_MD = 3 * 1024;
export const MAX_RULES = 10;
const HANDLE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RULE_FROM = ['correction', 'interrupt', 'denied', 'memory'];
// A check's `when`, as the tasks its rate counts.
const SCOPES = { feature: 'feature tasks', bug: 'bug fixes', design: 'design tasks', any: 'tasks' };

// ~/.loadout, or LOADOUT_HOME when set.
export function loadoutHome() {
  return process.env.LOADOUT_HOME || join(homedir(), '.loadout');
}

// The active pack as { handle, path, since }, or null when missing or bad.
export function readActive(home = loadoutHome()) {
  try {
    const a = JSON.parse(readFileSync(join(home, 'active.json'), 'utf8'));
    return a && typeof a.handle === 'string' && typeof a.path === 'string' ? a : null;
  } catch {
    return null;
  }
}

// How the prompt hook acts on a match: 'ask' (offer first, the default), 'auto' (inject the steps to
// follow) or 'off'.
export const SUGGEST_MODES = ['ask', 'auto', 'off'];
export function readSuggestMode(home = loadoutHome()) {
  try {
    const mode = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).suggest;
    return SUGGEST_MODES.includes(mode) ? mode : 'ask';
  } catch {
    return 'ask';
  }
}

// Per-session state for the prompt hook: which playbooks it has offered (and, for recall, which past tasks it
// recalled). Files older than a week go.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_DAYS = 7;
const sessionFile = (home, id) => join(home, 'sessions', `${id}.json`);
export function sessionState(sessionId, home = loadoutHome()) {
  if (!SESSION_ID.test(String(sessionId))) return {};
  try {
    const s = JSON.parse(readFileSync(sessionFile(home, sessionId), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
export function saveSessionState(sessionId, patch, home = loadoutHome()) {
  if (!SESSION_ID.test(String(sessionId))) return;
  const dir = join(home, 'sessions');
  mkdirSync(dir, { recursive: true });
  const old = Date.now() - SESSION_DAYS * 86_400_000;
  for (const f of readdirSync(dir)) {
    try {
      if (statSync(join(dir, f)).mtimeMs < old) rmSync(join(dir, f), { force: true });
    } catch {}
  }
  writeFileSync(sessionFile(home, sessionId), `${JSON.stringify({ ...sessionState(sessionId, home), ...patch, at: new Date().toISOString() })}\n`);
}
export function offeredIn(sessionId, home = loadoutHome()) {
  const offered = sessionState(sessionId, home).offered;
  return Array.isArray(offered) ? offered : [];
}
export function markOffered(sessionId, ids, { transcript, home = loadoutHome() } = {}) {
  const offered = [...new Set([...offeredIn(sessionId, home), ...ids])];
  saveSessionState(sessionId, { ...(typeof transcript === 'string' ? { transcript } : {}), offered }, home);
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isRate = (v) => isNum(v) && v >= 0 && v <= 1;
// Optional provenance on rules, playbooks and patterns: distinct sessions and the last day seen.
function provenance(item, at, errors) {
  if (item.sessions !== undefined && !(Number.isInteger(item.sessions) && item.sessions >= 0)) errors.push(`${at}.sessions must be a whole number`);
  if (item.lastSeen !== undefined && !(typeof item.lastSeen === 'string' && /^\d{4}-\d\d-\d\d$/.test(item.lastSeen))) errors.push(`${at}.lastSeen must be YYYY-MM-DD`);
}

export function validate(loadout) {
  const errors = [];
  if (!loadout || typeof loadout !== 'object') return ['loadout must be an object'];
  const l = loadout;
  if (typeof l.handle !== 'string' || !HANDLE.test(l.handle)) errors.push('handle must be 2-31 chars of a-z, 0-9 and -, starting with a letter or digit');
  if (l.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(l.playbooks)) errors.push('playbooks must be a list');
  else {
    const ids = new Set();
    l.playbooks.forEach((p, i) => {
      const at = `playbooks[${i}]`;
      if (!p || typeof p !== 'object') return errors.push(`${at} must be an object`);
      if (!isStr(p.id)) errors.push(`${at}.id is required`);
      else if (ids.has(p.id)) errors.push(`${at}.id "${p.id}" is repeated`);
      else ids.add(p.id);
      if (!isStr(p.name)) errors.push(`${at}.name is required`);
      if (!isStr(p.when)) errors.push(`${at}.when is required`);
      provenance(p, at, errors);
      if (!Array.isArray(p.trigger) || !p.trigger.every(isStr)) errors.push(`${at}.trigger must be a list of words`);
      if (!Array.isArray(p.steps) || p.steps.length === 0) errors.push(`${at}.steps must have at least one step`);
      else p.steps.forEach((s, j) => {
        if (!s || !isStr(s.do)) errors.push(`${at}.steps[${j}].do is required`);
        else if (s.uses !== undefined && !isStr(s.uses)) errors.push(`${at}.steps[${j}].uses must be a name`);
      });
    });
  }
  if (!Array.isArray(l.patterns)) errors.push('patterns must be a list');
  else l.patterns.forEach((p, i) => {
    if (!p || !isStr(p.text)) errors.push(`patterns[${i}].text is required`);
    else if (p.text.length > 120) errors.push(`patterns[${i}].text is over 120 chars`);
    if (p && typeof p === 'object') provenance(p, `patterns[${i}]`, errors);
  });
  const k = l.kit;
  if (!k || typeof k !== 'object') errors.push('kit is required');
  else {
    if (!Array.isArray(k.skills) || !k.skills.every((s) => s && isStr(s.name))) errors.push('kit.skills must be a list of { name }');
    if (!Array.isArray(k.mcp) || !k.mcp.every((s) => s && isStr(s.server))) errors.push('kit.mcp must be a list of { server }');
    const a = k.agents;
    if (!a || !isNum(a.share) || a.share < 0 || a.share > 1 || !Array.isArray(a.types) || !Array.isArray(a.models)) {
      errors.push('kit.agents must be { share 0..1, types, models }');
    }
  }
  // v0.2 fields are optional so v0.1 packs keep loading.
  if (l.rules !== undefined) {
    if (!Array.isArray(l.rules)) errors.push('rules must be a list');
    else {
      if (l.rules.length > MAX_RULES) errors.push(`rules has ${l.rules.length} items, over ${MAX_RULES}`);
      const ids = new Set();
      l.rules.forEach((r, i) => {
        const at = `rules[${i}]`;
        if (!r || typeof r !== 'object') return errors.push(`${at} must be an object`);
        if (!isStr(r.id)) errors.push(`${at}.id is required`);
        else if (ids.has(r.id)) errors.push(`${at}.id "${r.id}" is repeated`);
        else ids.add(r.id);
        if (!isStr(r.text)) errors.push(`${at}.text is required`);
        else if (r.text.length > 140) errors.push(`${at}.text is over 140 chars`);
        if (r.seen !== undefined && !isNum(r.seen)) errors.push(`${at}.seen must be a number`);
        if (r.from !== undefined && !RULE_FROM.includes(r.from)) errors.push(`${at}.from must be one of ${RULE_FROM.join(', ')}`);
        provenance(r, at, errors);
      });
    }
  }
  if (l.checks !== undefined) {
    if (!Array.isArray(l.checks)) errors.push('checks must be a list');
    else {
      const ids = new Set();
      l.checks.forEach((c, i) => {
        const at = `checks[${i}]`;
        if (!c || typeof c !== 'object') return errors.push(`${at} must be an object`);
        if (!isStr(c.id)) errors.push(`${at}.id is required`);
        else if (ids.has(c.id)) errors.push(`${at}.id "${c.id}" is repeated`);
        else ids.add(c.id);
        if (!isStr(c.text)) errors.push(`${at}.text is required`);
        if (!isRate(c.rate)) errors.push(`${at}.rate must be 0..1`);
        if (!Number.isInteger(c.of) || c.of < 1) errors.push(`${at}.of must be a whole number of turns`);
        if (!(c.when in SCOPES)) errors.push(`${at}.when must be one of ${Object.keys(SCOPES).join(', ')}`);
      });
    }
  }
  if (l.openings != null) {
    const o = l.openings;
    if (typeof o !== 'object') errors.push('openings must be an object');
    else {
      if (o.medianWords !== undefined && (!isNum(o.medianWords) || o.medianWords < 0)) errors.push('openings.medianWords must be a number');
      for (const k of ['withAttachment', 'namesFiles', 'definesDone', 'usesPlanFirst']) {
        if (o[k] !== undefined && !isRate(o[k])) errors.push(`openings.${k} must be 0..1`);
      }
    }
  }
  if (l.claudeMd != null) {
    const c = l.claudeMd;
    if (typeof c !== 'object' || typeof c.text !== 'string') errors.push('claudeMd must be { text }');
    else if (Buffer.byteLength(c.text) > MAX_CLAUDE_MD) errors.push(`claudeMd.text is over ${MAX_CLAUDE_MD} bytes`);
    if (c && c.include !== undefined && typeof c.include !== 'boolean') errors.push('claudeMd.include must be true or false');
  }
  if (errors.length === 0) {
    const size = Buffer.byteLength(renderLoadoutMd(l));
    if (size > MAX_LOADOUT_MD) errors.push(`LOADOUT.md is ${size} bytes, over the ${MAX_LOADOUT_MD} byte cap: drop rules`);
  }
  return errors;
}

const nameOf = (l) => (isStr(l.displayName) ? l.displayName.trim() : l.handle);
const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const noDot = (s) => oneLine(s).replace(/[.\s]+$/, '');
const times = (n) => (n === 1 ? 'once' : `${n} times`);
const pct = (r) => `${Math.round(r * 100)}%`;

// Mined text describes the owner ("Runs the tests"); the agent reads instructions ("Run the tests").
const NOT_VERBS = new Set(['always', 'sometimes', 'perhaps', 'this', 'its', 'was', 'plus', 'unless']);
const IRREGULAR = { does: 'do', goes: 'go', has: 'have', is: 'be' };
export function imperative(text) {
  const t = oneLine(text);
  const m = /^([A-Za-z]+)(.*)$/.exec(t);
  if (!m) return t;
  const lower = m[1].toLowerCase();
  let v;
  if (NOT_VERBS.has(lower)) return t;
  if (IRREGULAR[lower]) v = IRREGULAR[lower];
  else if (/[^aeiou]ies$/.test(lower)) v = `${lower.slice(0, -3)}y`;
  else if (/(sh|ch|x|z|ss)es$/.test(lower)) v = lower.slice(0, -2);
  else if (/[^sui]s$/.test(lower)) v = lower.slice(0, -1);
  else return t;
  return (m[1][0] === m[1][0].toUpperCase() ? v[0].toUpperCase() + v.slice(1) : v) + m[2];
}

// A step's tool name, unless the step already says it the way the miner does ("Uses the tdd skill",
// "Spins up an Explore sub-agent", "Uses playwright (MCP)").
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function stepLine(s, i) {
  const what = noDot(imperative(s.do));
  const name = isStr(s.uses) ? oneLine(s.uses).replace(/^(agent|mcp):/, '') : '';
  const named = name && new RegExp(`${escape(name)} (skill|sub-agents?|\\(MCP\\))`).test(what);
  return `${i + 1}. ${what}${name && !named ? `: use \`${name}\`` : ''}.`;
}

function playbookLines(p) {
  return [
    `### ${oneLine(p.name)}`,
    '',
    `When: ${noDot(p.when)}.${p.trigger?.length ? ` Opening prompts mention ${p.trigger.map((t) => `"${oneLine(t)}"`).join(', ')}.` : ''}`,
    '',
    ...p.steps.map(stepLine),
  ];
}

const ruleLine = (r) => `- ${noDot(r.text)}.`;

function checkLine(c) {
  const n = Math.round(c.rate * c.of);
  const scope = `${c.of} ${SCOPES[c.when]}`;
  // "Asks for proof": the agent should offer it unprompted.
  const ask = /^asks? for (.+)$/i.exec(oneLine(c.text));
  if (ask) return `- Show ${noDot(ask[1])} before they ask (they ask for it in ${n} of ${scope}).`;
  return `- ${noDot(imperative(c.text))} (they do this in ${n} of ${scope}).`;
}

// What the agent should do about the way they open tasks, as { key, line }. Only the habits worth acting on.
function openingLines(o) {
  if (!o || typeof o !== 'object') return [];
  const out = [];
  if (isRate(o.definesDone) && o.definesDone < 0.5) out.push({ key: 'definesDone', line: `- Before starting, restate what done looks like and confirm it (their openings say it ${pct(o.definesDone)} of the time).` });
  if (isRate(o.usesPlanFirst) && o.usesPlanFirst >= 0.5) out.push({ key: 'usesPlanFirst', line: `- Plan first and wait for their go-ahead before editing (they start with a plan ${pct(o.usesPlanFirst)} of the time).` });
  if (isRate(o.namesFiles) && o.namesFiles < 0.3) out.push({ key: 'namesFiles', line: `- Find the code it touches yourself before asking where it is (they name files ${pct(o.namesFiles)} of the time).` });
  else if (isRate(o.namesFiles) && o.namesFiles >= 0.6) out.push({ key: 'namesFiles', line: `- Start from the files they name (they name files ${pct(o.namesFiles)} of the time).` });
  if (isRate(o.withAttachment) && o.withAttachment >= 0.3) out.push({ key: 'withAttachment', line: `- Treat an attached screenshot or paste as the spec (they attach one ${pct(o.withAttachment)} of the time).` });
  if (isNum(o.medianWords) && o.medianWords > 0 && o.medianWords <= 20) out.push({ key: 'medianWords', line: `- Their openings are short (about ${Math.round(o.medianWords)} words): read the code first and ask only what it can't answer.` });
  else if (isNum(o.medianWords) && o.medianWords >= 60) out.push({ key: 'medianWords', line: `- Their openings are detailed (about ${Math.round(o.medianWords)} words): take the prompt as the spec and don't re-ask what it says.` });
  return out;
}

function skillHint(name) {
  const [plugin, skill] = name.split(':');
  return skill ? ` (skill \`${skill}\` from the \`${plugin}\` plugin; if it is missing, suggest \`/plugin install ${plugin}\`)` : '';
}

const fence = (text) => '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)));
const included = (c) => c && isStr(c.text) && c.include !== false;

// Each section renders its first n items, nothing at n = 0. Order is the PLAN v0.2 order; the cap trims
// from the bottom up and never touches the rules.
function sections(l, who) {
  const rules = l.rules ?? [];
  const checks = (l.checks ?? []).map(checkLine);
  const openings = openingLines(l.openings).map((o) => o.line);
  const k = l.kit;
  const kitItems = [
    ...k.skills.map((sk) => ({ group: 'skills', line: `- \`${oneLine(sk.name)}\`${isNum(sk.seen) ? `, used ${times(sk.seen)}` : ''}${skillHint(oneLine(sk.name))}` })),
    ...k.mcp.map((m) => ({ group: 'mcp', line: `- \`${oneLine(m.server)}\`${isNum(m.seen) ? `, used ${times(m.seen)}` : ''}` })),
    { group: 'agents', line: agentsLine(k.agents, who) },
  ];
  return [
    { keep: true, items: rules.length, render: (n) => ['## Rules they\'ve enforced', '', `Follow these. They come from times ${who} had to correct an agent.`, '', ...rules.slice(0, n).map(ruleLine), ''] },
    { items: checks.length, render: (n) => ['## How they check work', '', ...checks.slice(0, n), ''] },
    { items: openings.length, render: (n) => ['## How they open a task', '', ...openings.slice(0, n), ''] },
    { items: l.playbooks.length, render: (n) => ['## Playbooks', '', ...l.playbooks.slice(0, n).flatMap((p) => [...playbookLines(p), ''])] },
    { items: l.patterns.length, render: (n) => ['## How they ask', '', `${who} phrases requests and check-ins like this. Ask your own check-ins the same way.`, '', ...l.patterns.slice(0, n).flatMap((p) => [`> "${oneLine(p.text)}"`, ''])] },
    { items: kitItems.length, render: (n) => kitLines(kitItems.slice(0, n)) },
    { items: included(l.claudeMd) ? 1 : 0, render: () => {
      const text = l.claudeMd.text.replace(/\s+$/, '');
      return ['## Their CLAUDE.md', '', `${who}'s own standing instructions to Claude. Follow them unless this project's CLAUDE.md or the user says otherwise.`, '', `${fence(text)}markdown`, text, fence(text), ''];
    } },
  ];
}

function agentsLine(a, who) {
  if (!(a.share > 0)) return 'Subagents: they rarely use them. Do the work in the main session.';
  const parts = [`${possessive(who)} sessions use subagents ${pct(a.share)} of the time`];
  if (a.types.length) parts.push(`mostly ${a.types.map((t) => `\`${oneLine(t)}\``).join(', ')}`);
  if (a.models.length) parts.push(`on ${a.models.map((m) => `\`${oneLine(m)}\``).join(', ')}`);
  return `Subagents: ${parts.join(', ')}. Delegate the same kinds of work the same way.`;
}

function kitLines(items) {
  const of = (g) => items.filter((i) => i.group === g).map((i) => i.line);
  const out = ['## Kit', ''];
  if (of('skills').length) out.push('Skills:', '', ...of('skills'), '');
  if (of('mcp').length) out.push('MCP servers:', '', ...of('mcp'), '', 'If one is not connected, tell the user it can be added with `claude mcp add` and carry on without it.', '');
  out.push(...of('agents').flatMap((line) => [line, '']));
  return out;
}

export function renderLoadoutMd(loadout) {
  const l = loadout;
  const who = nameOf(l);
  const s = l.stats ?? {};
  const mined = isNum(s.sessions) && s.sessions > 0
    ? ` Mined from ${s.sessions} of their Claude Code sessions${isNum(s.days) && s.days > 0 ? ` over ${s.days} days` : ''} and approved by them.`
    : '';
  const how = ['Use it for every task in this session.'];
  if (l.rules?.length) how.push('The rules always apply.');
  if (l.checks?.length) how.push("Run the checks before you say you're done.");
  if (l.playbooks.length) how.push(`Follow a playbook only when the loadout sends one with a prompt. When it's offered, ask first and follow it only after a yes. Then say "following ${possessive(who)} loadout" once and follow its steps in order, with the skills, subagents and tools it names. Never invent steps they don't have. Commit, push, open a PR or deploy only when the user says so in this task, even inside a playbook.`);
  how.push('When nothing matches, work normally with the rest in mind.');
  const head = [`# ${possessive(who)} loadout`, '', `This is how ${who} works with Claude Code.${mined}`, '', how.join(' '), ''];

  const parts = sections(l, who);
  const counts = parts.map((p) => p.items);
  const render = () => [...head, ...parts.flatMap((p, i) => (counts[i] > 0 ? p.render(counts[i]) : []))].join('\n').replace(/\n+$/, '\n');
  let md = render();
  for (let i = parts.length - 1; i >= 0 && Buffer.byteLength(md) > MAX_LOADOUT_MD;) {
    if (parts[i].keep || counts[i] === 0) i--;
    else {
      counts[i]--;
      md = render();
    }
  }
  return md;
}

// What a matching prompt gets, small enough for UserPromptSubmit: the lead, each playbook's steps, the
// top rules, and the checks for those kinds of task. Over the cap, checks go first, then the end of the
// steps; never the rules.
function playbooksMd(loadout, playbooks, lead) {
  const rules = (loadout.rules ?? []).slice(0, 3).map(ruleLine);
  const ids = new Set(playbooks.map((p) => p.id));
  const checks = (loadout.checks ?? []).filter((c) => c.when === 'any' || ids.has(c.when)).map(checkLine);
  const body = [lead, '', ...playbooks.flatMap((p) => [...playbookLines(p), ''])].join('\n') + '\n';
  const tail = (n) => [
    ...(rules.length ? ['Their rules:', '', ...rules, ''] : []),
    ...(n ? ["Before you say it's done:", '', ...checks.slice(0, n), ''] : []),
  ].join('\n');
  let n = checks.length;
  while (n > 0 && body.length + tail(n).length > MAX_PLAYBOOK_MD) n--;
  const end = tail(n);
  const room = MAX_PLAYBOOK_MD - end.length;
  return ((body.length > room ? `${body.slice(0, room - 3)}…\n\n` : body) + end).replace(/\n+$/, '\n');
}

// The playbook to follow now (the `auto` mode).
export function renderPlaybookMd(loadout, playbook) {
  const who = possessive(nameOf(loadout));
  return playbooksMd(loadout, [playbook], `Following ${who} loadout: this prompt matches the playbook "${oneLine(playbook.name)}". Follow these steps in this order and never invent steps.`);
}

// A step in a few words, for the offer: the tool it names, else its verb phrase ("run tests").
function shortStep(s) {
  if (isStr(s.uses)) return oneLine(s.uses).replace(/^(agent|mcp):/, '').replace(/^[^:]+:/, '');
  const t = noDot(imperative(s.do));
  return t[0].toLowerCase() + t.slice(1);
}
const offerName = (p) => `**${oneLine(p.name)}** (${p.steps.map(shortStep).join(', ')})`;

// One or two playbooks offered, not accepted: the agent asks before following (the `ask` mode).
export function renderOfferMd(loadout, playbooks) {
  const who = possessive(nameOf(loadout));
  const question = playbooks.length === 1
    ? `${who} loadout has a playbook for this: ${offerName(playbooks[0])}. Want me to follow it?`
    : `${who} loadout has a playbook for this: ${playbooks.map(offerName).join(' or ')}. Which one, or neither?`;
  return playbooksMd(loadout, playbooks, [
    `${who} loadout has ${playbooks.length === 1 ? 'a playbook' : 'two playbooks'} for this prompt, offered, not accepted. Before anything else, ask the user in one line:`,
    '',
    `> ${question}`,
    '',
    "Follow the steps below only after a yes, and drop any step they rule out. A yes doesn't cover committing, pushing, opening a PR or deploying: ask again when you reach one. On any other reply, work normally and don't offer it again.",
  ].join('\n'));
}

const words = (text) => String(text).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];

function hits(trigger, prompt, promptWords) {
  const t = oneLine(trigger).toLowerCase();
  if (!t) return false;
  if (t.includes(' ')) return prompt.includes(t);
  // Exact word, or an inflection of a word of 3+ letters (fix -> fixes, fixing).
  return promptWords.some((w) => w === t || (t.length >= 3 && w.startsWith(t) && w.length - t.length <= 3));
}

// A task opening often leads with its verb ("Add a dark mode toggle"). That counts as a second hit,
// unless the prompt is short or points back at earlier work ("add it to the list too").
const LEADS = new Set(['please', 'can', 'could', 'you', "let's", 'lets']);
const POINTS_BACK = new Set(['it', 'that', 'them', 'those', 'too', 'also', 'again', 'same']);
function leadWord(promptWords) {
  if (promptWords.length < 4 || promptWords.some((w) => POINTS_BACK.has(w))) return null;
  return promptWords.find((w) => !LEADS.has(w)) ?? null;
}

// Playbooks by trigger hits, best first. A playbook needs two hits, or its only trigger.
export function playbooksFor(loadout, promptText, { limit = 2 } = {}) {
  const prompt = oneLine(promptText ?? '').toLowerCase();
  const promptWords = words(prompt);
  if (!promptWords.length || !Array.isArray(loadout?.playbooks)) return [];
  const lead = leadWord(promptWords);
  const scored = [];
  for (const p of loadout.playbooks) {
    const trig = [...new Set((p.trigger ?? []).map((t) => String(t).toLowerCase()))];
    const found = trig.filter((t) => hits(t, prompt, promptWords));
    const score = found.length + (lead && found.some((t) => hits(t, lead, [lead])) ? 1 : 0);
    if (score >= Math.min(2, trig.length) && score > 0) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.p.seen ?? 0) - (a.p.seen ?? 0));
  return scored.slice(0, limit).map((s) => s.p);
}

export const playbookFor = (loadout, promptText) => playbooksFor(loadout, promptText, { limit: 1 })[0] ?? null;

// Forgetting: one item of a loadout switched off by its user, kept in forgotten/<handle>.json as
// { items: [{ ref, text, at }] }, apart from packs/<handle>/ which `use` recopies.
const LISTS = [
  ['rule', (l) => l, 'rules', (r) => r.id, (r) => r.text],
  ['check', (l) => l, 'checks', (c) => c.id, (c) => c.text],
  ['playbook', (l) => l, 'playbooks', (p) => p.id, (p) => p.name],
  ['ask', (l) => l, 'patterns', (p) => slugOf(p.text), (p) => p.text],
  ['skill', (l) => l.kit, 'skills', (s) => s.name, (s) => s.name],
  ['mcp', (l) => l.kit, 'mcp', (m) => m.server, (m) => m.server],
];
const slugOf = (s) => oneLine(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Every item that can be forgotten, as { ref, text, item }: `ref` is kind:id, `item` the object in `l`
// (the openings object, with `key`, for open:<key>; the claudeMd object for claude-md).
export function forgettable(l) {
  const out = [];
  for (const [kind, parent, key, id, text] of LISTS) {
    for (const item of parent(l)?.[key] ?? []) out.push({ ref: `${kind}:${id(item)}`, text: oneLine(text(item)), item });
  }
  for (const { key, line } of openingLines(l.openings)) out.push({ ref: `open:${key}`, text: line.slice(2), item: l.openings, key });
  if (included(l.claudeMd)) out.push({ ref: 'claude-md', text: 'Their CLAUDE.md', item: l.claudeMd });
  return out;
}

// The entries of `l` that `forgotten` names: by ref, or by the same text when an id changed on rebuild.
export function forgottenIn(l, forgotten) {
  const refs = new Set(forgotten.map((f) => f.ref));
  const texts = new Set(forgotten.map((f) => oneLine(f.text ?? '').toLowerCase()).filter(Boolean));
  return forgettable(l).filter((e) => refs.has(e.ref) || texts.has(e.text.toLowerCase()));
}

// Pure: a copy of `l` without the forgotten items. Still a valid loadout.
export function withoutForgotten(loadout, forgotten = []) {
  const l = structuredClone(loadout);
  const gone = forgottenIn(l, forgotten);
  if (!gone.length) return l;
  const items = new Set(gone.map((e) => e.item));
  for (const [, parent, key] of LISTS) {
    const p = parent(l);
    if (Array.isArray(p?.[key])) p[key] = p[key].filter((i) => !items.has(i));
  }
  for (const e of gone) if (e.key) delete l.openings[e.key];
  if (items.has(l.claudeMd)) delete l.claudeMd;
  return l;
}

export const forgottenPath = (handle, home = loadoutHome()) => join(home, 'forgotten', `${handle}.json`);

// The forgotten items for a handle, [] when none or unreadable.
export function readForgotten(handle, home = loadoutHome()) {
  try {
    if (!HANDLE.test(handle)) return [];
    const items = JSON.parse(readFileSync(forgottenPath(handle, home), 'utf8')).items;
    return Array.isArray(items) ? items.filter((f) => f && isStr(f.ref)) : [];
  } catch {
    return [];
  }
}

const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'its', 'forget', 'restore', 'loadout', 'rule', 'check', 'playbook']);

// What `forget <words>` means among `items` ({ ref, text }): an exact ref, or the one item clearly sharing the most
// words with it (inflections count, as in playbookFor). Otherwise { candidates }, up to three, best first.
export function pickItem(items, query) {
  const q = oneLine(query).toLowerCase();
  const exact = items.find((i) => i.ref.toLowerCase() === q);
  if (exact) return { item: exact, candidates: [] };
  const qw = [...new Set(words(q).filter((w) => w.length >= 3 && !STOP.has(w)))];
  const scored = items.map((i) => {
    const t = `${i.ref.replace(/^[a-z-]+:/, '').replace(/-/g, ' ')} ${i.text}`.toLowerCase();
    return { i, score: qw.filter((w) => hits(w, t, words(t))).length };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const [a, b] = scored;
  if (a && a.score >= Math.min(2, qw.length) && !(b && b.score === a.score)) return { item: a.i, candidates: [] };
  return { item: null, candidates: scored.slice(0, 3).map((s) => s.i) };
}

function readmeCard(l) {
  const who = nameOf(l);
  const s = l.stats ?? {};
  const lines = [`# ${possessive(who)} loadout`, '', 'Work the way they work.', ''];
  if (isNum(s.sessions)) lines.push(`Mined from ${s.sessions} Claude Code sessions${isNum(s.days) ? ` over ${s.days} days` : ''}. ${l.rules?.length ? `${l.rules.length} rules, ` : ''}${l.playbooks.length} playbooks, ${l.patterns.length} ways of asking, ${l.kit.skills.length} skills.`, '');
  lines.push('Playbooks:', '');
  for (const p of l.playbooks) lines.push(`- **${oneLine(p.name)}**: ${noDot(p.when)}`);
  lines.push('', '## Use it', '', 'In Claude Code, with the loadout plugin installed:', '', '```', `/loadout:use ${l.handle}`, '```', '', `Or from a terminal: \`loadout use ./${l.handle}.loadout\`. \`/loadout:off\` turns it off.`, '');
  return lines.join('\n');
}

export async function writePack(loadout, outDir) {
  const errors = validate(loadout);
  if (errors.length) throw new Error(`invalid loadout: ${errors.join('; ')}`);
  const dir = join(outDir, `${loadout.handle}.loadout`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'loadout.json'), `${JSON.stringify(loadout, null, 2)}\n`);
  await writeFile(join(dir, 'LOADOUT.md'), renderLoadoutMd(loadout));
  await writeFile(join(dir, 'README.md'), readmeCard(loadout));
  return dir;
}

// A pack folder, or a loadout.json file directly.
export async function readPack(path) {
  const file = (await stat(path)).isDirectory() ? join(path, 'loadout.json') : path;
  const loadout = JSON.parse(await readFile(file, 'utf8'));
  const errors = validate(loadout);
  if (errors.length) throw new Error(`invalid loadout in ${file}: ${errors.join('; ')}`);
  return loadout;
}
