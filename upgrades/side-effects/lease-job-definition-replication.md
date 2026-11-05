# Side-Effects Review — private job definition transfer

**Date:** 2026-11-05  
**Author:** echo

## Summary

The feature is dark by default. A source exports only an explicitly portable user job, its matching body, and declared project dependencies after PIN approval for the exact content root. The registered recipient verifies a signed, nonce-bound, key-epoch-bound encrypted answer, quarantines it, and requires its own PIN approval before activation. Git-sync and token-bearing configuration remain outside the transfer.

## 1. Over-block

A portable script or skill must declare its executable path, and any secret-like dependency name, symlink, special file, directory over the depth cap, or bundle over size limits is refused. Python 3 is required for descriptor-relative file operations; its absence causes a visible transfer gap. This may require an operator to narrow the declared dependency set.

## 2. Under-block

The source cannot identify a secret stored under an innocuous approved path, so the export preview lists each file and hash and requires an exact-root PIN approval. A local process with the same user permissions can race an imported file update; the helper checks the prior hash and protects each path component against symlinks, but no portable filesystem compare-and-swap exists for a concurrently replacing local leaf. Admission rehashes every imported file before launch; local writers remain trusted with project write access. Cross-machine exactly-once execution remains governed by the lease and promotion catch-up policy.

## 3. Level-of-abstraction fit

The coverage monitor supplies signed catalog evidence and durable gaps. The source projects and encrypts bytes; the recipient controls installation; the scheduler owns run admission. Peer data cannot directly launch a job. The private file helper is the containment boundary for project paths.

## 4. Signal vs authority compliance

A coverage observation and bundle are signals about what another machine has. Only local exact-root approval, an active import journal, an unchanged file set, and the live scheduler lease admit execution. Transfer failure or uncertainty creates an alert; it does not grant peer authority.

## 5. Interactions

The source handles at most one bounded descriptor-relative dependency collection per bundle request. A durable cursor rotates through advertised portable jobs. Transfer status is indexed so the five-minute coverage check does not scan inbox bundles. Import pauses scheduler admission, writes a pending journal and latch before file changes, installs the manifest last, commits an active journal, and refreshes before resuming. The loader withholds pending, revoked, disarmed, or changed imported manifests. Before a trigger, the scheduler verifies every imported file hash.

## 6. External surfaces

The authenticated peer route returns only recipient-encrypted bundles. Operator preview routes show file paths and hashes to the local operator; PIN-gated routes approve, revoke, roll back, and re-arm. Public pool status and alerts show slugs and gap reasons, not file bodies, token values, or raw dependency paths.

## 7. Multi-machine posture

Standby machines can stage private copies before lease promotion. Source updates change the content root and require renewed source and recipient approval. The recipient will not overwrite a separate local job or a locally changed imported file. Offline or old peers leave coverage uncertain and alert the current holder.

## 8. Rollback cost

The live PIN-gated rollback route persists a disarm latch, pauses scheduler admission, and quarantines journal-proven manifests. The packaged emergency script requires the agent to be stopped, checks the startup marker, and moves only hash-matching imported manifests. It leaves dependency bytes for inspection; the prior Instar version can then be restored without running the imported definitions. Re-arming requires a PIN and no pending apply latch.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `enforcementType: ratchet`, `citation: tests/unit/self-action-convergence.test.ts`. The registered portable transfer controller models a five-minute non-overlapping batch with a durable cursor and rate floor. The focused tests cover source projection, secret-like path refusal, no-follow parent handling, signed recipient-bound transport, exact-root approvals, quarantine, conflict preservation, full-size updates, interrupted apply withholding, and changed-dependency admission refusal.

## Second-pass review

Concur with the review. Independent code and integration reviewers found no remaining peer-trust or crash-recovery merge blocker after the final pass. The same-user concurrent leaf replacement race is recorded under Under-block as a local concurrency limitation. Final focused and lint gates remain required before merge.
