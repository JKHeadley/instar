---
name: Worktree-default for shared repos
description: When resuming work in the instar repo, first action is git worktree add — never operate on the shared checkout
type: feedback
---

**The rule**: When returning to work in `/Users/justin/Documents/Projects/instar/` (shared repo used by multiple agents), immediately create a git worktree isolation layer. NEVER inspect code, make commits, or test in the main checkout.

**Why it matters**: The instar repo is accessed by multiple agents and processes concurrently. Direct modifications to the shared checkout cause:
- Concurrent test-file collisions (one session's uncommitted tests break another's push)
- State pollution (git index state, uncommitted changes visible to concurrent processes)
- Destructive resets affecting other sessions

**How to apply**: On resume, before any other action in the instar repo:
```bash
git worktree add ../instar-<branch-name>
cd ../instar-<branch-name>
```

Then proceed with work. When done, clean up: `git worktree remove`.

This pattern isolates your changes and prevents cross-session interference.
