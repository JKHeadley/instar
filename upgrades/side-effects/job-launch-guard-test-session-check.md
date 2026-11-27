# Side-Effects Review — memory-guard e2e case checks the refused job's own session

**Version / slug:** `job-launch-guard-test-session-check`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, test-only. 1 test file (7 added lines, 1 removed) plus this artifact, an ELI16 and an internal-only release note. Effort: no spec, one attempt. In `tests/e2e/job-launch-lifecycle.test.ts`, the "memory gate closed" case (added in PR 3217 a few hours earlier, by the same author) asserted that the mock binary's argv log held exactly one `--launch--` line. The mock logs every invocation, so a second invocation from the first job on a loaded machine failed the case on a correct product (PR 3227's Local Verify run on the Mac Studio, 2026-11-16T11:54Z). The assertion is replaced by a tmux query for a session whose name contains the refused job's slug.

## Decision-point inventory

No product decision point is changed. The scheduler memory gate is exercised, not modified.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Coverage view: a refused job that somehow launched a process without a tmux session would no longer be caught by this case; job sessions are always started inside tmux by the session manager, and the case still asserts the 409, the single memory-pressure skip and the empty run history.

---

## 3. Level-of-abstraction fit

Right layer: the defect was the test asserting on a shared log's total instead of on the job under test.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Test-only.

## 4b. Judgment-point check (Judgment Within Floors standard)

No heuristic added at any decision point.

---

## 5. Interactions

The guard job's slug contains the first job's slug, so the file's existing tmux cleanup still covers it. A missing tmux server is treated as "no session", which is correct for this assertion.

---

## 6. External surfaces

None. No operator surface touched (6b not applicable).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local BY DESIGN: a test; the change exists so its result does not vary with the load on the machine that runs it. No notices, durable state, URLs or status surfaces.

---

## 8. Rollback cost

Revert the test change. Nothing persistent.

---

## Conclusion

Corrects an over-broad assertion introduced by the author in PR 3217 that produced a wrongful failure within hours. Clear to ship.

---

## Second-pass review (if required)

Not required: test-only, no decision point changed.

---

## Evidence pointers

- Studio run-detail for PR 3227, 2026-11-16T11:54:24Z.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
