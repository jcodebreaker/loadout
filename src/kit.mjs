// The loader's side of a loadout's kit: what of it this machine already has, what to say about the rest, and the
// skill folders a pack bundles. Reads Claude Code's own files for names only, never their contents.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installLines, kitSource, nameOf, possessive } from './pack.mjs';

export const MAX_SKILL_BYTES = 64 * 1024;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o) : []);
const dirs = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

// What `claude` (a Claude config dir) has: installed plugins as "plugin@marketplace", known marketplaces, personal
// skills and MCP servers by name. ~/.claude.json sits next to ~/.claude, or inside CLAUDE_CONFIG_DIR.
export function installedKit(claude) {
  const config = readJson(claude === join(homedir(), '.claude') ? join(homedir(), '.claude.json') : join(claude, '.claude.json')) ?? {};
  return {
    plugins: new Set(keys(readJson(join(claude, 'plugins', 'installed_plugins.json'))?.plugins)),
    marketplaces: new Set(keys(readJson(join(claude, 'plugins', 'known_marketplaces.json')))),
    skills: new Set(dirs(join(claude, 'skills'))),
    mcp: new Set([...keys(config.mcpServers), ...Object.values(config.projects ?? {}).flatMap((p) => keys(p?.mcpServers))]),
  };
}

const hasPlugin = (have, src) => (src.marketplace ? have.plugins.has(`${src.plugin}@${src.marketplace}`) : [...have.plugins].some((k) => k.startsWith(`${src.plugin}@`)));

// What the kit needs that `have` lacks: { count, lines }, marketplace adds first, then installs, then bundled
// skills, then what only the owner has. Items without a source are left out: nothing is known about them.
export function missingKit(loadout, have) {
  const who = possessive(nameOf(loadout));
  const adds = new Set(), installs = new Set(), bundled = [], personal = [];
  let count = 0;
  const items = [...loadout.kit.skills.map((s) => [s.name, s, have.skills]), ...loadout.kit.mcp.map((m) => [m.server, m, have.mcp])];
  for (const [name, item, own] of items) {
    const src = kitSource(item);
    const shown = String(name).replace(/\s+/g, ' ');
    if (!src || src.kind === 'builtin') continue;
    if (src.kind === 'plugin') {
      if (hasPlugin(have, src)) continue;
      const lines = installLines(src);
      installs.add(lines.pop());
      if (lines.length && !have.marketplaces.has(src.marketplace)) adds.add(lines[0]);
    } else {
      if (own.has(name)) continue;
      if (src.bundled) bundled.push(`${shown}: bundled — \`loadout skills ${loadout.handle}\` installs it`);
      else personal.push(`${shown}: only on ${who} machine — that step runs the plain way`);
    }
    count++;
  }
  return { count, lines: [...adds, ...installs, ...bundled, ...personal] };
}

// The skill folders a pack bundles: kit skills marked bundled whose skills/<name>/SKILL.md is there, as
// { name, dir, files }. Regular files only, no links, and the whole folder within the size cap.
export function bundledSkills(loadout, packDir) {
  const out = [];
  for (const sk of loadout.kit.skills) {
    if (!kitSource(sk)?.bundled) continue;
    const dir = join(packDir, 'skills', sk.name);
    const files = [];
    let size = 0;
    const walk = (rel) => {
      for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) {
          files.push(path);
          size += lstatSync(join(dir, path)).size;
        } else throw new Error('not a plain file');
      }
    };
    try {
      if (lstatSync(dir).isSymbolicLink()) continue;
      walk('');
    } catch {
      continue;
    }
    if (files.includes('SKILL.md') && size <= MAX_SKILL_BYTES) out.push({ name: sk.name, dir, files: files.sort() });
  }
  return out;
}

// Copies one bundled skill's files to `to`, which must not exist yet.
export function copySkill(skill, to) {
  if (existsSync(to)) throw new Error(`${to} already exists`);
  for (const f of skill.files) {
    mkdirSync(join(to, f, '..'), { recursive: true });
    cpSync(join(skill.dir, f), join(to, f));
  }
}
