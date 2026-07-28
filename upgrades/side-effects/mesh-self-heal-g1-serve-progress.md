# Side-Effects Review — Mesh Self-Heal G1 (serve-progress watermark)

**Change:** The serve-progress watermark record (MESH-SELF-HEAL-SPEC §3.1) — `src/core/serveProgress.ts` (`writeServeProgress` / `readServeProgress` / `serveProgressFresh`) + 6 unit tests. The THIRD G1 liveness signal (`serveProgressedMonoMs` — end-to-end serve progress), in its OWN single-writer record `state/serve-progress.json` (it cannot share the lifeline's poll-active record without clobbering it). This is G1-wiring increment A: the watermark plumbing only. NOT YET CALLED by any writer or reader — ZERO runtime effect until increment B (the dispatch-seam write + the relinquish evaluator) consumes it. It is also the named **G2-enforce-enable prerequisite #1** (`localPollSucceededFresh` graduates from a liveness approximation to this real watermark).

**Decision point?** No — pure file I/O (a watermark record). Safety hinges on the boot-epoch fence (Q1/Q7).

## 1. Over-block
N/A — no gating. `serveProgressFresh` biases SAFE: missing record → false; bootId mismatch → false; only a same-incarnation in-threshold stamp → true.

## 2. Under-block
The boot-epoch fence is the guard against under-blocking (a crash-stale stamp masking a non-serving process): a prior incarnation's stamp (`bootId` mismatch) always reads NOT fresh. Tested.

## 3. Level-of-abstraction fit
Mirrors `pollIntent.ts` exactly (atomic tmp+rename, local same-uid IPC, integrity fields). Correct layer — a cross-process record + a pure freshness reader; the dispatch-seam wiring + the evaluator are increment B.

## 4. Signal vs authority compliance
COMPLIANT — pure I/O, no authority. It produces a freshness SIGNAL the relinquish decision will read; it never gates or actuates.

## 5. Interactions
Single-writer, monotonic-MAX → concurrent dispatch-seam writers are benign (only advances). Distinct file from `lifeline-poll-active.json` → no clobber of the lifeline's record. No reader/writer yet.

## 6. External surfaces
New file `state/serve-progress.json` (local, same-uid, like pollIntent). No route, no config. Written/read only once increment B wires it.

## 7. Multi-machine posture (Cross-Machine Coherence)
Machine-local, never replicated (Sca-F1) — read only by the owning machine for its OWN relinquish decision. The boot-epoch fence makes it survive-restart-safe (a prior incarnation's stamp can't mask the new one). No cross-machine surface.

## 8. Rollback cost
Trivial — revert the commit. Unreferenced; removing it cannot affect a running agent. The on-disk file (if ever written) is inert observability.

## Second-pass review
Not triggered (pure file-I/O building block, no live decision-point/authority/session-lifecycle touch). The Phase-5 second-pass IS required for increment B (it wires the dispatch-seam write + the relinquish evaluator into the lease holder branch + the F3 actuation).
