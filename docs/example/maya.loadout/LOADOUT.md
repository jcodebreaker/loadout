# Maya's loadout

This is how Maya works with Claude Code. Mined from 42 of their Claude Code sessions over 30 days and approved by them.

Use it for every task in this session. The rules always apply. Run the checks before you say you're done. Follow a playbook only when the loadout sends one with a prompt. When it's offered, ask first and follow it only after a yes. Then say "following Maya's loadout" once and follow its steps in order, with the skills, subagents and tools it names. Never invent steps they don't have. Commit, push, open a PR or deploy only when the user says so in this task, even inside a playbook. When nothing matches, work normally with the rest in mind.

## Rules they've enforced

Follow these. They come from times Maya had to correct an agent.

- Don't add comments that restate the code.
- Run the test you wrote before you edit anything else.
- Ask before adding a dependency.
- Only change what the task needs, no drive-by refactors.

## How they check work

- Run the tests after the last edit and before committing (they do this in 7 of 10 feature tasks).
- Open the app in the browser to confirm the fix (they do this in 4 of 9 bug fixes).
- Show proof that it works before they ask (they ask for it in 10 of 31 tasks).

## How they open a task

- Before starting, restate what done looks like and confirm it (their openings say it 19% of the time).
- Find the code it touches yourself before asking where it is (they name files 23% of the time).
- Their openings are short (about 14 words): read the code first and ask only what it can't answer.

## Playbooks

### Build a feature

When: Building or adding a feature. Opening prompts mention "add", "support", "build", "feature".

1. Spin up an Explore sub-agent.
2. Use the tdd skill.
3. Edit code.
4. Run tests.
5. Commit.

### Fix a bug

When: Fixing a bug, an error or a failing test. Opening prompts mention "fix", "failing", "broken", "error".

1. Use the diagnosing-bugs skill.
2. Edit code.
3. Run tests.
4. Use playwright (MCP).

### New idea or plan

When: Starting from a new idea, a plan or a concept. Opening prompts mention "grill", "idea", "plan".

1. Use the grilling skill.
2. Spin up an Explore sub-agent.

### Review

When: Reviewing code or a pull request. Opening prompts mention "review", "pr", "diff".

1. Spin up a general-purpose sub-agent.
2. Use the code-review skill.

## How they ask

Maya phrases requests and check-ins like this. Ask your own check-ins the same way.

> "grill me on this before you write any code"

> "keep it simple, no new abstractions"

> "what would you remove?"

## Kit

Skills:

- `grilling`, used 12 times
- `tdd`, used 8 times
- `code-review`, used 6 times
- `diagnosing-bugs`, used 5 times
- `vercel:deploy`, used 2 times (skill `deploy` from the `vercel` plugin; if it is missing, suggest `/plugin install vercel`)

MCP servers:

- `playwright`, used 6 times

If one is not connected, tell the user it can be added with `claude mcp add` and carry on without it.

Subagents: Maya's sessions use subagents 40% of the time, mostly `Explore`, `general-purpose`, on `sonnet`. Delegate the same kinds of work the same way.

## Their CLAUDE.md

Maya's own standing instructions to Claude. Follow them unless this project's CLAUDE.md or the user says otherwise.

```markdown
- Use pnpm, not npm.
- Prefer early returns over nested ifs.
- Never commit .env files.
```
