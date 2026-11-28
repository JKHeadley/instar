<!-- bump: patch -->
# The Constitution Check Says When It Did Not Check

## What Changed

The built-in constitution check used to judge only the first 24,000 characters of a longer spec and report on the whole thing. It now always sends the whole spec, with no cap. If the model cannot take a spec that long, the result says plainly that the spec was not checked. It never judges part of a spec. A check that could not run, for whatever reason (too long, no model provider, a failed call, an unreadable reply), now always says it was not checked: the response carries `checked: false` and a plain `notChecked` reason, the fit judgment reports `not-checked` instead of `fit`, and the record kept for approval requests is marked not checked with its reason. Such a run no longer counts as evidence that a spec went through review, and the `instar spec conformance` command prints "NOT CHECKED" and exits with status 2.

## What to Tell Your User

When I tell you a design passed the constitution check, that now always means the whole design was sent to the check and the check finished. If it could not, for example because the design was too long, I will say so instead of reporting a clean result.

## Summary of New Capabilities

The conformance route returns `checked` (and `fitChecked`) and, when not checked, `notChecked`. Reports carry `charsJudged` and `charsTotal`. The approval-request record keeps a tally of every run of the same text (how many, how many did not check, and the findings counts seen), and the approval reviewer holds a request that reports one run as the result while others of the same text differ. A spec file over the 12 MB input ceiling is refused with 413 and `checked: false` before it is read, never read in part. The tally adds up every machine's runs of the same text, keeps the tallies of the last three earlier texts, and is shown to the approval reviewer whole. Both of the check's model calls now run on the locked-down reviewer path: on Claude the spec goes over standard input instead of the command line, so it no longer shows in the process list or hits the system's argument limit. The fit judgment now gets only the time left in the route's 180-second budget, so a slow review ends as a stated not-checked fit rather than a timeout, and the command waits 200 seconds and reports a timeout as NOT CHECKED (exit 2), as it does a fit judgment that did not run. Installed spec-converge skills receive the new guidance block on update. The fit verdict gains `not-checked`. The approval-request reviewer holds a message that reports a clean result from a record marked not checked.

## Evidence

Unit tests cover a 200,000-character spec reaching the model whole, a provider too-long error reported as not checked, a plain reason on every degraded review, `not-checked` fit verdicts, the per-text run tally, the CLI exit codes, and the skill migration. Integration tests cover the route's `checked`/`notChecked` fields, the ledger's degrade reason, that only a real check counts as ceremony evidence, that an over-ceiling spec file is refused without a model call, and, through the real Claude provider, that the whole spec travels on standard input and none of it in the arguments. Earned 2026-11-27: a 67,000-character spec was judged on its first third, and degraded runs were reported as zero findings.
