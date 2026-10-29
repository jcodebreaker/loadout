---
name: incognito
description: Leave this session out of your loadout.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" incognito ${CLAUDE_SESSION_ID}`

Tell the user in one line what happened, using the output above.
