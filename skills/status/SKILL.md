---
name: status
description: Show which loadout is on.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" status`

!`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" list`

Tell the user in one or two lines what the output above says: which loadout is on, if any, and which others are on this machine. `/loadout:use <handle>` switches, `/loadout:off` turns it off.
