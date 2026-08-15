# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`instar dev:preflight` can now check your pull-request description, not just your
code changes.

It previously ran only diff-based checks (lint, discoverability, a route
heuristic), so the gates that read the PR *description* — the plain-English ELI16
summary and the UX-impact declaration — could never be caught locally. Those
gates only fail after you submit, because the description does not exist until
then. "I ran the checks locally and they passed" was true and still missed them.

Pass `--body <file>` (and optionally `--title <text>`) and preflight runs those
gates too.

## What to Tell Your User

- "You can catch a missing PR summary in a second locally instead of as a red
  mark after submitting."
- "If you haven't written the description yet, nothing fails — the check is
  skipped and says so."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Check the PR description before submitting | `instar dev:preflight --body pr-body.md --title "feat: ..."` |
| See explicitly that description checks were skipped | Run without `--body`; the summary prints `SKIPPED` and why |

## Compatibility Notes

Both inputs are optional and there is no behaviour change without them. Omitting
`--body` skips the description gates rather than failing them — running preflight
*before* writing a description is exactly when it is most useful. The skip is
printed rather than silent, because a silent skip reads identically to a pass.

An unreadable `--body` path fails the run: the caller asked for those gates and
they could not be run, so passing would be false confidence.

## Evidence

9 new unit tests plus the 5 existing preflight tests pass. They pin both
directions — supplying a body runs the gates (including that the body is actually
threaded through the environment, without which the gate would judge an empty
string and pass vacuously), a failing gate fails the run, a control confirms an
all-green run still passes, and omitting a body skips visibly.

Validated against a real defect: an actual PR body from earlier today, before its
ELI16 section was added, fails the real gate; the corrected body passes it.
