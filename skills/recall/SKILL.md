---
name: recall
description: Look up what the user did, decided or corrected in their own past Claude Code sessions on this machine. Use when they ask "what did I decide about X", "have I done this before", "how did I do X last time", "when did I last touch X", or "what went wrong with X before".
argument-hint: <what to look up>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" recall "$ARGUMENTS"`

Above: the user's past tasks that best match, best first, each with its date, repo, the steps used, what they corrected and decided, and how it ended. If it shows no tasks, or the words were not the topic, run `node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" recall "<two or three topic words>"` with the topic of the question, not the whole sentence (for "what did I decide about caching the reports?": `recall "cache reports"`).

Answer the question in one or two sentences from those lines, naming the date and repo. If none fits, say you found nothing on it in their past sessions; don't guess. It is their own history: quote their decisions and corrections as they wrote them.
