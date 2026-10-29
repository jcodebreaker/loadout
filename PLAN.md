# Loadout v0.1: build plan (revised after review)

Loadout ports one developer's way of working with a coding agent into another person's session. Not team memory (that's Glen), not one skill. A *loadout* is mined from the owner's own Claude Code sessions, reviewed by them, shared as one folder, and loaded with one command.

Decided with the user:
- What gets ported is the **harness workflow**: how they ask, which skills/agents/tools they reach for, and in what order, per kind of goal. Not coding style.
- Not a skill. Closer to "a Claude Code template". One session uses many skills.
- Open source (MIT), local-first. Data: Claude Code sessions (+ git later).
- One command in Claude Code, then just work. Owner builds and approves their own loadout. Code, paths, secrets, pastes and client names never leave.
- Target look: the calm mockup, https://claude.ai/artifact/5MhHmaKjuqkJtmYpzAQPpz

## Repo = plugin root

Like hotseat: the repo root is the Claude Code plugin root (hooks and skills can only reach files under it). Node 22+, ESM, plain `.mjs`, no build step, no deps unless essential, logs to stderr, offline `npm run check`.

```
.claude-plugin/plugin.json, marketplace.json            (agent 4)
bin/loadout.mjs           CLI + the build pipeline       (agent 4)
src/sessions.mjs          read Claude Code JSONL          (agent 1)
src/redact.mjs            strip private data              (agent 2)
src/mine.mjs              sessions → Loadout              (agent 3)
src/pack.mjs              Loadout ↔ folder, LOADOUT.md    (agent 4)
src/review/server.mjs, page.html   local review page      (agent 5)
skills/use, skills/off, skills/status, skills/loadout    (agent 4)
hooks/hooks.json, hooks/session-start.mjs, hooks/prompt.mjs   (agent 4)
fixtures/claude/…         invented sessions only          (agent 1 writes; all use)
scripts/check.mjs         runs scripts/check-*.mjs, one per area
```

## Session format facts (Claude Code 2.1)

- Main file: `~/.claude/projects/<proj>/<sessionId>.jsonl`. Subagents: `<proj>/<sessionId>/subagents/agent-*.jsonl` (+ `agent-*.meta.json` with `agentType`, `model`). Never read `<sessionId>/tool-results/`.
- A **real prompt** is `type==='user' && !isMeta && !isCompactSummary && !toolUseResult && (promptSource ∈ {typed, suggestion_accepted, queued} || turnOrigin==='human')`. Fallback when those fields are missing: string/text content not starting with `<task-notification>`, `<command-name>`, `<local-command`, `[Request interrupted`.
- `<command-name>/foo</command-name>` lines are slash-invoked skills → `{kind:'skill'}`.
- Ignore `type:'attachment'` lines entirely (they include hook injections, which would make loadout re-mine itself), and all non user/assistant line types.
- Bash results have no exit code; `test.ok` comes from a stdout/stderr heuristic or is `null`.
- The format is internal and changes between releases: per-line try/catch, skip unknown types, never throw on a file. Default retention is 30 days, so print "N sessions over D days".
- Codex: out of scope for v0.1 (local rollouts carry no tool calls). Keep `source:'codex'` in the type only.

## Interfaces (fixed)

```js
// src/sessions.mjs (agent 1)
export async function readSessions({ dir = '~/.claude/projects', since /* Date */, limit } = {}): Promise<Session[]>
Session = { id, source: 'claude-code', startedAt, cwdName /* basename */, events: Event[], subagents: [{ type, model, events: Event[] }] }
Event =
  | { kind: 'prompt', text, at, hadPaste: boolean }   // text already has <pasted_content>, <system-reminder>, <ide_*> blocks and images removed
  | { kind: 'skill', name, at }                        // Skill tool_use input.skill, or <command-name>
  | { kind: 'agent', type, model, background, at }     // Agent tool_use
  | { kind: 'tool', name, at }                         // by name only, never inputs
  | { kind: 'mcp', server, tool, at }                  // mcp__<server>__<tool>
  | { kind: 'git', verb, at }                          // commit|push|branch|worktree|rebase|merge|…
  | { kind: 'test', ok: boolean | null, at }

// src/redact.mjs (agent 2): counts only, never the removed values
export function redactText(text, ctx): { text, removed: Counts }
export function redactSession(session, ctx): { session, removed: Counts }
export function redactDeep(obj, ctx): { value, removed: Counts }     // every string in an object
Counts = { paths, secrets, emails, hosts, names, code, urls }        // numbers
ctx = { home, repoNames: string[], extraNames: string[] }

// src/mine.mjs (agent 3): only ever sees redacted sessions
export async function mine(sessions, { handle, displayName, llm = false } = {}): Promise<Loadout>
Loadout = {
  handle, displayName, version: 1, builtAt,
  playbooks: [{ id, name, when, trigger: string[] /* words in the opening prompt */, steps: [{ do, uses?: string /* skill|agent|mcp|tool name */ }], seen }],
  patterns: [{ text, seen }],         // ≤120 chars, appears in ≥2 sessions, never from a prompt with hadPaste
  kit: { skills: [{ name, seen }], mcp: [{ server, seen }], agents: { share /* 0..1 of sessions using subagents */, types: [name], models: [name] } },
  stats: { sessions, days, prompts, skills, subagents },
  removed: Counts,                     // summed by the CLI
}
// A playbook = class of opening prompt → ordered skills/agents/MCP/tools used in that turn. Plain Read/Edit/Bash
// are collapsed ("edits code", "runs tests") because every developer has them; distinctive signal is skills,
// agents, MCP servers and phrasing. Deterministic by default. --llm (opt-in) shells out to the user's own
// `claude -p --output-format json` only to fill name/when/steps[].do, with a strict schema and fallback.

// src/pack.mjs (agent 4)
export function validate(loadout): string[]                       // handle /^[a-z0-9][a-z0-9-]{1,30}$/, LOADOUT.md ≤ 8 KB
export function renderLoadoutMd(loadout): string                   // pure, deterministic: Playbooks / How they ask / Kit
export function playbookFor(loadout, promptText): Playbook | null  // trigger-word match, used by the hook
export async function writePack(loadout, outDir): Promise<string>  // <outDir>/<handle>.loadout/{loadout.json, LOADOUT.md, README.md}
export async function readPack(path): Promise<Loadout>
State: ~/.loadout/drafts/<handle>.json, ~/.loadout/packs/<handle>/, ~/.loadout/active.json = { handle, path, since }
```

## Pipeline (owned by `bin/loadout.mjs build`, agent 4)

`readSessions → redactSession (each) → mine → redactDeep(loadout) → sum removed → write draft → print summary → open review`.

## Commands

- `loadout build [--handle maya] [--since 30d] [--llm]`. Handle defaults to git `user.name`, slugified.
- `loadout review` → agent 5's page; toggles playbooks/patterns/kit items, renames playbooks; handle is read-only. Saves the draft.
- `loadout publish [--out .]`, `loadout use <handle|path>`, `loadout off`, `loadout list`, `loadout status`.
- In Claude Code: `/loadout:use maya`, `/loadout:off`, `/loadout:status` (skills with `disable-model-invocation: true` and a dynamic `!` line running `bin/loadout.mjs`), plus a `loadout` skill telling Claude how to follow an active loadout.
- Hooks: `SessionStart` injects the active pack's full LOADOUT.md once (≤8 KB); `UserPromptSubmit` injects only the matching playbook (≤2 KB) or nothing. Both exit 0 silently if `active.json` is missing or bad. Timeout 5.

## Privacy rules (hard)

- Nothing is sent anywhere except the user's own `claude -p` when they pass `--llm`.
- Pastes, system reminders, IDE blocks and images are dropped before redaction. Redaction runs before mining and again on the result. Only counts of removed items are stored.
- Fixtures are invented. No real session data in the repo, ever.

## Cut from v0.1

Codex, git mining, traits/scores, headless screenshot checks, publishing anywhere online.

---

# v0.2: capture judgment, not just tools (after the "secret sauce" review)

Sources agree the edge is: a check the agent can run, context before the ask, planning, a corrections log, knowing when to intervene. v0.2 mines those. Interfaces below are fixed for the five builders.

## New session events and fields (src/sessions.mjs)

```js
// prompt event gains (computed before any text is dropped, numbers/booleans only):
{ kind: 'prompt', text, at, hadPaste, images /* count of image parts */, words /* of cleaned text */,
  namesFile /* mentions a file name or path */, midTask /* not the first prompt of a turn chain: follows assistant work in the same session within 30 min */,
  afterInterrupt /* the previous user line was "[Request interrupted by user…" */ }
// new events:
{ kind: 'interrupt', at }                                   // "[Request interrupted by user" lines
{ kind: 'denied', tool, at }                                // a tool_result the user rejected (permission denied / "doesn't want to proceed")
{ kind: 'command', name, at }                               // built-in slash commands: clear, compact, plan, rewind, model, … (name without slash)
{ kind: 'plan', at }                                        // ExitPlanMode tool_use, or permission-mode plan entered
{ kind: 'check', how: 'test'|'build'|'lint'|'typecheck'|'browser'|'screenshot'|'curl'|'run', ok: boolean|null, at }
                                                            // test runs (keep the old 'test' event too), build/lint/tsc,
                                                            // browser MCP actions (navigate/screenshot/read_page), curl/fetch to localhost, running the app
```

## New Loadout fields (src/mine.mjs → src/pack.mjs)

```js
rules: [{ id, text /* ≤140 chars, an instruction */, seen /* sessions */, from: 'correction'|'interrupt'|'denied' }]
   // mined from midTask / afterInterrupt prompts that correct the agent ("no", "don't", "stop", "instead", "actually",
   // "never", "always", "not like that", "you forgot", "wait"), clustered like patterns; ≥2 sessions; most-seen first; ≤10
checks: [{ id, text /* "Runs the tests before committing" */, rate /* 0..1 */, of /* turns it applies to */, when /* 'feature'|'bug'|'design'|'any' */ }]
   // e.g. tests between last edit and commit, browser/screenshot on UI turns, plan mode before multi-file changes,
   // asks for proof ("show me", "prove", "run it", "screenshot"). Report honest rates; keep only rate ≥0.3 and of ≥5.
openings: { medianWords, withAttachment /* rate */, namesFiles /* rate */, definesDone /* rate: says what done/success looks like */, usesPlanFirst /* rate */ }
claudeMd: { text /* redacted, ≤3 KB */, include: false } | null   // owner's ~/.claude/CLAUDE.md, added by the CLI, off until the owner turns it on
```
Ordering fix: playbook steps keep the order within the turn that opened the task; harness-mandated skills (artifact-design, artifact-capabilities, update-config, keybindings-help, init, reload-plugins, …: a short list in mine.mjs) never become steps.

## LOADOUT.md order (8 KB cap)

1. **Rules they've enforced** (the corrections log)  2. **How they check work**  3. **How they open a task**  4. Playbooks  5. How they ask  6. Kit  7. Their CLAUDE.md (only if included)

## Positioning

Honest pitch until an A/B says otherwise: "Load how a developer you respect works with Claude Code: the rules they've had to enforce, how they check work, and the setup behind it." No quality claims without numbers from scripts/ab.mjs.
