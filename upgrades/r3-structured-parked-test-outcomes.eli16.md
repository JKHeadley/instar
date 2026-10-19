# Parked-test rechecks use facts, not display wording — Plain-English Overview

> The one-line version: when Instar samples tests that have been quarantined, it now uses Vitest's
> machine-readable result to tell a real test failure from a runner that could not finish.

## The problem

Instar keeps a quarantine list for tests that are known to be unreliable in a particular environment.
A small reporting script periodically samples that list. Its job is informational: show which tests
still fail, which now pass consistently, and which could not be checked. It never edits the list and
never blocks a push or merge.

The script previously decided whether a nonzero Vitest run represented a failed test by searching the
human summary for wording like “Tests 1 failed.” That summary is designed for people, not programs.
If Vitest changed a label, added decoration, or a wrapper translated “Tests” to “Checks,” the test
could execute and genuinely fail while the script reported only “could not run.”

## Why that matters

This is not a false green build. The script always exits successfully by design, CI remains the merge
authority, and no required test shard is directly bypassed by this command. The damage is slower and
second-order: a real failure mislabeled as an execution problem is not learned as a real failure. The
test simply stays parked. As the quarantine becomes less accurate, it can continue narrowing the CI
shards while nobody gets a trustworthy signal about which exclusions are still justified.

## What changes

Each sampled run now asks the pinned Vitest version for both its normal human output and a JSON report
written to a fresh temporary file. The script classifies a failure only when the process finished,
Vitest says the run was unsuccessful, the structured counts include a failed test, and a failed
assertion is present. A pass likewise requires a successful process, consistent counts, and an observed
passing assertion.

Everything else remains unknown rather than being guessed. The report says whether the runner never
started, failed to complete, produced no report, produced unreadable or invalid JSON, ran zero tests,
or disagreed with its own exit status. Those cases still appear as `could-not-run`, with a reason that
makes the missing evidence visible.

## What does not change

The command remains a signal. It always exits zero, never re-arms a quarantined test, never edits CI,
and never claims that a local pass proves the test is safe everywhere. Re-arming remains a human
judgement informed by this more accurate observation. The repair gives the signal better facts without
turning it into a gate.

## Evidence

The negative control used a real failing Vitest test while changing only the displayed word “Tests” to
“Checks.” The old script mislabeled it `could-not-run`; the repaired script classified it `fail` from
the unchanged JSON evidence. Separate real-run controls preserved `pass`, classified a missing runner
as `errored`, and classified a deliberately corrupted JSON report as `errored` rather than inventing a
test result.

## CI5 follow-up: colour is presentation too

The original proof also checked that the wrapper visibly printed “Checks 1 failed.” In GitHub Actions,
Vitest inserted terminal-colour instructions between those words and numbers. People still saw the
same sentence, but the test's plain-text expression could not jump over invisible control bytes.

The check now removes only those terminal instructions before making the same two demands: the summary
must say “Checks 1 failed,” and it must not say “Tests 1 failed.” A deliberately wrong-worded wrapper
is still rejected. This does not change how parked-test outcomes are decided; JSON remains the decision
source, while rendered output is checked only for the wrapper's separate display contract.
