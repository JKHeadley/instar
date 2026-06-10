# Side-Effects Review — Model-Tier Escalation Policy (Opus 4.8 → Fable 5, framework-agnostic)

**Version / slug:** `model-tier-escalation`
**Date:** `2026-06-09`
**Author:** `Echo`
**Second-pass reviewer:** `pending (required — touches session lifecycle + routes)`
**Spec:** `docs/specs/FABLE-MODEL-ESCALATION-SPEC.md` (converged r4, approved by Justin)

> LIVING DOCUMENT during the build — finalized at /instar-dev Phase 4 before the
> closing commit. Each incremental commit updates the Files-touched inventory.

## Summary of the change

Implements the converged Model-Tier Escalation Policy: sessions default to their
framework's default model and escalate to the framework's ultra model
(claude-fable-5, first populated entry) only for the two spec-defined work-modes,
with launch-time escalation as the primary path and a narrow, server-side,
canary-verified mid-session swap. Fail-closed everywhere: the worst-case failure
of every component is "the session stays on its default model" (§3.5 —
a routing decision, never a block).

## Decision-point inventory

- `resolveTierModel` (src/core/ModelTierEscalation.ts) — **add** — routing-only resolver; rejects = null = default model. Hard-invariant validators (regex + closed enum) at the boundary — signal-vs-authority exempt class ("structural validators").
- `EscalationGovernor.admitEscalation` (src/core/EscalationGovernor.ts) — **add** — admission control for COST, not for messages/sessions; refusal = stay on default.
- `POST /sessions/:name/model-swap` (src/server/routes.ts + src/core/ModelSwapService.ts) — **add** — mutating session route; refusals (protected/non-idle/disabled) are safety guards on a session-mutating action (exempt class), all retryable.
- `UltraSessionCapMonitor` (src/monitoring/) — **add** — SIGNAL-ONLY: raises a HIGH Attention item; never blocks or down-swaps (§8 visibility-not-bounded-spend).
- Hooks `model-tier-skill-entry.sh` / `model-tier-reconciler.js` — **add** — signal writers; the reconciler only *requests* a swap from the server authority; it never blocks a turn.
- `/sessions/spawn` model allowlist (routes.ts) — **modify** — widened (claude model ids incl. claude-fable-5); a pure allowlist extension, no new block path.

## Files touched (running inventory)

- src/core/ModelTierEscalation.ts (new) + tests/unit/modelTierEscalation-resolver.test.ts (new)
- (updated as the build progresses)

---

## 1. Over-block

Sections 1–7 are completed at Phase 4 close-out (see final version of this file).

## 2. Under-block

(pending Phase 4)

## 3. Level-of-abstraction fit

(pending Phase 4)

## 4. Signal vs authority compliance

(pending Phase 4 — preliminary: routing-only + hard-invariant validators; no brittle blocking authority on judgment decisions)

## 5. Interactions

(pending Phase 4)

## 6. External surfaces

(pending Phase 4)

## 7. Rollback cost

(pending Phase 4 — preliminary: additive code, enabled:false default, revert = instant back-out)

## Conclusion

(pending Phase 4)
