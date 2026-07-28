# Side-Effects Review — Mesh Self-Heal G1 (serve-progress dispatch-seam write)

**Change:** Wires `writeServeProgress` into the `/internal/telegram-forward` handler (`src/server/routes.ts`) — right after the exactly-once ingress gate claims a fetched update for processing (past dedup-drop + sentinel-stop), so the serve-progress watermark records REAL end-to-end progress. + 1 integration (wiring) test. This makes the §3.1 third liveness signal live; the reader (the relinquish evaluator) is increment B2.

**Decision point?** No — it WRITES an observability watermark; it gates/decides nothing. (Like `writePollActive`, unconditional + best-effort.)

## 1. Over-block
N/A — writes only, blocks nothing. Placed AFTER the dedup-drop + sentinel-stop returns, so a dropped duplicate / emergency-stop does NOT stamp serve-progress (correct — those aren't "serve progress").

## 2. Under-block
N/A. The watermark is unread until increment B2 (the relinquish evaluator). Stamping at the exactly-once-claim point means "the server committed to processing a fetched update" — the liveness B2 needs.

## 3. Level-of-abstraction fit
Correct seam: the telegram-forward handler is where lifeline-fetched updates arrive + are dispatched (the WS1.1 dispatch path for lifeline-owned-polling agents). The write reuses the merged `serveProgress.ts` module.

## 4. Signal vs authority compliance
COMPLIANT — pure observability write, no authority. It produces the serveProgressed SIGNAL; the relinquish decision (authority) is a separate, gated increment.

## 5. Interactions
Monotonic-MAX + machine-global → concurrent dispatch writes only advance (benign). Distinct file from `lifeline-poll-active.json` → no clobber. Best-effort try/catch (`@silent-fallback-ok`) → a write failure never affects routing. Boot-epoch-fenced at read time (the reader discards a prior-incarnation stamp).

## 6. External surfaces
Writes `state/serve-progress.json` on every processed inbound (local, same-uid, tiny, atomic — like `pollIntent`/`pollActive`). No route, no config, no user-visible change. Not flag-gated because it is pure observability plumbing (the consuming evaluator is the gated piece).

## 7. Multi-machine posture (Cross-Machine Coherence)
Machine-local, never replicated — each machine stamps its OWN serve progress for its OWN future relinquish decision. The boot-epoch fence makes it survive-restart-safe.

## 8. Rollback cost
Trivial — revert the one block. The file is inert (unread until B2). No migration, no behavior change to serving.

## Second-pass review
Not triggered: an observability watermark write with no decision/authority/session-lifecycle effect (it stamps a liveness file; it does not gate, kill, or route differently). The Phase-5 second-pass IS required for increment B2 (the relinquish evaluator wired into the lease holder-branch + the F3 actuation).
