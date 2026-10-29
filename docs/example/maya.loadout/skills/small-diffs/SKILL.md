---
name: small-diffs
description: Keep a change to what the task needs. Use before you commit, or when a diff looks bigger than the task.
---

# Small diffs

1. Read the whole diff with `git diff`.
2. Take out anything the task didn't ask for: renames, reformatting, drive-by refactors, new helpers used once.
3. If something unrelated really needs fixing, say so in one line and leave it for its own change.
4. Say how many files and lines changed, and why each file is in the diff.
