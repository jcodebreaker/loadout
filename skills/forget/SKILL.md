---
name: forget
description: Drop one rule, check or playbook of the active loadout for good, or bring one back. Use when the user says a loadout item is wrong, doesn't fit, or to stop following it; or asks to restore one.
argument-hint: [what to forget or restore]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" forget && node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" restore`

The first list above is what can be forgotten, the second what is already forgotten, one `ref  text` per line. Pick the item the user means and run `node "${CLAUDE_PLUGIN_ROOT}/bin/loadout.mjs" forget <ref>` (or `restore <ref>`). If two could fit, ask which, naming them by their text. Tell the user in one line what changed.
