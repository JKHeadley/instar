# Side-Effects Review — window-run ticks serialize instead of returning a stale snapshot

**Version / slug:** `window-run-tick-serialize`
**Date:** `2026-10-05`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

`WindowRunLivenessAuthority.tick()` and `WindowRunCadenceExecutor.tick()` replaced an
in-process `ticking` boolean ("if already ticking, return `store.load()`") with a shared
`TickSerializer` (`src/core/TickSerializer.ts`). An overlapping caller now waits and gets
an evaluation that started at or after its call; at most one evaluation runs and one is
queued, and callers arriving while one is queued share it. The old guard handed an
explicit HTTP caller a mid-flight read whenever the server's own background tick (boot +
every 60s, `AgentServer.ts` `tickWindowRun`) was running; for the cadence executor before
its first save that read is `null`, which `POST /window-run-liveness/cadence/tick` returns
as `404 not registered`. That is the root cause of the
`tests/e2e/window-run-liveness-production-wiring.test.ts` "identity keypair is mismatched"
flake (404 vs 200 under load, passes in isolation). Files: the two classes, the new
helper, three unit test files.

## Decision-point inventory

- `WindowRunLivenessAuthority.tick` — modify (scheduling only) — when two ticks overlap, the second now runs after the first instead of being skipped. The liveness decision logic inside the tick is untouched.
- `WindowRunCadenceExecutor.tick` — modify (scheduling only) — same; checkpoint/interval/report/failure-notice logic untouched.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Callers are delayed by at most one
in-flight tick, never refused.

---

## 2. Under-block

No block/allow surface. Residual: a caller still receives `null`/404 when there is
genuinely no cadence yet (run not active) — that is the correct answer, not a stale one.

---

## 3. Level-of-abstraction fit

Right layer. Overlap is an in-process scheduling concern of the object that owns the
tick; the cross-process concern is already owned by the proper-lockfile mutation lock,
which is unchanged. Fixing it in the route (retry on 404) would have hidden the stale
read for one caller and left the liveness route and future callers exposed. The helper
is shared because both classes had the identical guard (class fix, not instance fix).

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It changes when an existing authority evaluates, not what it decides.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "One running + one
queued" is an invariant on concurrency, not a judgment.

---

## 5. Interactions

- **Shadowing:** none — no check is added.
- **Double-fire:** previously an overlapping tick was dropped; now it runs afterwards. Could a second evaluation repeat a side effect? Every side effect inside a tick is already idempotent across ticks because ticks run every 60s anyway: checkpoints are keyed by `dueAt` and skip `delivered`/`would-request` or a pending backoff; reports are keyed by `reportId` and re-query delivered history; failure notices check `failure.notified` and the stable marker; liveness recovery is a durable single-attempt record (`recoveryAttempt`). The new unit test asserts the overlapped cadence tick requests the checkpoint exactly once.
- **Races:** the in-process serialization sits outside the file lock, so a tick never waits on the lock while another tick from the same process holds it (previously the flag already prevented that). `register()` / `recordWorkAdvance()` / `freeze()` still take the lock directly and are unaffected; the existing "concurrent tick and work receipt" test still passes.
- **Feedback loops:** none. Queue depth is bounded at one, so a slow or hung tick cannot accumulate periodic ticks; later periodic callers share the queued one.
- **Hang behavior:** if a tick hangs, an explicit caller now waits behind it instead of returning instantly. The route is under the server's request timeout (`requestTimeoutMs`), and the inner work is already bounded (lock retries, delivery attempts), so this does not create an unbounded wait the old code avoided in practice.

---

## 6. External surfaces

- HTTP: `POST /window-run-liveness/tick` and `POST /window-run-liveness/cadence/tick` may take slightly longer when a background tick is in flight and return fresh state; the 404 "not registered" during first creation no longer occurs. Response shapes unchanged.
- No persistent state format change, no config, no messages to users, no operator-facing actions.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the serializer is per-process scheduling around per-machine
window-run state that is already gated by session ownership (`canAct`) and the file
lock. No notices, durable state, or URLs are added.

---

## 8. Rollback cost

Pure code revert of three source files; no state, config, or migration. Rollback
re-introduces only the stale-read race.

---

## Conclusion

Root cause found and fixed at the owning layer in both classes that shared it; the e2e
test needed no change. Reproduced at 1/8 under CPU load before, 0/25 after. Clear to ship
pending the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only)
**Independent read of the artifact: concur**

Concur with the review: the serializer always settles its queue (a synchronous throw becomes a rejection and a failed tick cannot leak an unhandled rejection to the queued caller); nothing inside either tick calls `tick()` re-entrantly (the AgentServer deps use only `status()` and `sendInput`); the only callers are the background tick and the two routes, none relying on the old skip; and every action an overlapped re-run could repeat is already guarded by durable state (`failure.notified`, the single `recoveryAttempt`, `notifyOnce`, checkpoints keyed by due time).

---

## Evidence pointers

- Pre-fix under a 24-process CPU burn (16 cores): 7 pass / 1 fail; failure log shows `expected 200 "OK", got 404 "Not Found"` at the keypair-mismatch test, line 247.
- Post-fix under the same burn plus a parallel `vitest --config vitest.e2e.config.ts` run of two other e2e files: 25 pass / 0 fail.
- `tests/unit/window-run-cadence-executor.test.ts` and `tests/unit/window-run-liveness-authority.test.ts` overlap tests: fail on the old code (verified via `git stash`), pass on the new. `tests/unit/tick-serializer.test.ts`: 5 tests. Integration `window-run-liveness-routes` + `window-run-cadence-lifecycle-proof`: pass. `tests/unit/self-action-convergence.test.ts`: 213 pass.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a TypeScript concurrency defect).
The cadence executor is a registered self-action controller; this change does not add
or widen any action it takes — it bounds overlapping ticks to one running plus one
queued, and every action remains behind its existing durable per-key dedupe. The
`tests/unit/self-action-convergence.test.ts` ratchet passes unchanged.
