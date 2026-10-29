---
name: off
description: Turn off the active loadout.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" off`

Tell the user in one line what happened, using the output above. From now on, stop following any loadout and its playbooks in this session.
