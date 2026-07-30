# Pre-messaging check no longer blocks "there is nothing"

## What Changed

The pre-messaging quality gate (`convergence-check`) has a **settling** rule that
catches an agent reporting an empty result without digging — "there is no data",
"nothing was found". It searched for the phrase `there (is|are) no` with no trailing
word boundary, so it also matched inside longer words that merely begin with "no":
**nothing**, **none**, **nobody**.

The result was that ordinary English got blocked. "There is nothing pathological
required" was treated identically to "There is no data available."

The rule now requires `no` to be a whole word, using the same guard idiom the adjacent
commitment rule already applies to `promise` (`([^a-zA-Z]|$)`).

**The same regex lived in three places** — the shell template, its TypeScript port
(`ConvergenceChecker`), and an inline fallback in `PostUpdateMigrator` used when the
template cannot be loaded. All three are corrected, and a new drift guard fails the
build if they ever stop matching each other. Fixing only the template would have left
the port broken and shipped the bug to any agent whose template load failed.

The genuine catch is preserved by a **different** branch of the same rule: "there is
nothing to report" still blocks, via `nothing (to report|happened|was found)`. That is
asserted by an explicit test, because it was the main risk of narrowing the pattern.

## Evidence

- 22 new unit tests. Run against the **unfixed** source first: **12 failed / 10 passed**
  there. So 12 assertions genuinely discriminate (6 false-positive cases across the
  shell and TypeScript implementations, plus 6 drift-guard assertions); the other 10
  pass either way and are labelled `CONTROL` in the test file rather than counted as
  evidence.
- Reproduced from a real incident: a second session of this agent, running on another
  machine, had a correct message blocked twice on "there is nothing pathological
  required" and reported it instead of rewording until something got through.
- Migration parity verified rather than assumed: `PostUpdateMigrator` writes
  `scripts/convergence-check.sh` unconditionally on every migration run, and the
  template was confirmed byte-identical to the installed copy before editing.

## What to Tell Your User

Nothing is required of you, and nothing changes in how you talk to your agent.

Your agent runs a quality check on its own messages before sending them, to catch
habits like giving up after one empty search. That check was mis-firing on the word
"nothing" — so an agent writing a perfectly good sentence like "there is nothing
unusual here" could be stopped and made to rewrite it for no reason.

That mis-fire is fixed. The check still catches the real thing it was built for; it
just no longer trips over three common words. You may notice slightly fewer moments
where your agent pauses and rephrases itself for no visible reason.

## Summary of New Capabilities

None — this is a correctness fix to an existing check. No new endpoints, config keys,
commands, or agent-facing surfaces. The only addition is an internal drift guard that
keeps the three copies of the rule in sync.
