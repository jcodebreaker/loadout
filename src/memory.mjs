// Read Claude Code auto-memory (~/.claude/projects/*/memory/*.md) into the feedback memories loadout turns into
// rules. The format is internal: frontmatter with `name`, `description` and a nested `metadata` block that holds
// `type`. A file that doesn't parse is skipped, never thrown, like sessions.mjs.
import { open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const RULE_MAX = 140;

// [{ name, type, description, why, body, modified, project, repoName }]. `project` is the project dir; `repoName` is the
// basename of the cwd its sessions ran in (the dir name is the path with "/" as "-", which can't be undone),
// else the dir name's last part.
export async function readMemories({ dir = '~/.claude/projects' } = {}) {
  const root = dir.replace(/^~(?=$|\/)/, homedir());
  const out = [];
  for (const project of await list(root)) {
    const files = (await list(join(root, project, 'memory'))).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    if (!files.length) continue;
    const repoName = (await cwdName(join(root, project))) ?? fallbackName(project);
    for (const file of files) {
      try {
        const m = parseMemory(await readFile(join(root, project, 'memory', file), 'utf8'));
        if (m) out.push({ ...m, name: m.name || file.slice(0, -3), project, repoName });
      } catch {}
    }
  }
  return out;
}

// Pure: { name, type, description, why, body, modified } or null when there is no frontmatter or no description.
export function parseMemory(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) return null;
  const top = {};
  let parent = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, key, raw] = kv;
    if (indent && parent) { top[parent][key] = unquote(raw); continue; }
    parent = raw.trim() ? null : key;
    top[key] = raw.trim() ? unquote(raw) : {};
  }
  const meta = top.metadata && typeof top.metadata === 'object' ? top.metadata : {};
  const type = meta.type ?? top.type; // the documented shape has it at the top level
  const description = typeof top.description === 'string' ? top.description.trim() : '';
  if (!description) return null;
  const body = m[2].trim();
  const why = /\*\*Why:\*\*\s*([^\n]+)/.exec(body)?.[1].trim() || null;
  const modified = typeof meta.modified === 'string' ? meta.modified : null;
  return { name: typeof top.name === 'string' ? top.name : '', type: typeof type === 'string' ? type : null, description, why, body, modified };
}

function unquote(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { return v.replace(/^"|"$/g, ''); }
  }
  if (v.startsWith("'")) return v.replace(/^'|'$/g, '').replace(/''/g, "'");
  return v;
}

// A description as a rule: "The user wants X" becomes "Prefer X", "...does not want X" becomes "Avoid X", and
// anything over 140 chars is cut at the last clause break that fits, else at a word with "…".
const LEADS = [
  [/^standing instruction(?:\s*\([^)]*\))?:\s*/i, ''],
  [/^(?:the )?user (?:does not|doesn't|do not) want (?:you to )?/i, 'Avoid '],
  [/^(?:the )?user (?:wants|expects|requires|prefers|likes|asks for) /i, 'Prefer '],
];
export function memoryRule(description) {
  let s = String(description).replace(/\s+/g, ' ').trim();
  for (const [re, to] of LEADS) s = s.replace(re, to);
  s = s.replace(/[.\s]+$/, '');
  if (s.length > RULE_MAX) {
    const breaks = [...s.matchAll(/[;.](?= )| [—–] /g)].map((b) => b.index).filter((i) => i > 0 && i <= RULE_MAX);
    s = breaks.length ? s.slice(0, breaks.pop()) : `${s.slice(0, s.lastIndexOf(' ', RULE_MAX - 1))}…`;
  }
  return s && s[0].toUpperCase() + s.slice(1);
}

// The cwd basename in the project's first session file that names one (read only the file's head).
async function cwdName(projectDir) {
  for (const file of (await list(projectDir)).filter((f) => f.endsWith('.jsonl')).slice(0, 3)) {
    let fh;
    try {
      fh = await open(join(projectDir, file));
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(65_536), 0, 65_536, 0);
      const cwd = /"cwd":"((?:[^"\\]|\\.)+)"/.exec(buffer.toString('utf8', 0, bytesRead))?.[1];
      if (cwd) return basename(JSON.parse(`"${cwd}"`));
    } catch {} finally { await fh?.close(); }
  }
  return null;
}

const fallbackName = (project) => project.split('-').filter(Boolean).pop() || null;

async function list(path) {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}
