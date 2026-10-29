---
name: use
description: Turn on someone's loadout so this session works the way they work.
argument-hint: <handle|path>
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" *)
---

## The active loadout

<!-- One line on purpose: separate ! lines don't run in order, so status could read the state before use wrote it. -->
!`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" use $ARGUMENTS && node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" status --md`

Tell the user in one line what happened, using the output above: whose loadout is on and its playbooks, or why it didn't load. If it loaded, follow it from now on as the `loadout` skill describes. New sessions load it on their own until `/loadout:off`.
