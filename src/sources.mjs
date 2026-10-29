// Where each kit item comes from, read from the owner's Claude config dir: an installed plugin (and its
// marketplace), a skill that ships with Claude Code, or one only on their machine. Personal skill folders are
// read here too, so the owner can bundle one. Never records paths, versions or commit SHAs.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactText } from './redact.mjs';

export const MAX_SKILL_BYTES = 64 * 1024;
const SAFE = /^[\w.-]+$/;
const safeName = (s) => SAFE.test(s) && s !== '.' && s !== '..';
const holeFree = (s, ctx) => redactText(s, ctx).text === s;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// { plugins: Map<plugin, [marketplace]>, marketplaces: { name: source } } from the plugin files, empty when missing.
export function readPlugins(claudeDir) {
  const installed = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'))?.plugins;
  const plugins = new Map();
  for (const key of Object.keys(installed && typeof installed === 'object' ? installed : {}).sort()) {
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const plugin = key.slice(0, at);
    plugins.set(plugin, [...(plugins.get(plugin) ?? []), key.slice(at + 1)]);
  }
  const known = readJson(join(claudeDir, 'plugins', 'known_marketplaces.json'));
  return { plugins, marketplaces: known && typeof known === 'object' ? known : {} };
}

// A marketplace's public home: { repo } for GitHub, { url } for another public https git host, else {}.
function home(source, ctx) {
  let repo = source?.source === 'github' && typeof source.repo === 'string' ? source.repo : null;
  let url = null;
  if (!repo && source?.source === 'git' && typeof source.url === 'string') {
    const m = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source.url);
    if (m && m[1] === 'github.com') repo = m[2];
    else if (m) url = `https://${m[1]}/${m[2]}`;
  }
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && holeFree(repo, ctx)) return { repo };
  if (url && holeFree(url.replace(/^https:\/\/[^/]+\//, ''), ctx)) return { url };
  return {};
}

// Claude Code's own marketplace is public whatever the owner's repos are called (a repo part like "claude" is a name
// to the redactor).
const OFFICIAL = { 'claude-plugins-official': 'anthropics/claude-plugins-official' };

function pluginSource(plugin, { plugins, marketplaces }, ctx) {
  const marketplace = plugins.get(plugin)?.[0];
  const official = OFFICIAL[marketplace];
  if (official && marketplaces[marketplace]?.source?.repo === official) return { kind: 'plugin', plugin, marketplace, repo: official };
  if (!marketplace || !holeFree(marketplace, ctx)) return { kind: 'plugin', plugin };
  return { kind: 'plugin', plugin, marketplace, ...home(marketplaces[marketplace]?.source, ctx) };
}

// A personal skill folder's text files as [{ path, text }], redacted, SKILL.md first; null when it has none,
// holds a file that isn't text, or is over the cap. Links inside the folder are skipped.
export function skillFiles(dir, ctx = {}) {
  let root;
  try {
    root = realpathSync(dir);
    if (!statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  const files = [];
  let size = 0;
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        size += st.size;
        if (size > MAX_SKILL_BYTES) throw new Error('too big');
        const buf = readFileSync(join(root, path));
        const text = buf.toString('utf8');
        if (buf.includes(0) || text.includes('�')) throw new Error('not text');
        // A file named after a private repo would carry the name in the pack.
        if (holeFree(path, ctx)) files.push({ path, text: redactText(text, ctx).text });
      }
    }
  };
  try {
    walk('');
  } catch {
    return null;
  }
  files.sort((a, b) => (b.path === 'SKILL.md') - (a.path === 'SKILL.md'));
  return files[0]?.path === 'SKILL.md' ? files : null;
}

// MCP servers Claude Code itself provides (the Chrome extension, the desktop app's browser and preview).
const BUILTIN_MCP = new Set(['claude-in-chrome', 'Claude_Browser', 'Claude_Preview', 'computer-use']);

// Adds `source` to each kit skill and MCP server (and `files` to personal skills that can be bundled, off until
// the owner switches Bundle on). `ctx` is the redaction context: a marketplace, repo or file with a private name in it
// is left out.
export function withSources(kit, claudeDir, ctx = {}) {
  const installed = readPlugins(claudeDir);
  const skills = (kit.skills ?? []).map((s) => {
    const [plugin, skill] = String(s.name).split(':');
    if (skill) return { ...s, source: pluginSource(plugin, installed, ctx) };
    const dir = join(claudeDir, 'skills', s.name);
    let mine = false;
    try {
      mine = safeName(s.name) && statSync(dir).isDirectory();
    } catch {}
    if (!mine) return { ...s, source: { kind: 'builtin' } };
    const files = skillFiles(dir, ctx);
    return { ...s, source: { kind: 'personal', bundled: false }, ...(files ? { files } : {}) };
  });
  // Plugin MCP servers are named plugin_<plugin>_<server>; the longest installed plugin that fits wins.
  const norm = (p) => p.replace(/[^A-Za-z0-9]/g, '_');
  const names = [...installed.plugins.keys()].sort((a, b) => b.length - a.length);
  const mcp = (kit.mcp ?? []).map((m) => {
    const server = String(m.server);
    if (BUILTIN_MCP.has(server)) return { ...m, source: { kind: 'builtin' } };
    if (!server.startsWith('plugin_')) return { ...m, source: { kind: 'personal' } };
    const plugin = names.find((p) => server.startsWith(`plugin_${norm(p)}_`)) ?? /^plugin_([^_]+)_/.exec(server)?.[1];
    return { ...m, source: plugin ? pluginSource(plugin, installed, ctx) : { kind: 'personal' } };
  });
  return { ...kit, skills, mcp };
}
