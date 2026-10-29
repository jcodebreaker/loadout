# Live test: the plugin inside real Claude Code

- Date: 2026-10-28
- Claude Code 2.1.312, model `haiku` (`claude-haiku-5-5`), Node 26
- Script: `node scripts/live-test.mjs [fresh session match nomatch status off use]`. It is a manual script, not part of `npm run check`. A full run makes 7 cheap `claude -p` calls (about $0.002 each).

Each run uses its own `LOADOUT_HOME=$(mktemp -d)` and a temp cwd, loads the plugin with `--plugin-dir <repo>`, and passes `--setting-sources project --strict-mcp-config --no-session-persistence`, so the owner's own settings, plugins, MCP servers and `~/.loadout` stay out. It also passes `--output-format stream-json --verbose --include-hook-events --debug-file …`, which puts each hook's stdout and exit code into the stream. Claude Code still creates an empty `~/.claude/projects/<cwd>/memory/` for each cwd, even with `--no-session-persistence`. The script deletes those directories again when they hold no files.

## Results

| # | Step | Result |
|---|------|--------|
| 1 | Activate the example pack through the CLI | PASS |
| 2 | SessionStart injects LOADOUT.md | PASS |
| 3a | UserPromptSubmit injects the matching playbook | PASS |
| 3b | A non-matching prompt gets nothing | PASS |
| 4a | `/loadout:status` | PASS |
| 4b | `/loadout:off` | PASS |
| 4c | `/loadout:use maya` | **FAIL**: the loadout is turned on, but the model is told it isn't |
| 5 | Fresh LOADOUT_HOME: no injection, no errors | PASS |
| – | Hook stderr and startup cost | PASS: stderr empty, about 55-100 ms per hook |

### 1. Activate

The script copies `fixtures/loadout-example.json` to `$LOADOUT_HOME/drafts/maya.json`, then runs `loadout publish --handle maya --out <tmp>` and `loadout use <tmp>/maya.loadout`. That writes `packs/maya/{loadout.json,LOADOUT.md,README.md}` and `active.json`. `loadout status` printed: "Using maya's loadout since …: 3 playbooks (Ship a feature, Fix a bug, Review a pull request)."

### 2. SessionStart

The hook's stdout in the stream starts with `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The user turned on maya's loadout. … # Maya's loadout …`. When asked whose loadout was in context, Claude answered: "Maya's loadout is in my context, and its playbook names are "Ship a feature," "Fix a bug," and "Review a pull request."" That matches the fixture.

### 3. UserPromptSubmit

- Matching prompt ("… Task: fix the broken login bug. Which playbook were you told to follow …"): the hook emitted `Following Maya's loadout: this prompt matches the playbook "Fix a bug" …`. Claude answered: "The "Fix a bug" playbook from Maya's loadout, whose first step is to reproduce the bug and find its cause using the `diagnosing-bugs` skill."
- Non-matching prompt ("What is 2+2? …"): the hook's stdout was empty and it exited 0. Claude answered: "4. No playbook was injected for this prompt; the only one present, Maya's loadout, came from the session-start hook."
- Slash prompts (`/loadout:*`) are skipped by `prompt.mjs`, as intended.

### 4. Skills in `-p`

The `!` lines do run in print mode, and `disable-model-invocation: true` skills can still be called as `-p "/loadout:status"`. The `!` lines pass only because of `allowed-tools`. In a test copy with `allowed-tools` removed from `status`, the debug log showed `Shell command permission check failed for command in /loadout:status: node ".../bin/loadout.mjs" status. Error: This command requires approval`. The run still exited 0, but with an **empty** reply and no error shown. Keep `allowed-tools` on every skill that has a `!` line. stream-json does not include the expanded skill text, so the script proves the `!` lines ran in other ways: no permission failure in the debug log, the state change on disk, and a fact that only the CLI output could have given the model.

- `/loadout:status`: with `maya` active and a second pack `lee` installed (which only `loadout list` prints), Claude replied: "Maya's loadout is on, with 3 playbooks (Ship a feature, Fix a bug, Review a pull request). Lee's loadout is also on this machine, with 3 playbooks, but it's not active." PASS.
- `/loadout:off`: `active.json` was removed. Claude replied: "Stopped using Maya's loadout; I'll work normally from here on." PASS.
- `/loadout:use maya` (after `loadout off`): `active.json` was written again, but Claude replied: "Maya's loadout didn't turn on. The command reported 3 playbooks …, but the active-loadout check still says "No loadout is on," so I'm not following it." **FAIL.** Claude Code does not run a skill's `!` lines one after another, so `status --md` read `active.json` before `use` had written it. The user is told the loadout is off while it is on, and Claude declines to follow it in that session.

### 5. No active loadout

With an empty `LOADOUT_HOME`, Claude replied "OK". Both loadout hooks exited 0 with empty stdout and stderr, and the process's stderr was empty.

### Hook cost

From the debug log (`Hooks: … (plugin loadout@inline) finished with status 0 (Nms)`), SessionStart took 67-97 ms and UserPromptSubmit 53-64 ms. Neither wrote anything to stderr. Whole `-p` runs took 3-5 s, almost all of it model time.

## Fix proposals

1. **`skills/use/SKILL.md`: run `use` and `status --md` in one `!` line so they happen in order.** Replace

   ```
   !`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" use $ARGUMENTS`

   ## The active loadout

   !`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" status --md`
   ```

   with

   ```
   ## The active loadout

   !`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" use $ARGUMENTS && node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" status --md`
   ```

   This was checked live on a temp copy of the plugin. Both commands still pass the existing `allowed-tools` rule, and Claude replied: "Maya's loadout is on, with three playbooks: Ship a feature, Fix a bug, and Review a pull request." `&&` also means a failed `use` shows only its own error, not a stale `status`. Another option is a `--md` flag on `loadout use` that prints LOADOUT.md after switching, but that needs a CLI change.
2. `skills/status/SKILL.md` has the same two-line shape (`status`, then `list`). Both commands only read, so the race does no harm there, and it can stay as it is.
3. Minor: `loadout status` prints `since` as the UTC date (`active.since.slice(0, 10)`), so in the evening west of UTC it shows tomorrow's date.
