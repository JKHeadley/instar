---
name: "Finish it out" means MERGED + verified
description: When user says "finish it out", execute autonomously to completion (merged on main, CI green). Never stop at "PR opened".
type: feedback
---

**The rule**: The phrase "finish it out", "keep going", "let's continue", or "complete this" means: **drive the full scope to merged on main with CI passing, autonomously, without intermediate check-ins.**

**Why it matters**: Stopping at "PR opened" invites the user back into a review cycle, breaking autonomy. The scoped approval is authorization to complete the entire phase, not just begin it.

**What counts as "done":**
- ✓ Code committed and pushed to main
- ✓ CI pipeline passed (tests green)
- ✓ Feature verified working in production
- ✓ Rollback plan documented if needed

**What does NOT count:**
- ✗ "PR opened, let me know when you're ready to review" (mid-scope checkpoint)
- ✗ "I've built the API, now someone needs to do the frontend" (orphaned phase)
- ✗ "CI is passing, waiting for manual approval" (without explicit guard clause)

**How to apply**: When given "finish it out" scope, check the durable artifacts (plan file, ledger) and drive to completion. Report once at the end, not per-commit or per-PR. If blocked by something unforeseen, message ONCE with the blocker and ask how to unblock; if you can unblock it yourself, do so and keep going.

**Origin**: Message 7517 (2026-04-19T19:16:37Z) — "when I say let's finish it out I mean finish it out. Don't keep checking back in on me. This is getting really frustrating. I don't wanna have to keep handholding everything."
