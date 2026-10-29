// `loadout doctor`: one line per check, the fix on failures, then one "Next:" line, which is the whole
// setup checklist. Reads ~/.claude (settings, sessions, memory) for counts only; never prints their text.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedKit, missingKit } from './kit.mjs';
import { MAX_LOADOUT_MD, readActive, readForgotten, readPack, withoutForgotten } from './pack.mjs';
import { readSessions } from './sessions.mjs';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const dirs = (path) => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

// Auto-memory files whose frontmatter says `type: feedback`, at the top level or nested under `metadata`.
function feedbackMemories(projects) {
  let n = 0;
  for (const proj of dirs(projects)) {
    for (const f of dirs(join(projects, proj, 'memory'))) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      try {
        const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(projects, proj, 'memory', f), 'utf8'))?.[1] ?? '';
        if (/^\s*type:\s*['"]?feedback['"]?\s*$/m.test(front)) n++;
      } catch {}
    }
  }
  return n;
}

// [{ mark, text, next }]: ✓ pass, ! warn, ✗ fail (its `next` becomes the Next line), · information.
export async function doctor({ home, claude, root, days = 30 }) {
  const out = [];
  const add = (mark, text, next) => out.push({ mark, text, next });
  const settings = readJson(join(claude, 'settings.json')) ?? {};

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) add('✓', `Node ${process.versions.node.split('.').slice(0, 2).join('.')}`);
  else add('✗', `Node ${process.versions.node}. Loadout needs Node 22 or later.`, 'install Node 22 or later');

  const sessions = await readSessions({ dir: join(claude, 'projects'), since: new Date(Date.now() - days * 86_400_000) });
  const typed = sessions.filter((s) => s.events.some((e) => e.kind === 'prompt')).length;
  if (typed) add('✓', `${plural(sessions.length, 'session')} over ${days} days (${typed} typed by you)`);
  else add('!', `${plural(sessions.length, 'session')} over ${days} days, none typed by you. Nothing to mine yet.`);

  const keep = settings.cleanupPeriodDays;
  if (!(Number(keep) >= 30)) add('!', `Claude Code deletes sessions after ${Number(keep) > 0 ? keep : 30} days. Set cleanupPeriodDays in ~/.claude/settings.json to keep more.`);
  else add('✓', `Sessions kept ${keep} days`);

  const memories = feedbackMemories(join(claude, 'projects'));
  add(memories ? '✓' : '·', memories ? `${memories} feedback ${memories === 1 ? 'memory' : 'memories'}` : 'No feedback memories');

  // A stamp from the hooks means the plugin runs, even when loaded with --plugin-dir rather than installed.
  const lastHook = readJson(join(home, 'last-hook.json'));
  const plugin = Boolean(lastHook) || Object.entries(settings.enabledPlugins ?? {}).some(([k, v]) => k.startsWith('loadout@') && v);
  const hooks = readJson(join(root, 'hooks', 'hooks.json'))?.hooks ?? {};
  const hooksOk = Boolean(hooks.SessionStart && hooks.UserPromptSubmit);
  if (plugin && hooksOk) add('✓', 'Plugin on, hooks installed');
  else if (!plugin) add('✗', 'Plugin off. In Claude Code: /plugin install loadout@loadout', '/plugin install loadout@loadout');
  else add('✗', 'Hooks missing. Reinstall the plugin.', '/plugin install loadout@loadout');

  const active = readActive(home);
  if (!active && existsSync(join(home, 'active.json'))) {
    add('✗', 'active.json is broken. Run `loadout off`.', 'loadout off');
  } else if (active) {
    let problem = null;
    let missing = 0;
    try {
      const loadout = await readPack(active.path);
      missing = missingKit(withoutForgotten(loadout, readForgotten(loadout.handle, home)), installedKit(claude)).count;
      if (Buffer.byteLength(readFileSync(join(active.path, 'LOADOUT.md'))) > MAX_LOADOUT_MD) problem = 'LOADOUT.md is over 8 KB';
    } catch {
      problem = 'is missing or broken';
    }
    const ran = Date.parse(lastHook?.at) >= Date.parse(active.since);
    if (problem) add('✗', `${active.handle}'s loadout ${problem}. Run \`loadout use\` again.`, `loadout use ${active.handle}`);
    else if (!ran) add('✗', `${active.handle}'s loadout is on, but the hooks haven't run since. Restart Claude Code.`, 'restart Claude Code');
    else add('✓', `${active.handle}'s loadout is on and injected`);
    if (!problem && missing) add('!', `${active.handle}'s kit: ${plural(missing, 'tool')} missing. \`loadout use ${active.handle}\` lists them.`);
  }

  const failed = out.find((c) => c.mark === '✗');
  const drafts = dirs(join(home, 'drafts')).filter((f) => f.endsWith('.json'));
  const next = failed?.next
    ?? (active ? 'start a task'
      : drafts.length ? 'loadout review, then publish and share the folder'
      : typed ? 'loadout build, or /loadout:use <handle> to try someone else\'s'
      : 'work a few sessions in Claude Code, or /loadout:use <handle> to try someone else\'s');
  return [...out.map((c) => `${c.mark} ${c.text}`), `Next: ${next}`];
}
