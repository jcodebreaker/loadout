// Read Claude Code session logs (~/.claude/projects) into Session[] with only the events loadout mines.
// The JSONL format is internal and shifts between releases, so every line is parsed defensively and a bad
// file is skipped, never thrown. Tool inputs and outputs are read only to classify a call, never stored.
// `detail` (local recall only, never mined or shared) also keeps the session's cwd, each prompt's git branch,
// the assistant's words, AskUserQuestion answers and the files Edit/Write touched.
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const REAL_SOURCES = new Set(['typed', 'suggestion_accepted', 'queued']);
// Used only when a line carries neither promptSource nor turnOrigin (older releases).
const NOT_A_PROMPT = ['<task-notification>', '<command-name>', '<local-command', '[Request interrupted'];
const AGENT_TOOLS = new Set(['Agent', 'Task']); // 'Task' is the older name of the same tool
// Built-in slash commands are harness controls, not skills. Anything else in <command-name> is a skill.
const BUILTIN_COMMANDS = new Set(
  ('add-dir agents bashes branch btw bug checkpoint claim-credit clear compact config context copy cost desktop doctor ' +
    'effort exit export extra-usage fast feedback fork help hooks ide install-github-app keybindings login logout mcp ' +
    'memory mobile model output-style permissions plan plugin plugins privacy-settings rate-limit-options release-notes ' +
    'reload-plugins remote-control rename resume rewind sandbox skills stats status statusline tasks teleport ' +
    'terminal-setup theme todos undo upgrade usage vim').split(' '),
);
const INTERRUPT = '[Request interrupted by user';
// A tool call the user turned down at the permission prompt (not an auto-mode classifier denial).
const USER_REJECTED = /^The user doesn't want to (?:proceed|take this action)/;
const MID_TASK_MS = 30 * 60 * 1000;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SAY_MAX = 400;

export async function readSessions({ dir = '~/.claude/projects', since, limit, detail = false } = {}) {
  const root = dir.replace(/^~(?=$|\/)/, homedir());
  const sinceMs = since ? new Date(since).getTime() : null;
  const sessions = [];
  for (const proj of await list(root)) {
    const projDir = join(root, proj);
    for (const file of await list(projDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(projDir, file);
      try {
        // A file last written before `since` cannot hold a session that started after it.
        if (sinceMs != null && (await stat(path)).mtimeMs < sinceMs) continue;
        const session = await readSession(path, { detail });
        if (!session) continue;
        if (sinceMs != null && Date.parse(session.startedAt) < sinceMs) continue;
        sessions.push(session);
      } catch (err) {
        console.error(`loadout: skipped a session file (${err.message})`);
      }
    }
  }
  sessions.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return limit > 0 ? sessions.slice(0, limit) : sessions;
}

// One session file, with its subagents from the sibling <id>/subagents folder. null when it holds no turns.
export async function readSession(path, { detail = false } = {}) {
  const sessionDir = path.replace(/\.jsonl$/, '');
  const main = await readEvents(path, { prompts: true, detail });
  if (!main.startedAt) return null; // no user/assistant lines at all
  const subagents = [];
  const subDir = join(sessionDir, 'subagents'); // sibling tool-results/ is never opened
  for (const file of await list(subDir)) {
    if (!/^agent-.+\.jsonl$/.test(file)) continue;
    try {
      const meta = await readJson(join(subDir, file.replace(/\.jsonl$/, '.meta.json')));
      const sub = await readEvents(join(subDir, file), { prompts: false, detail, cwd: main.cwd });
      // Newer meta files omit the model; fall back to the launching Agent call, then the subagent's own replies.
      const model = str(meta.model) ?? main.agentModels.get(meta.toolUseId) ?? sub.model;
      subagents.push({ type: str(meta.agentType), model, events: sub.events, at: sub.startedAt });
    } catch (err) {
      console.error(`loadout: skipped a subagent file (${err.message})`);
    }
  }
  subagents.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    id: basename(path, '.jsonl'),
    source: 'claude-code',
    startedAt: main.startedAt,
    cwdName: main.cwdName,
    ...(detail && { cwd: main.cwd }),
    events: main.events,
    subagents: subagents.map(({ type, model, events }) => ({ type, model, events })),
  };
}

// Subagent files start with the parent's instructions, which are not the owner's words, so they skip prompts.
async function readEvents(path, { prompts, detail = false, cwd = null }) {
  const out = {
    detail, cwd, branch: null, asks: new Set(),
    events: [], startedAt: null, cwdName: null, model: null, agentModels: new Map(),
    toolNames: new Map(), // tool_use id → tool name, to name a denied call
    mode: null, planPending: false, lastAssistantAt: null, afterInterrupt: false,
  };
  const seenToolUse = new Set();
  const pendingTests = new Map(); // tool_use id → test/check events awaiting its result
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    // Metadata lines (some are huge request blobs) lead with "type"; skip them without parsing.
    if (line.startsWith('{"type":"') && !/^\{"type":"(user|assistant|permission-mode)"/.test(line)) continue;
    try {
      const o = JSON.parse(line);
      // permission-mode lines carry no timestamp: the plan event takes the next line's.
      if (o.type === 'permission-mode') {
        setMode(out, str(o.permissionMode));
        continue;
      }
      if ((o.type !== 'user' && o.type !== 'assistant') || (o.isSidechain && prompts)) continue;
      out.startedAt ??= str(o.timestamp);
      if (!out.cwdName && str(o.cwd)) out.cwdName = basename(o.cwd);
      out.cwd ??= str(o.cwd);
      if (str(o.gitBranch)) out.branch = o.gitBranch;
      const at = str(o.timestamp);
      if (o.type === 'user') setMode(out, str(o.permissionMode));
      if (out.planPending) {
        out.events.push({ kind: 'plan', at });
        out.planPending = false;
      }
      if (o.type === 'assistant') {
        onAssistant(o, at, out, seenToolUse, pendingTests);
        out.lastAssistantAt = at;
        out.afterInterrupt = false;
      } else onUser(o, at, out, prompts, pendingTests);
    } catch {
      // malformed or unknown shape: skip the line
    }
  }
  return out;
}

// Entering plan mode counts once per stint, whichever line shows it first.
function setMode(out, mode) {
  if (!mode) return;
  if (mode === 'plan' && out.mode !== 'plan') out.planPending = true;
  out.mode = mode;
}

function onAssistant(o, at, out, seenToolUse, pendingTests) {
  out.model ??= str(o.message?.model);
  const parts = Array.isArray(o.message?.content) ? o.message.content : [];
  if (out.detail) {
    const said = parts.filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim()).pop();
    if (said) out.events.push({ kind: 'say', text: said.text.trim().slice(0, SAY_MAX), at });
  }
  for (const p of parts) {
    if (p?.type !== 'tool_use' || typeof p.name !== 'string') continue;
    // One reply is logged as several lines sharing the message; dedupe calls by id.
    if (p.id && seenToolUse.has(p.id)) continue;
    if (p.id) seenToolUse.add(p.id);
    if (p.id) out.toolNames.set(p.id, p.name);
    const input = p.input && typeof p.input === 'object' ? p.input : {};
    if (out.detail) {
      if (p.name === 'AskUserQuestion' && p.id) out.asks.add(p.id);
      const file = FILE_TOOLS.has(p.name) && repoPath(str(input.file_path) ?? str(input.notebook_path), out.cwd);
      if (file) out.events.push({ kind: 'file', path: file, at });
    }
    const pend = (e) => {
      out.events.push(e);
      if (p.id) pendingTests.set(p.id, [...(pendingTests.get(p.id) ?? []), e]);
    };
    if (p.name === 'ExitPlanMode') {
      out.events.push({ kind: 'tool', name: p.name, at });
      // Already counted when plan mode was entered.
      if (out.mode !== 'plan' && !out.planPending) out.events.push({ kind: 'plan', at });
    } else if (p.name === 'Skill' && str(input.skill)) {
      out.events.push({ kind: 'skill', name: input.skill.replace(/^\//, ''), at });
    } else if (AGENT_TOOLS.has(p.name)) {
      const model = str(input.model);
      if (p.id && model) out.agentModels.set(p.id, model);
      out.events.push({ kind: 'agent', type: str(input.subagent_type), model, background: input.run_in_background === true, at });
    } else if (p.name.startsWith('mcp__')) {
      const m = p.name.match(/^mcp__(.+?)__(.+)$/);
      if (!m) {
        out.events.push({ kind: 'tool', name: p.name, at });
        continue;
      }
      out.events.push({ kind: 'mcp', server: m[1], tool: m[2], at });
      const how = browserCheck(m[1], m[2], input);
      if (how) pend({ kind: 'check', how, ok: null, at });
    } else if (p.name === 'Bash' && typeof input.command === 'string') {
      const shell = classifyBash(input.command, at);
      if (!shell.length) out.events.push({ kind: 'tool', name: p.name, at });
      for (const e of shell) {
        if (e.kind === 'git') out.events.push(e);
        else pend(e);
      }
    } else if (p.name === 'WebFetch' && typeof input.url === 'string' && LOCAL_URL.test(input.url)) {
      out.events.push({ kind: 'tool', name: p.name, at });
      pend({ kind: 'check', how: 'curl', ok: null, at });
    } else {
      out.events.push({ kind: 'tool', name: p.name, at });
    }
  }
}

function onUser(o, at, out, prompts, pendingTests) {
  const content = o.message?.content;
  if (Array.isArray(content)) {
    for (const p of content) {
      if (p?.type !== 'tool_result') continue;
      const rejected =
        p.is_error === true &&
        ((typeof o.toolUseResult === 'string' && o.toolUseResult.startsWith('User rejected tool use')) ||
          USER_REJECTED.test(rawText(p.content) ?? ''));
      if (rejected) out.events.push({ kind: 'denied', tool: out.toolNames.get(p.tool_use_id) ?? null, at });
      if (out.asks.has(p.tool_use_id) && !p.is_error) answers(o.toolUseResult, at, out);
      if (!pendingTests.has(p.tool_use_id)) continue;
      const ok = testOk(p, o.toolUseResult);
      for (const e of pendingTests.get(p.tool_use_id)) e.ok = ok;
      pendingTests.delete(p.tool_use_id);
    }
  }
  if (o.isMeta || o.isCompactSummary || o.toolUseResult) return;
  const raw = rawText(content);
  if (raw == null) return;
  if (raw.trimStart().startsWith(INTERRUPT)) {
    // A subagent's transcript repeats the parent's interrupt; count it once, in the main session.
    if (prompts) out.events.push({ kind: 'interrupt', at });
    out.afterInterrupt = true;
    return;
  }
  // Slash commands arrive as a user line; count them whatever the prompt fields say.
  const cmd = raw.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/);
  if (cmd) {
    out.events.push(BUILTIN_COMMANDS.has(cmd[1]) ? { kind: 'command', name: cmd[1], at } : { kind: 'skill', name: cmd[1], at });
    return;
  }
  if (!prompts) return;
  const { text, hadPaste } = cleanPrompt(content);
  const hasFields = o.promptSource !== undefined || o.turnOrigin !== undefined;
  const real = hasFields
    ? REAL_SOURCES.has(o.promptSource) || o.turnOrigin === 'human'
    : !NOT_A_PROMPT.some((p) => raw.trimStart().startsWith(p)) && (text !== '' || hadPaste);
  if (!real) return;
  const images = Array.isArray(content) ? content.filter((p) => p?.type === 'image').length : 0;
  const sinceWork = out.lastAssistantAt ? Date.parse(at) - Date.parse(out.lastAssistantAt) : NaN;
  out.events.push({
    kind: 'prompt',
    ...(out.detail && { branch: out.branch }),
    text,
    at,
    hadPaste,
    images,
    words: text ? text.split(/\s+/).length : 0,
    namesFile: NAMES_FILE.test(text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '')),
    midTask: sinceWork >= 0 && sinceWork <= MID_TASK_MS,
    afterInterrupt: out.afterInterrupt,
  });
  out.afterInterrupt = false;
}

// AskUserQuestion results map each question to the chosen label(s); notes the user typed ride in annotations.
function answers(result, at, out) {
  if (!result || typeof result !== 'object' || !result.answers || typeof result.answers !== 'object') return;
  for (const [question, answer] of Object.entries(result.answers)) {
    if (!str(answer)) continue;
    const notes = str(result.annotations?.[question]?.notes);
    out.events.push({ kind: 'answer', question, answer, ...(notes && { notes }), at });
  }
}

// A file inside the session's folder, relative to it; anything elsewhere is not the repo's.
function repoPath(file, cwd) {
  if (!file || !cwd) return null;
  const root = cwd.replace(/\/+$/, '') + '/';
  return file.startsWith(root) && file.length > root.length ? file.slice(root.length) : null;
}

// An @-mention, a relative or absolute path, or a bare name with a common source/doc extension. URLs are stripped first.
const NAMES_FILE =
  /(?:^|\s)@[\w./~-]*\w|(?:^|[\s(`'"])(?:~|\.{1,2})?\/[\w.-]+\/[\w.-]|[\w.-]+\/[\w.-]+\/[\w.-]|\b[\w-]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|md|mdx|json|ya?ml|toml|html|css|scss|sql|sh|txt|env|lock|xml|vue|svelte)\b/i;

// The text the user line carries, or null when it carries none (e.g. only tool results).
function rawText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text);
  return texts.length ? texts.join('\n') : null;
}

// Pastes, injected reminders, IDE context and images are never the owner's phrasing and may hold private data.
function cleanPrompt(content) {
  let text = rawText(content) ?? ''; // image parts are dropped by taking text parts only
  let hadPaste = false;
  // Closing tags carry the id too (</pasted_content id="…">), and a paste that never closes swallows the rest.
  text = text.replace(/<pasted_content\b[^>]*?(?:\/>|>[\s\S]*?(?:<\/pasted_content\b[^>]*>|$))/g, () => {
    hadPaste = true;
    return '';
  });
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(ide_[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/\[Image #\d+\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, hadPaste };
}

// Split a shell line into simple commands so `git add -A && git commit` yields both verbs.
function classifyBash(command, at) {
  const events = [];
  for (let seg of command.split(/&&|\|\||;|\||\n/)) {
    seg = seg.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''); // leading VAR=x assignments
    const verb = gitVerb(seg);
    if (verb) events.push({ kind: 'git', verb, at });
    else if (TEST_RUN.test(seg)) events.push({ kind: 'test', ok: null, at }, { kind: 'check', how: 'test', ok: null, at });
    else {
      const how = shellCheck(seg);
      if (how) events.push({ kind: 'check', how, ok: null, at });
    }
  }
  return events;
}

// `npm run build` style package scripts, and binaries run directly or through npx/pnpm exec.
const SCRIPT = String.raw`^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?`;
const BIN = String.raw`^(?:(?:npx|bunx|pnpm\s+exec|pnpm|yarn)\s+)?`;
const SHELL_CHECKS = [
  ['typecheck', new RegExp(String.raw`${SCRIPT}(?:type-?check|tsc|check[:-]?types)\b|${BIN}(?:tsc|vue-tsc|svelte-check|mypy|pyright)\b|^python3?\s+-m\s+mypy\b|^cargo\s+check\b`)],
  ['lint', new RegExp(String.raw`${SCRIPT}(?:lint|format:check)\b|${BIN}(?:eslint|biome\s+(?:check|lint|ci)|ruff|stylelint|oxlint)\b|${BIN}prettier\s.*--check\b|^(?:cargo\s+clippy|go\s+vet|golangci-lint|flake8|rubocop|swiftlint)\b`)],
  ['build', new RegExp(String.raw`${SCRIPT}build\b|${BIN}(?:next|vite|astro|nuxt)\s+build\b|${BIN}(?:webpack|rollup|esbuild|tsup)\b|^(?:cargo|go|swift|docker)\s+build\b|^(?:xcodebuild|\.\/gradlew\s+\S*[aA]ssemble|mvn\s+(?:package|compile|install))\b`)],
  ['run', new RegExp(String.raw`${SCRIPT}(?:dev|start|serve|preview)\b|${BIN}(?:next\s+(?:dev|start)|vite(?:\s+(?:dev|serve|preview))?(?=\s|$)(?!\s+build))|^node\s+(?:\S+\/)?(?:server|app|index|main)\b|^(?:uvicorn|gunicorn|flask\s+run|rails\s+s(?:erver)?\b|cargo\s+run|go\s+run)\b|^python3?\s+(?:\S+\/)?manage\.py\s+runserver\b`)],
];

const LOCAL_URL = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/;

function shellCheck(seg) {
  if (/^(?:curl|wget|http|xh)\b/.test(seg) || /\bfetch\(/.test(seg)) return LOCAL_URL.test(seg) ? 'curl' : null;
  for (const [how, re] of SHELL_CHECKS) if (re.test(seg)) return how;
  return null;
}

// Browser automation MCP servers (Chrome, Playwright, the in-app browser, …): page reads and actions are checks.
function browserCheck(server, tool, input) {
  if (!/chrome|browser|playwright|puppeteer/i.test(server)) return null;
  if (/screenshot/i.test(tool) || (/computer/i.test(tool) && input.action === 'screenshot')) return 'screenshot';
  return /navigate|read_page|snapshot|computer/i.test(tool) ? 'browser' : null;
}

function gitVerb(seg) {
  const words = seg.split(/\s+/);
  if (words[0] !== 'git') return null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-C' || w === '-c') i++; // option with a value, e.g. git -C <dir> status
    else if (!w.startsWith('-')) return /^[a-z][a-z-]*$/.test(w) ? w : null;
  }
  return null;
}

const TEST_RUN =
  /^(?:(?:npx|bunx)\s+|pnpm\s+exec\s+|python3?\s+-m\s+)?(?:npm\s+(?:run\s+)?test|npm\s+t\b|npm\s+run\s+check|pnpm\s+(?:run\s+)?(?:test|check)|yarn\s+(?:run\s+)?test|bun\s+test|pytest|go\s+test|cargo\s+test|vitest|jest)\b/;

// Bash results carry no exit code. Heuristic: an error result or a clear failure marker means false, a clear
// pass marker means true, anything else stays null. Failure wins so "3 passed, 1 failed" is false.
const FAIL = /\b[1-9]\d* (?:failed|failing|failures?|errors?)\b|^\s*(?:FAIL|not ok)\b|\bFAILED\b|^--- FAIL|^# fail [1-9]|\bpanicked\b/im;
const PASS = /\b[1-9]\d* (?:passed|passing)\b|^\s*(?:ok|PASS)\b|\btest result: ok\b|^# pass [1-9]|\ball .*\bpassed\b/im;

function testOk(part, result) {
  if (part.is_error === true) return false;
  const text =
    result && typeof result === 'object' && (typeof result.stdout === 'string' || typeof result.stderr === 'string')
      ? `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      : rawText(part.content) ?? '';
  if (FAIL.test(text)) return false;
  if (PASS.test(text)) return true;
  return null;
}

async function list(path) {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

async function readJson(path) {
  try {
    const v = JSON.parse(await readFile(path, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}
