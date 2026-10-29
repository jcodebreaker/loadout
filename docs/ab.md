# A/B pilot: does a loadout change what Claude Code does?

- Date: 2026-10-28
- Claude Code 2.1.312, model `sonnet` (`claude-sonnet-5-5`), Node 26
- Script: `node scripts/ab.mjs` (manual and paid, not part of `npm run check`). Raw rows: [`fixtures/ab/results.json`](../fixtures/ab/results.json).
- 12 runs: 3 tasks x 2 arms x 2 reps. Total cost $0.99 (plus $0.24 for two smoke runs before the pilot).

## Setup

An invented toy repo, [`fixtures/ab/toy`](../fixtures/ab/toy): cart math in `src/cart.js`, a messy `formatMoney` in `src/money.js`, six passing tests run with `node --test`, and a README that documents the intended behavior. It has one planted bug: the `SAVE10` percent code ignores `qty`.

Tasks, from [`fixtures/ab/tasks.json`](../fixtures/ab/tasks.json):

| Task | Prompt | Playbook the hook picked |
|---|---|---|
| bug | "Support says discounts are broken for some orders. Can you fix it?" | Fix a bug |
| feature | "Add support for free shipping on orders of $50 or more." | Build a feature |
| refactor | "formatMoney in src/money.js is hard to read. Clean it up without changing what it does." | none (SessionStart only) |

Arms. Both load the plugin with `--plugin-dir`, each run gets a fresh `LOADOUT_HOME` and a fresh temp git copy of the toy repo.

- **plain**: nothing active.
- **loaded**: `loadout use docs/example/maya.loadout`. That pack is generated and other work changes it, so the script records a hash of the `LOADOUT.md` it used (`a7800ece29dc` for this pilot, the v0.2 pack with rules, checks and playbooks; its feature playbook is Explore, `tdd`, edit, run tests, commit). Every loaded run's stream shows the SessionStart hook injecting it, and the bug and feature runs show the matching playbook injected; no plain run shows either.

Every run: `claude -p <prompt> --model sonnet --max-turns 12 --max-budget-usd 1 --permission-mode acceptEdits --allowedTools Read Edit Write Glob Grep "Bash(node --test*)" "Bash(node *.mjs)" "Bash(git diff*)" "Bash(git status*)" --disallowedTools WebFetch WebSearch --setting-sources project --strict-mcp-config --no-session-persistence --output-format stream-json`. Anything else that needs permission is denied, since print mode cannot ask. The script removes the `~/.claude/projects/<temp cwd>` folder Claude Code still creates (an empty `memory/`, plus subagent `.meta.json` files when a run uses Explore).

After each run the script reads the stream, diffs the temp repo, runs `node --test` itself, and runs a hidden check from `fixtures/ab/hidden/` that Claude never saw (bug: `SAVE10` counts quantity; feature: free at $50, $4.99 below, only cases where before/after-discount reads the same; refactor: 13 `formatMoney` inputs give the old output).

## Results

"Tried tests": issued a test command, allowed or not. "Ran tests": a test command that actually ran. "Asked": the final message ends with a question to the user. "Restated done" is a regex for phrasings like "done means", read the rows to judge it. Lines, tools, turns and seconds are means; cost is the sum.

| Task | Arm | Tried tests | Ran tests | Tested after last edit | Tests pass | Hidden check | Changed a test | Asked | Restated done | "Following Maya's loadout" | Lines | Tools | Turns | Sec | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bug | plain | 2/2 | 0/2 | 0/2 | 2/2 | 2/2 | 0/2 | 0/2 | 0/2 | 0/2 | 2 | 5.0 | 6.0 | 9 | $0.10 |
| bug | loaded | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 1/2 | 2/2 | 7 | 10.0 | 11.0 | 16 | $0.16 |
| feature | plain | 2/2 | 1/2 | 1/2 | 2/2 | 2/2 | 2/2 | 0/2 | 0/2 | 0/2 | 23 | 13.0 | 14.0 | 22 | $0.20 |
| feature | loaded | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 1/2 | 2/2 | 31 | 16.0 | 13.5 | 22 | $0.30 |
| refactor | plain | 1/2 | 1/2 | 1/2 | 2/2 | 2/2 | 0/2 | 0/2 | 0/2 | 0/2 | 52 | 3.5 | 4.5 | 12 | $0.11 |
| refactor | loaded | 2/2 | 1/2 | 1/2 | 2/2 | 2/2 | 0/2 | 0/2 | 0/2 | 0/2 | 56 | 5.5 | 6.5 | 14 | $0.13 |
| **all** | **plain** | 5/6 | 2/6 | 2/6 | 6/6 | 6/6 | 2/6 | 0/6 | 0/6 | 0/6 | 26 | 7.2 | 8.2 | 14 | $0.40 |
| **all** | **loaded** | 6/6 | 5/6 | 5/6 | 6/6 | 6/6 | 4/6 | 0/6 | 2/6 | 4/6 | 31 | 10.5 | 10.3 | 17 | $0.59 |

(The "Tried tests" column was added to the script after the pilot; its values come from `triedTests` in the results file.)

What the streams show, beyond the counts:

- **Outcome: no difference.** All 12 runs fixed or built the right thing: tests pass and the hidden check passes in both arms. The tasks were too easy to separate the arms on correctness.
- **Process: the loaded arm checked its work more.** On the bug, both plain runs tried `npm test`, were denied, did not retry, and reported "I haven't run the tests". Both loaded runs ran `node --test`, added a regression test, and reported the passing count. On the feature, both loaded runs started an Explore subagent, wrote a test, saw it fail, then implemented (the playbook's tdd step, done by hand because the `tdd` skill isn't installed); one plain run never got a test to run.
- **It said so.** Every run that matched a playbook (4/4) opened with "Following Maya's loadout" and named any skill it lacked (`diagnosing-bugs`, `tdd`) before doing that step the plain way. The refactor matched no playbook and neither arm said it, as intended.
- **It followed the playbook into denials.** Both loaded feature runs tried to `git commit` because the playbook ends with "Commit", were denied, and said so. The plain runs never tried to commit.
- **No clarifying questions** in either arm. Both feature arms picked "subtotal after discount" for the $50 threshold on their own and stated it.
- **Cost.** The loaded arm used 26% more turns and 46% more tool calls, and cost 48% more ($0.59 vs $0.40), most of it in the feature runs (the Explore subagent).

## Caveats

- **Tiny n.** Two reps per cell. A 2/2 vs 0/2 split is suggestive, not significant, and the per-pair runs were close to identical, so the reps tell us little about variance.
- **The allowlist confounds "ran tests".** Only `node --test` is allowed. Plain runs reached for `npm test` and gave up after the denial; loaded runs mostly ran `node --test`, first try or after one denial, but one loaded refactor run tried `pnpm test`, was denied twice and also stopped untested. With `npm test` allowed, the plain arm might well have run its tests. The honest read is "the loaded arm more often found a way to run the tests", not "plain doesn't test". The pre-pilot smoke run (loaded bug, toy README still saying `npm test`) also tried `npm test`, was denied, and did not retry.
- **One model, one toy repo, one pack,** all invented. Sonnet only, not haiku or opus.
- **The pack's kit is missing.** `--setting-sources project` keeps the owner's plugins out, so `tdd`, `diagnosing-bugs`, `code-review` and the `playwright` MCP server are unavailable; the loaded arm can only follow those steps by hand. A real user with Maya's kit installed would see different runs.
- **Agent and Skill aren't in the allowlist** but weren't denied either (they don't need a permission prompt), so the loaded arm could still spawn Explore.
- **Heuristic columns.** "Asked" and "Restated done" are regexes over the final and assistant text.
- **Wrappers.** On a machine where `claude` is a wrapper that adds its own PreToolUse and PermissionRequest hooks, each denial stalled for about two minutes. Point `AB_CLAUDE` at the real binary. Every row records any hook that isn't the plugin's (`otherHooks`), and it was empty for all 12 runs.

## For a bigger run

1. Allow the common test runners (`npm test`, `pnpm test`) or match the toy repo to what the model expects, so "ran tests" measures intent, not allowlist luck. Keep `git commit` denied, and count attempts.
2. Harder tasks where the plain arm fails sometimes: a bug with two causes, a feature whose spec is genuinely ambiguous, a refactor whose behavior the existing tests don't fully pin down. Today the hidden checks are 12/12, so they can't show a difference.
3. At least 5 reps per cell, a second model (haiku), and a third arm with the pack's kit installed.
4. A placebo arm: a loadout of the same length with generic advice, to separate "this person's workflow" from "any extra instructions about testing".
5. Score process from the event order (tests between last edit and end, test written before code) instead of text regexes, and have a person read a sample of transcripts blind to arm.

## Run it

```sh
node scripts/ab.mjs --dry                          # the plan, no runs
AB_CLAUDE=$(command -v claude) node scripts/ab.mjs # the full pilot, 12 runs
node scripts/ab.mjs --tasks bug --arms loaded --reps 1 --out /tmp/one.json
```

Env and flags: `AB_MODEL` / `--model` (sonnet), `AB_REPS` / `--reps` (2), `AB_MAX_TURNS` / `--max-turns` (12), `AB_BUDGET` / `--budget` (1.00 USD per run), `AB_JOBS` / `--jobs` (3 at once), `--tasks`, `--arms`, `--out`, `AB_KEEP=1` keeps the temp repos and raw streams.
