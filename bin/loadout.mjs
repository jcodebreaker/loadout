#!/usr/bin/env node
// loadout: build your loadout from your own Claude Code sessions, review it, share it, use someone else's.
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUGGEST_MODES, forgettable, forgottenPath, loadoutHome, nameOf, pickItem, possessive, readActive, readForgotten, readPack, readSuggestMode, renderLoadoutMd, validate, withoutForgotten, writePack } from '../src/pack.mjs';
import { bundledSkills, copySkill, installedKit, missingKit } from '../src/kit.mjs';
import { claudeMdDraft, dropRedacted, forPack, markIncluded, switchOff } from '../src/clean.mjs';

const COUNTS = ['paths', 'secrets', 'emails', 'hosts', 'names', 'code', 'urls'];

const HELP = `loadout: work the way they work.

  loadout build [--handle maya] [--since 30d] [--llm] [--no-memory] [--no-claude-md] [--no-review]
                         mine your Claude Code sessions and memory into a draft, then review it
  loadout review [--handle maya]     open the review page for a draft
  loadout publish [--handle maya] [--out .]   write <handle>.loadout to share
  loadout use <handle|path>          load a loadout into Claude Code
  loadout skills <handle> [--yes]    install the skills a loadout bundles; without --yes, list them
  loadout off                        stop using it
  loadout list                       loadouts on this machine
  loadout status                     which loadout is on
  loadout forget [ref|words]         stop following one item; no argument lists them
  loadout restore [ref]              bring one back; no argument lists what you forgot
  loadout suggest ask|auto|off       on a matching prompt: offer the playbook (default),
                                     follow it without asking, or send nothing
  loadout recall "<words>"           what happened last time, from your own sessions
  loadout recall on|off              recall past work on matching prompts (default on)
  loadout doctor                     check setup, say what to do next
  loadout incognito <session-id>     leave a session out of your next build
  loadout recall --reindex [--since 90d]   rebuild the recall index of your past tasks

In Claude Code: /loadout:use maya, /loadout:off, /loadout:status, /loadout:forget, /loadout:recall, /loadout:doctor, /loadout:incognito.`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['handle', 'since', 'out'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { flags, rest };
}

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };
const home = loadoutHome();
// Claude Code's own config dir (it honours CLAUDE_CONFIG_DIR too).
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const incognitoPath = join(home, 'incognito.json');
const readIncognito = () => {
  try {
    const s = JSON.parse(readFileSync(incognitoPath, 'utf8')).sessions;
    return Array.isArray(s) ? s.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
};
const draftPath = (handle) => join(home, 'drafts', `${handle}.json`);
const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);

function gitUserName() {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function sinceDate(spec = '30d') {
  const m = /^(\d+)d$/.exec(String(spec));
  if (!m) fail(`--since takes days, like 30d (got "${spec}")`);
  return new Date(Date.now() - Number(m[1]) * 86_400_000);
}

function addCounts(total, removed) {
  for (const k of COUNTS) total[k] = (total[k] ?? 0) + (Number(removed?.[k]) || 0);
  return total;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function latestDraft() {
  const dir = join(home, 'drafts');
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.json')) : [];
  if (!files.length) fail('No draft yet. Run `loadout build` first.');
  const dated = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })));
  return join(dir, dated.sort((a, b) => b.t - a.t)[0].f);
}

const draftFor = async (flags) => (typeof flags.handle === 'string' ? draftPath(slug(flags.handle)) : latestDraft());

async function build(flags) {
  const name = gitUserName();
  const handle = slug(typeof flags.handle === 'string' ? flags.handle : name);
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(handle)) fail('Pick a handle: loadout build --handle maya');
  const displayName = typeof flags.handle === 'string' || !name ? handle : name.split(/\s+/)[0];

  const { readSessions } = await import('../src/sessions.mjs');
  const { readMemories, memoryRule } = await import('../src/memory.mjs');
  const { redactSession, redactDeep, redactText } = await import('../src/redact.mjs');
  const { mine } = await import('../src/mine.mjs');

  const found = await readSessions({ dir: join(claudeDir(), 'projects'), since: sinceDate(flags.since) });
  if (!found.length) fail('No Claude Code sessions found in ~/.claude/projects.');
  // Sessions the owner marked with /loadout:incognito never reach redaction or mining.
  const incognito = new Set(readIncognito());
  const sessions = found.filter((s) => !incognito.has(s.id));
  if (!sessions.length) fail('Every session found is incognito.');
  // Feedback memories are corrections Claude saved as rules. Their project's repo is a private name too.
  const feedback = flags['no-memory'] ? [] : (await readMemories({ dir: join(claudeDir(), 'projects') })).filter((m) => m.type === 'feedback');
  const ctx = { home: homedir(), repoNames: [...new Set([...sessions.map((s) => s.cwdName), ...feedback.map((m) => m.repoName)].filter(Boolean))], extraNames: [] };
  const removed = {};
  const clean = sessions.map((s) => {
    const r = redactSession(s, ctx);
    addCounts(removed, r.removed);
    return r.session;
  });
  // A memory whose rule or Why names a repo is about that repo: it starts off in review. The body is left out:
  // it often names the project a general lesson came from.
  const memories = feedback.map((m) => {
    const text = redactText(m.description, ctx);
    const why = m.why ? redactText(m.why, ctx) : null;
    addCounts(removed, text.removed);
    if (why) addCounts(removed, why.removed);
    return { text: memoryRule(text.text), why: why?.text ?? null, modified: m.modified, repo: redactText(`${m.description}\n${m.why ?? ''}`, { ...ctx, home: '' }).removed.names > 0 };
  });

  const mined = await mine(clean, { handle, displayName, llm: Boolean(flags.llm), memories });
  const deep = redactDeep(mined, ctx);
  addCounts(removed, deep.removed);
  // Items that were only a private name (an MCP server named after a repo) go, not ship as ‹name›.
  const { value: kept, dropped } = dropRedacted(deep.value);
  // Their own CLAUDE.md rides along redacted, but stays out of the pack until they switch it on in review.
  let claudeMd = null;
  const claudeMdPath = join(claudeDir(), 'CLAUDE.md');
  if (!flags['no-claude-md'] && existsSync(claudeMdPath)) {
    const r = claudeMdDraft(await readFile(claudeMdPath, 'utf8'), ctx);
    addCounts(removed, r.removed);
    claudeMd = r.claudeMd;
  }
  // Identity fields are the owner's own choice, not mined text.
  const loadout = markIncluded({ ...kept, claudeMd, handle, displayName, version: 1, builtAt: mined.builtAt, stats: mined.stats, removed });
  // What they forgot in their own loadout starts off, so a rebuild doesn't bring it back.
  switchOff(loadout, readForgotten(handle, home));

  const path = draftPath(handle);
  await mkdir(join(home, 'drafts'), { recursive: true });
  await writeFile(path, `${JSON.stringify(loadout, null, 2)}\n`);

  const s = loadout.stats ?? {};
  const k = loadout.kit ?? {};
  const rules = loadout.rules ?? [];
  const on = rules.filter((r) => r.include);
  const fromMemory = on.filter((r) => r.from === 'memory').length;
  const ruleNotes = [fromMemory && `${fromMemory} from memory`, rules.length > on.length && `+${rules.length - on.length} off`].filter(Boolean);
  console.log(`${plural(s.sessions ?? clean.length, 'session')} over ${plural(s.days ?? 0, 'day')}, ${plural(on.length, 'rule')}${ruleNotes.length ? ` (${ruleNotes.join(', ')})` : ''}, ${plural(loadout.checks?.length ?? 0, 'check')}, ${plural(loadout.playbooks?.length ?? 0, 'playbook')}, ${plural(loadout.patterns?.length ?? 0, 'pattern')}, ${plural(k.skills?.length ?? 0, 'skill')}, ${plural(k.mcp?.length ?? 0, 'MCP server')}.`);
  if (found.length > sessions.length) console.log(`Skipped ${plural(found.length - sessions.length, 'incognito session')}.`);
  if (claudeMd) console.log('Your CLAUDE.md is in the draft, off until you turn it on.');
  const gone = Object.values(dropped).reduce((a, b) => a + b, 0);
  const counts = COUNTS.filter((c) => removed[c]).map((c) => `${removed[c]} ${c}`);
  if (gone) counts.push(plural(gone, 'item') + ' named after them');
  console.log(counts.length ? `Removed ${counts.join(', ')}.` : 'Nothing private found to remove.');
  console.log(`Draft: ${tilde(path)}`);
  const errors = validate(forPack(loadout));
  if (errors.length) console.log(`Needs work before publishing: ${errors.join('; ')}`);
  if (!flags['no-review']) await review({ ...flags, handle });
}

async function review(flags) {
  const path = await draftFor(flags);
  if (!existsSync(path)) fail(`No draft at ${tilde(path)}. Run \`loadout build\` first.`);
  const { startReview } = await import('../src/review/server.mjs');
  const { close, done } = await startReview({ draftPath: path, open: true });
  const stop = () => close();
  process.once('SIGINT', stop);
  const { publish: ready } = await done;
  process.off('SIGINT', stop);
  if (ready) await publish({ ...flags, draft: path });
  else console.log("Draft saved. Run `loadout publish` when you're ready.");
}

async function publish(flags) {
  const path = flags.draft ?? (await draftFor(flags));
  if (!existsSync(path)) fail(`No draft at ${tilde(path)}. Run \`loadout build\` first.`);
  const loadout = forPack(await readJson(path));
  const errors = validate(loadout);
  if (errors.length) fail(`Not ready to publish:\n- ${errors.join('\n- ')}`);
  const dir = await writePack(loadout, resolve(typeof flags.out === 'string' ? flags.out : '.'));
  console.log(`Wrote ${tilde(dir)}`);
  console.log(`Share the folder. Others load it with: loadout use ${basename(dir)}`);
}

function looksLikePath(arg) {
  return arg.includes('/') || arg.endsWith('.loadout') || arg.endsWith('.json') || existsSync(arg);
}

async function use(arg) {
  if (!arg) fail('Usage: loadout use <handle|path>');
  let source;
  if (looksLikePath(arg)) source = resolve(arg);
  else if (existsSync(join(home, 'packs', arg))) source = join(home, 'packs', arg);
  else if (existsSync(`${arg}.loadout`)) source = resolve(`${arg}.loadout`);
  else if (existsSync(draftPath(arg))) source = draftPath(arg);
  // Examples ship with the plugin, so `/loadout:use maya` works right after install.
  else if (existsSync(new URL(`../docs/example/${arg}.loadout`, import.meta.url))) source = fileURLToPath(new URL(`../docs/example/${arg}.loadout`, import.meta.url));
  else fail(`No loadout called "${arg}". Pass the path to a .loadout folder.`);
  if (!existsSync(source)) fail(`Nothing at ${tilde(source)}.`);

  const isDir = (await stat(source)).isDirectory();
  const loadout = forPack(await readJson(isDir ? join(source, 'loadout.json') : source));
  const errors = validate(loadout);
  if (errors.length) fail(`Not a valid loadout:\n- ${errors.join('\n- ')}`);
  const dest = join(home, 'packs', loadout.handle);
  if (resolve(source) !== resolve(dest)) {
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    if (isDir && existsSync(join(source, 'README.md'))) await cp(join(source, 'README.md'), join(dest, 'README.md'));
    await writeFile(join(dest, 'loadout.json'), `${JSON.stringify(loadout, null, 2)}\n`);
    if (isDir) for (const skill of bundledSkills(loadout, source)) copySkill(skill, join(dest, 'skills', skill.name));
  }
  const shown = await renderActive(loadout, dest);
  await writeFile(join(home, 'active.json'), `${JSON.stringify({ handle: loadout.handle, path: dest, since: new Date().toISOString() }, null, 2)}\n`);
  console.log(`Using ${loadout.handle}'s loadout: ${playbooks(shown)}.`);
  const { lines } = missingKit(shown, installedKit(claudeDir()));
  if (lines.length) console.log([`Missing for ${possessive(nameOf(shown))} playbooks:`, ...lines.map((l) => `  ${l}`)].join('\n'));
}

// A loadout is someone else's instructions: without --yes, only say what would be written.
async function skills(handle, flags) {
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(handle ?? '')) fail('Usage: loadout skills <handle> [--yes]');
  const dir = join(home, 'packs', handle);
  if (!existsSync(dir)) fail(`No loadout called "${handle}" is installed. \`loadout use\` it first.`);
  const loadout = await readPack(dir);
  const found = bundledSkills(loadout, dir);
  if (!found.length) return console.log(`${loadout.handle}'s loadout bundles no skills.`);
  for (const skill of found) {
    const to = join(claudeDir(), 'skills', skill.name);
    if (existsSync(to)) console.log(`Skipped ${skill.name}: ${tilde(to)} already exists.`);
    else if (!flags.yes) console.log(`${skill.name}: ${tilde(skill.dir)} → ${tilde(to)} (${skill.files.join(', ')})`);
    else {
      copySkill(skill, to);
      console.log(`Installed ${skill.name} in ${tilde(to)}`);
    }
  }
  if (!flags.yes && found.some((sk) => !existsSync(join(claudeDir(), 'skills', sk.name)))) console.log(`\`loadout skills ${loadout.handle} --yes\` installs them.`);
}

const playbooks = (l) => `${plural(l.playbooks.length, 'playbook')}${l.playbooks.length ? ` (${l.playbooks.map((p) => p.name).join(', ')})` : ''}`;

// Always render LOADOUT.md from loadout.json, so a hand-edited copy can't say something else, and without
// what the user forgot. Returns the loadout as shown.
async function renderActive(loadout, dir) {
  const shown = withoutForgotten(loadout, readForgotten(loadout.handle, home));
  await writeFile(join(dir, 'LOADOUT.md'), renderLoadoutMd(shown));
  return shown;
}

async function activePack() {
  const active = readActive(home);
  if (!active) fail('No loadout is on.');
  return { active, loadout: await readPack(active.path) };
}

async function saveForgotten(handle, items) {
  await mkdir(join(home, 'forgotten'), { recursive: true });
  await writeFile(forgottenPath(handle, home), `${JSON.stringify({ items }, null, 2)}\n`);
}

const listing = (items) => items.map((i) => `${i.ref}  ${i.text}`).join('\n');

// Which item `words` means, or a list of the closest ones and nothing changed.
function pickOrList(items, words, cmd) {
  const { item, candidates } = pickItem(items, words);
  if (item) return item;
  console.log(candidates.length ? `Which one? Run \`loadout ${cmd} <ref>\`:\n${listing(candidates)}` : `Nothing matches "${words}". \`loadout ${cmd}\` lists them.`);
  return null;
}

async function forget(words) {
  const { active, loadout } = await activePack();
  const forgotten = readForgotten(loadout.handle, home);
  const items = forgettable(withoutForgotten(loadout, forgotten));
  if (!words) return console.log(items.length ? listing(items) : 'Nothing left to forget.');
  const item = pickOrList(items, words, 'forget');
  if (!item) return;
  const entry = { ref: item.ref, text: item.text, at: new Date().toISOString() };
  await saveForgotten(loadout.handle, [...forgotten.filter((f) => f.ref !== item.ref), entry]);
  await renderActive(loadout, active.path);
  console.log(`Forgot "${item.text}" in ${loadout.handle}'s loadout. Ignore it from now on. \`loadout restore\` brings it back.`);
  // Their own loadout: correct the draft too, not just this session.
  const draft = draftPath(loadout.handle);
  if (existsSync(draft)) {
    const d = await readJson(draft);
    if (switchOff(d, [entry])) {
      await writeFile(draft, `${JSON.stringify(d, null, 2)}\n`);
      console.log('Off in your draft too. `loadout publish` to share the fix.');
    }
  }
}

async function restore(words) {
  const { active, loadout } = await activePack();
  const forgotten = readForgotten(loadout.handle, home);
  if (!words) return console.log(forgotten.length ? listing(forgotten) : 'Nothing forgotten.');
  const item = pickOrList(forgotten, words, 'restore');
  if (!item) return;
  await saveForgotten(loadout.handle, forgotten.filter((f) => f.ref !== item.ref));
  await renderActive(loadout, active.path);
  console.log(`Restored "${item.text}" in ${loadout.handle}'s loadout. Follow it again.`);
}

async function off() {
  const active = readActive(home);
  await rm(join(home, 'active.json'), { force: true });
  console.log(active ? `Stopped using ${active.handle}'s loadout.` : 'No loadout is on.');
}

async function list() {
  const active = readActive(home);
  const dir = join(home, 'packs');
  const handles = existsSync(dir) ? (await readdir(dir)).sort() : [];
  const rows = [];
  for (const h of handles) {
    try {
      const l = await readPack(join(dir, h));
      rows.push(`${active?.handle === l.handle ? '*' : ' '} ${l.handle}  ${plural(l.playbooks.length, 'playbook')}`);
    } catch {}
  }
  const drafts = existsSync(join(home, 'drafts')) ? (await readdir(join(home, 'drafts'))).filter((f) => f.endsWith('.json')) : [];
  if (!rows.length && !drafts.length) return console.log('No loadouts yet. `loadout use <path>` loads one, `loadout build` makes yours.');
  if (rows.length) console.log(rows.join('\n'));
  if (drafts.length) console.log(`Drafts: ${drafts.map((f) => f.slice(0, -5)).join(', ')}`);
}

async function status(flags) {
  const active = readActive(home);
  if (!active) return console.log('No loadout is on.');
  let loadout;
  try {
    loadout = await readPack(active.path);
  } catch {
    return console.log(`The active loadout (${active.handle}) is missing or broken. Run \`loadout off\` or \`loadout use\` again.`);
  }
  const forgotten = readForgotten(loadout.handle, home);
  const shown = withoutForgotten(loadout, forgotten);
  if (flags.md) return process.stdout.write(renderLoadoutMd(shown));
  const since = active.since ? ` since ${String(active.since).slice(0, 10)}` : '';
  console.log(`Using ${loadout.handle}'s loadout${since}: ${playbooks(shown)}.${forgotten.length ? ` ${forgotten.length} forgotten.` : ''}`);
  const mode = readSuggestMode(home);
  if (mode !== 'ask') console.log(`Playbook suggestions: ${mode}.`);
}

async function saveSetting(key, value) {
  const path = join(home, 'settings.json');
  let settings = {};
  try {
    settings = await readJson(path);
  } catch {}
  await mkdir(home, { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...settings, [key]: value }, null, 2)}\n`);
}

async function suggest(mode) {
  if (mode === undefined) return console.log(readSuggestMode(home));
  if (!SUGGEST_MODES.includes(mode)) fail(`Usage: loadout suggest ${SUGGEST_MODES.join('|')}`);
  await saveSetting('suggest', mode);
  console.log(`Playbook suggestions: ${mode}.`);
}

// Your own past tasks that match `words`, best first, from the local recall index.
async function recall(words, flags) {
  if (flags.reindex) {
    const { buildIndex } = await import('../src/recall/index.mjs');
    const r = await buildIndex({ home, claudeDir: claudeDir(), since: typeof flags.since === 'string' ? flags.since : '90d', full: true });
    return console.log(`Indexed ${plural(r.tasks, 'task')} from ${plural(r.sessions, 'session')}.`);
  }
  const { describe, day, readCandidates, recallFor, recallOn } = await import('../src/recall/query.mjs');
  if (words === 'on' || words === 'off') {
    await saveSetting('recall', words === 'on');
    return console.log(`Recall ${words}.`);
  }
  if (!words) return console.log(`Recall is ${recallOn(home) ? 'on' : 'off'}. Usage: loadout recall "<words>"`);
  const { tasks, counts } = readCandidates(words, { home, loose: true });
  if (!counts.n) return console.log('Nothing to recall yet. `loadout recall --reindex` reads your sessions.');
  const hits = recallFor(words, tasks, { repo: basename(process.cwd()), counts, limit: 5, loose: true });
  if (!hits.length) return console.log(`Nothing recalled for "${words}".`);
  console.log(hits.map(({ task }) => `${[day(task.at), task.repo].filter(Boolean).join(' · ')}\n  ${describe(task)}`).join('\n'));
}

async function doctorCmd() {
  const { doctor } = await import('../src/doctor.mjs');
  console.log((await doctor({ home, claude: claudeDir(), root: fileURLToPath(new URL('..', import.meta.url)) })).join('\n'));
}

// The skill passes ${CLAUDE_SESSION_ID}; without it, the session the hooks saw last.
async function incognito(id) {
  if (!/^[\w-]{8,}$/.test(id ?? '')) {
    try {
      id = JSON.parse(readFileSync(join(home, 'last-hook.json'), 'utf8')).session;
    } catch {}
  }
  if (!/^[\w-]{8,}$/.test(id ?? '')) fail('Usage: loadout incognito <session-id>');
  const sessions = [...new Set([...readIncognito(), id])];
  await mkdir(home, { recursive: true });
  await writeFile(incognitoPath, `${JSON.stringify({ sessions }, null, 2)}\n`);
  const { purgeSessions } = await import('../src/recall/index.mjs');
  purgeSessions([id], home);
  console.log('This session stays out of your loadout.');
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseArgs(argv);
  switch (cmd) {
    case 'build': return build(flags);
    case 'review': return review(flags);
    case 'publish': return publish(flags);
    case 'use': return use(rest[0]);
    case 'skills': return skills(rest[0], flags);
    case 'off': return off();
    case 'list': return list();
    case 'status': return status(flags);
    case 'suggest': return suggest(rest[0]);
    case 'recall': return recall(rest.join(' ').trim(), flags);
    case 'forget': return forget(rest.join(' '));
    case 'restore': return restore(rest.join(' '));
    case 'doctor': return doctorCmd();
    case 'incognito': return incognito(rest[0]);
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    default: fail(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main().catch((err) => {
  console.error(err instanceof UserError ? err.message : `loadout: ${err.message}`);
  process.exit(1);
});
