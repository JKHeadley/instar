# The Inspector Now Actually Gets Called — Plain-English Overview

## What happened

Three weeks ago we built an inspector that reads our constitution and checks every
new plan against every rule — exactly the tool you'd want guarding a growing
codebase. Then it sat unused: callable by hand, called zero times. The operator
spotted this today and asked the uncomfortable question: what's the point of
building something and not using it?

The honest root cause: the plan to wire it into the review process was written down
as a sentence in a document, not as a tracked task anyone owned. Sentences don't
re-surface themselves. Nineteen days of silence later, the only reason it came up
at all was the operator reading carefully.

## The fix

Two layers. First, the wiring itself: every spec review now calls the inspector
automatically as a built-in step — its findings are handed to the human-style
reviewers, and every review report must record either "inspector ran, found N
flags" or an honest reason it couldn't run. Skipping it silently fails the report.
Second, the deeper problem: of our 22 constitutional standards, only ONE currently
has real machinery enforcing it — the other 21 are still well-written wishes. That
cleanup is now a tracked, operator-visible program (CMT-1426) with a weekly cadence,
so it can never again quietly rot in prose.

## What changes for you

Nothing visible day-to-day. Spec reviews get one more automatic input; deployed
agents receive the updated review instructions on their next update; and the
constitution document now tells the truth about what is and isn't enforced.

## The honest cost

About a minute per spec review round, and the discipline of recording when the
inspector couldn't run. Cheap insurance against the exact failure that just
happened: building a guard and forgetting to post it at the door.
