# Re-arming two tests that were never actually flaky

## What this is

`vitest.push.config.ts` keeps a list called `FLAKY_TESTS`. Everything on that list is *excluded* from
the test run that CI uses as its gate. The idea is reasonable: a test that fails randomly is worse
than no test, because it trains everyone to ignore red.

Two entries on that list are not flaky. `tests/unit/agent-registry.test.ts` and
`tests/unit/builtin-manifest.test.ts` were removed from the exclusion list so they run again.

## Why they were on the list

Not because anyone measured them. Both arrived in one commit — `f193df789`, *"exclude pre-existing
flaky tests from push gate"* — a bulk exclusion that swept up a batch of tests at once. They landed
under a heading that reads "Environment-dependent / non-deterministic", and from then on that heading
read like a finding about each individual test rather than what it was: a label applied to a group.

## How we know they are fine

They were measured, not assumed. On current `main`, three consecutive runs each:

- `agent-registry.test.ts` — 42 passed, 42 passed, 42 passed
- `builtin-manifest.test.ts` — 9 passed, 9 passed, 9 passed

There was also a specific, plausible theory for why `builtin-manifest` might be environment-dependent:
it reads `src/data/builtin-manifest.json`, which is a generated file that is not committed to git. A
CI job that never runs a build would not have that file, so the test would fail — which is exactly
what "environment-dependent" would mean.

That theory was tested by deleting the file and running the test. **It still passed, 9 out of 9.**
The test's own setup step regenerates the file if it is missing. It was already written to be
self-sufficient, so the theory was wrong.

## Why this matters more than two test files

The comment sitting two lines below these entries already describes this exact mistake happening
before. On 2026-06-05, two other tests were re-armed from the same heading, with the note that the
"environment-dependent" label had been wrong — and that both had **rotted while parked**. Real
problems had crept into the code they were supposed to guard, precisely because nothing was running
them.

So the codebase already contained the diagnosis, the precedent, and the warning — three lines above
two more tests carrying the same wrong label. Writing a lesson down next to the unfixed case did not
fix the next case. That is why the replacement comment in this change is unusually detailed: it
records the measurements and the falsified theory, so the next person to reach for the label has to
argue with evidence rather than re-apply a heading.

A guard that exists but never runs in the job that matters is not a guard. It is a decoration that
makes everyone feel guarded.

## What could go wrong

These tests now run in CI, where they have not run for some time. If either fails there despite
passing locally, that is a real finding about the code or the CI environment — and the correct
response is to investigate it, not to put the test back on the list.
