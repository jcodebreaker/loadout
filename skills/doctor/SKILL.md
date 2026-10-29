---
name: doctor
description: Check that loadout is set up and say what to do next.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" doctor`

Show the output above as is, with no commentary.
