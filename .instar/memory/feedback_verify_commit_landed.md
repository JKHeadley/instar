---
name: Verify commit actually landed before claiming shipped
description: Use git branch --contains before asserting "shipped on main"; rebase/reset can silently orphan direct-to-main commits
type: feedback
---

**The rule**: Before announcing a fix is shipped to production, verify the commit actually landed on main using: `git branch --contains <sha>`. Do NOT rely on seeing "direct push" output or CI completion logs.

**Why it matters**: Direct-to-main commits can be silently orphaned if:
- A rebase occurs between your push and the final state
- A local reset happens in the shared checkout before your push fully propagates
- CI completion logs show green but the merge wasn't actually finalized

**How to apply**: After a direct push to main (or after a PR merge):

```bash
git branch --contains <commit-sha>
```

If `main` is in the output, the commit is safe. If not, the commit is orphaned — recover it and re-push.

**Preference**: Use PR path (branch → PR → CI → merge → auto-squash) rather than direct-to-main. Merge commits and CI protection make orphaned commits impossible. Direct-to-main is only for trivial, pre-tested fixes.
