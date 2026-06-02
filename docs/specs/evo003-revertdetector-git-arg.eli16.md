# RevertDetector's broken git flag (EVO-003) — Plain-English Overview

> The one-line version: RevertDetector passes git a flag git doesn't accept, so every scan throws and revert-detection has been a silent no-op fleet-wide — this deletes the one bad flag and proves the fix with a real-git test.

## The problem in one breath

RevertDetector is the part of the failure-learning loop that watches new commits for `Revert "..."` commits and opens a forensic record when it sees one (so a revert in production becomes a learnable signal instead of a silent unwind). It builds a `git log` command to find those commits — and that command includes `--regexp-ignore-case=false`. Git has never accepted a `=value` form for that flag; it rejects the whole command with `fatal: unrecognized argument`. So on every tick the call throws, the error is swallowed by the surrounding try/catch, the method returns 0, and **no revert is ever detected on any install**. It looks alive (it runs every tick) but it has never actually worked.

## What already exists

- **RevertDetector** — the monitoring component that scans recent git history for revert commits and feeds the FailureLedger. It runs on a tick, only when this machine holds the lease.
- **FailureLedger** — the durable store of failure/forensic records that the failure-learning loop reads from.
- **The swallow-and-return-0 error path** — RevertDetector already wraps its git call in a try/catch that logs the error and returns 0. That safety net is exactly what hid this bug: a hard-failing command looks identical to "no reverts found this tick."

## What this adds

This deletes a single bad argument. The `git log` invocation drops `--regexp-ignore-case=false`; case-sensitive matching is already git's default for `--grep`, which is exactly the behavior we want (matching subjects that start with `Revert`). A clear NOTE comment is added at the call site explaining why the flag must never come back, so a future well-meaning edit doesn't reintroduce it.

It also adds two regression tests so this class of bug can't silently return:

- **An argv-shape test** with an injected, arg-recording git runner that asserts the `git log` call contains no `=value` case flag, and that detection still fires once the flag is gone.
- **A real-git end-to-end test** that creates a temp repo, makes a commit, runs a real `git revert`, and asserts RevertDetector — driven by its *default* git runner — actually opens one forensic record. This is the test that would have caught the original bug, because a malformed argv makes real git exit non-zero.

## The new pieces

There are no new modules. This is a one-line deletion plus tests against the existing `RevertDetector` and `FailureLedger`.

## The safeguards

**Prevents the flag from coming back.** A NOTE comment at the call site spells out that git's `--grep` case flags take no `=value` form, so the next editor won't "helpfully" re-add it.

**Prevents a silent regression.** The argv-shape test fails loudly if any `--(no-)?regexp-ignore-case=` flag reappears in the scan command. The real-git test fails if detection stops firing for a genuine `git revert` commit — covering the failure mode (malformed argv → git exits non-zero → detection silently returns 0) that hid this for so long.

## What ships when

One PR: the code fix and both tests ship together. There are no phases and no follow-on layers. CI's full suite is the authority; locally the targeted unit tests, typecheck, lint, and build are all green.

## What you actually need to decide

Nothing blocking — this is a Tier-1 bug fix landing under standing preapproval. The only question is the obvious one: ship the one-line fix that turns revert-detection back on, yes?
