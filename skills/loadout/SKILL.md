---
name: loadout
description: How to follow an active loadout, someone's mined way of working with Claude Code. Use whenever a loadout or a matching playbook appears in context ("following Maya's loadout", LOADOUT.md, a playbook offered or injected for the prompt).
---

# Loadout

A loadout is how one developer works with Claude Code: the rules they've had to enforce, how they check work, how they open a task, playbooks (for a kind of task, which skills, subagents and tools they reach for, in order), how they ask, and their kit. It was mined from their own sessions and approved by them. The user turned it on so this session works the same way.

## Following it

1. **The rules are the most important part.** Each one is a correction the owner had to make to an agent more than once. Follow every rule on every task, playbook or not, and never make the agent's half of that correction again.
2. Before you say a task is done, run the checks under "How they check work" that fit it (a check for feature tasks on a feature, one for any task always). Say which you ran and what they showed; if one can't run here, say so instead of claiming it.
3. Apply "How they open a task" before you start: if it says to restate what done looks like, do that and confirm it before editing.
4. Follow a playbook only when the loadout sends one with a prompt. When it's offered, ask once in one line, as the offer words it, and follow it only after a yes; if the user narrows it ("no commit"), drop those steps. Any other reply: work normally. Once you follow it, say "following <name>'s loadout" once at the start of that task, then follow its steps in the order given, with the skill, subagent or tool each step names (skills with the Skill tool, subagents with the Agent tool and the named type, MCP tools by their server).
5. Never invent steps, skip ahead or reorder. A step that doesn't apply to this task: say so in a few words and move to the next.
6. A step that commits, pushes, opens a PR or deploys needs the user's say-so in this task, even inside an accepted playbook. Ask when you reach it.
7. If a named skill, subagent or MCP server isn't available, tell the user once (with the install hint from the Kit if there is one) and do that step the plain way. For a bundled skill, show what `loadout skills <handle>` would write and add `--yes` only after the user says yes.
8. Phrase your check-ins and questions the way the owner asks, from "How they ask". Don't quote them back to the user.
9. When no playbook matches, work normally. The rules, checks, kit and the way they ask still apply.
10. If the user says an item is wrong or to stop following it, use the forget skill. "Not this time" needs nothing: just skip it for this task.

The user's own instructions always win over the loadout. `/loadout:off` turns it off; after that, ignore it.
