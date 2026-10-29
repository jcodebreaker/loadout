import { MAX_CLAUDE_MD, MAX_RULES, forgottenIn } from './pack.mjs';
import { redactText } from './redact.mjs';

// After redactDeep, drop what only made sense with the private name it carried: a kit item named
// after a private repo, a step that became just "‹name›", a pattern with a hole in it.
const HOLE = /‹\w+›/;
const hollow = (s) => typeof s === 'string' && HOLE.test(s) && !/\w/.test(s.replace(/‹\w+›/g, ''));

// Pure: returns { value, dropped } where dropped counts removed kit items, steps, patterns, rules, checks and playbooks.
export function dropRedacted(loadout) {
  const l = structuredClone(loadout);
  const dropped = { skills: 0, mcp: 0, steps: 0, patterns: 0, rules: 0, checks: 0, playbooks: 0 };
  const keep = (list, key, ok) => {
    if (!Array.isArray(list)) return list;
    const kept = list.filter(ok);
    dropped[key] += list.length - kept.length;
    return kept;
  };
  if (l.kit) {
    l.kit.skills = keep(l.kit.skills, 'skills', (s) => !HOLE.test(s?.name ?? ''));
    l.kit.mcp = keep(l.kit.mcp, 'mcp', (m) => !HOLE.test(m?.server ?? m?.name ?? ''));
  }
  l.patterns = keep(l.patterns, 'patterns', (p) => !HOLE.test(p?.text ?? ''));
  l.rules = keep(l.rules, 'rules', (r) => !HOLE.test(r?.text ?? ''));
  l.checks = keep(l.checks, 'checks', (c) => !HOLE.test(c?.text ?? ''));
  if (Array.isArray(l.playbooks)) {
    for (const p of l.playbooks) p.steps = keep(p.steps, 'steps', (st) => !HOLE.test(st?.uses ?? '') && !hollow(st?.do));
    l.playbooks = keep(l.playbooks, 'playbooks', (p) => !Array.isArray(p.steps) || p.steps.length > 0);
  }
  return { value: l, dropped };
}

// The owner's ~/.claude/CLAUDE.md for the draft: redacted, cut at a line to fit the cap, off until they turn it on.
export function claudeMdDraft(text, ctx) {
  const { text: clean, removed } = redactText(String(text), ctx);
  const lines = [];
  let size = 0;
  for (const line of clean.trim().split('\n')) {
    size += Buffer.byteLength(line) + 1;
    if (size > MAX_CLAUDE_MD - 4) { lines.push('…'); break; }
    lines.push(line);
  }
  const out = lines.join('\n').trim();
  return { claudeMd: out ? { text: `${out}\n`, include: false } : null, removed };
}

// The review page toggles `include` on these. Drafts carry the flag; packs never do.
const TOGGLED = [(l) => l.playbooks, (l) => l.patterns, (l) => l.rules, (l) => l.kit?.skills, (l) => l.kit?.mcp];

export function markIncluded(loadout) {
  // A correction said in only one session stays off until the owner switches it on. Only the first MAX_RULES
  // that are on stay on, so a fresh draft publishes as is; the rest wait in the draft.
  let on = 0;
  for (const r of loadout.rules ?? []) {
    r.include ??= r.seen !== 1;
    if (r.include && ++on > MAX_RULES) r.include = false;
  }
  for (const get of TOGGLED) for (const item of get(loadout) ?? []) item.include ??= true;
  if (loadout.claudeMd) loadout.claudeMd.include ??= false;
  return loadout;
}

// The owner forgot these in their own loadout: switch them off in the draft (openings have no switch).
// Returns how many were on.
export function switchOff(draft, forgotten) {
  let n = 0;
  for (const { item, key } of forgottenIn(draft, forgotten)) {
    if (key || item.include === false) continue;
    item.include = false;
    n++;
  }
  return n;
}

// A draft as it ships: items switched off are gone, no flags. CLAUDE.md stays only when the owner turned it on
// (a draft always carries the flag; a pack has already dropped it).
export function forPack(draft) {
  const l = structuredClone(draft);
  const keep = (list) => (Array.isArray(list) ? list.filter((i) => i?.include !== false).map(({ include, ...rest }) => rest) : list);
  l.playbooks = keep(l.playbooks);
  l.patterns = keep(l.patterns);
  // A memory's Why is for the owner reviewing it, never packed.
  if (l.rules !== undefined) l.rules = keep(l.rules);
  if (l.checks !== undefined) l.checks = keep(l.checks);
  if (Array.isArray(l.rules)) l.rules = l.rules.map(({ why, ...rest }) => rest);
  // A personal skill's files go only when the owner switched Bundle on; writePack moves them out of loadout.json.
  const bundle = (s) => {
    if (s?.source?.kind !== 'personal') return s;
    const { files, ...rest } = s;
    const on = s.source.bundled === true && Array.isArray(files) && files.length > 0;
    return { ...rest, source: { kind: 'personal', bundled: on }, ...(on ? { files } : {}) };
  };
  if (l.kit) l.kit = { ...l.kit, skills: Array.isArray(l.kit.skills) ? keep(l.kit.skills).map(bundle) : l.kit.skills, mcp: keep(l.kit.mcp) };
  if (l.claudeMd && l.claudeMd.include !== false && typeof l.claudeMd.text === 'string') l.claudeMd = { text: l.claudeMd.text };
  else delete l.claudeMd;
  return l;
}
