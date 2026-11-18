# Side-Effects Review — Restart proof waits for the server to finish starting (CMT-1199)

**Version / slug:** `restart-proof-boot-ready`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required: a read-only proof row gets stricter; nothing acts on it`

## Summary of the change

Machine self-maintenance Part D, post-restart proof, the server row. With listen-early (PR 3270) the port opens before the server has finished starting, and `GET /health` answers the boot beacon's 503 (`x-instar-boot-state: starting`) until it has. The row now:

- passes only on 200 with `bootReadiness.state === 'ready'` (`health-200-ready`);
- reads the beacon's 503, or a 200 still saying `starting`, as **unknown** (`server-still-starting`). The next attempt reads it again; past the proof's bound (5 attempts, 10 minutes) an unknown row fails the proof with that reason;
- fails on any other status or no answer, as before.

The judge is the pure `serverHealthFromResponse()` in `PostRestartProof.ts` and uses `isPeerBooting()` from `BootReadiness.ts`. `server.ts` passes the response headers through its local `getJson`.

## Decision-point inventory

- Proof server row — modify — "200" becomes "200 and finished starting"; still starting is unknown, not fail.

## 1. Over-block

None: a server that answers `ready` passes as before. A 200 with no `bootReadiness` (not possible on this build) reads unknown rather than pass.

## 2. Under-block

A server still starting at the first attempt no longer fails it outright; it must be ready within the proof's own ten-minute bound.

## 3. Level-of-abstraction fit

The judge sits beside `runChecks` in the proof module; the boot-state test reuses the one helper 3270 shipped for it.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new judgment authority. The proof is a record; it restarts and blocks nothing.

## 4b. Judgment-point check

None.

## 5. Interactions

- `GET /machine-maintenance` → `restartProof.lastProof.checks.server` shows the new reasons.
- The Restart now / scheduled restart paths do not read this row yet.

## 6. External surfaces

None new. The proof's existing read of its own `/health`.

## 6b. Operator-surface quality

Reasons stay internal (proof record and log).

## 7. Multi-machine posture

**machine-local BY DESIGN**: each agent proves its own server after its machine's boot.

## 8. Rollback cost

Revert the code; the row goes back to "200 passes".

## Conclusion

The restart proof no longer calls a server "back" while it is still starting. Clear to ship.

## Evidence pointers

- Unit: `tests/unit/machine-restart-proof.test.ts` (ready passes; beacon 503 and 200-starting unknown; other answers fail; in the proof, still starting keeps it running then passes when ready, and fails at the bound with `server-still-starting`).
- E2E: `tests/e2e/machine-maintenance-lifecycle.test.ts` (the real `/health` of an AgentServer passes the judge; `server.ts` wires the judge).
- Integration: no route changed; `tests/integration/machine-maintenance-route.test.ts` unchanged.

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard` — no self-action added; the proof only reads (`src/testing/selfActionRegistry.ts`, proven by `tests/unit/self-action-convergence.test.ts`, enforcement: ratchet).

## Second pass: the watch-only folder stays sealed

Local Verify failed `tests/unit/machine-maintenance-watch-only.test.ts`: PostRestartProof.ts imported `src/server/BootReadiness.js`, which is outside that folder's import allowlist (BootReadiness also reads files and holds the boot tracker). The fix does not widen the allowlist. `serverHealthFromResponse` now takes the boot check as an argument, and `server.ts` passes `isPeerBooting`; the tests pass the same real function. Behaviour is unchanged.
