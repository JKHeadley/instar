# Routing Control Room — Layer 1c: provider-reported cost + reconciliation

**Spec:** `docs/specs/routing-control-room-spend-alerts.md` (converged r7 + approved, parent-principle: Token-Audit Completeness) — §Layer 1c / FD-21
**Side-effects:** `upgrades/side-effects/routing-spend-increment-1c.md`
**Maturity:** ⚗️ Experimental — rides the dev-gated `routingSpend` view flag (dark on the fleet); honestly EMPTY until the out-of-scope metered dispatch seam produces provider reports.

## What Changed

- **`ProviderCostReportStore`** (`src/monitoring/ProviderCostReportStore.ts`): the immutable
  append-only provider-report record set + reconciliation records — `meteredCallId` join key,
  supersession by greatest `capturedAt` (a late OpenRouter `/generation` cost never double-counts),
  receive clamps (invalid rows audit-preserved + aggregate-excluded), declared 400d retention with
  the batched prune, registered in `state-coherence-registry.json` WITH retention at birth.
- **`extractProviderReport`**: the per-door capture parser — OpenRouter `usage.cost` +
  cached-token detail + generation id; Groq token counts; Gemini native (`candidatesTokenCount` +
  `thoughtsTokenCount`, erring HIGH) and OpenAI-compat shapes. Absent/reshaped fields degrade to
  token-only or nothing — a first-class NORMAL state.
- **`ProviderReconciliationSweep`** (`src/monitoring/ProviderReconciliationSweep.ts`): the
  cadenced (default 6h) REPORTING-side cross-check — signed `driftPct` per (keyRef, door) window,
  committed-figure enrichment on the metered-lease holder (via the READ surface, never the money
  lock), drift ≥ `reconciliation.driftAlertPct` (default 10%) feeding the already-live
  `SpendAlertEmitters.onReconciliationDrift` (Increment-C informational lane, dispatcher-latched).
- **`feature_metrics.callId`** — the per-call join column, full I-4 discipline (column + type +
  writer + INSERT), stamped only by the future metered dispatch.
- **`GET /routing-spend/reconciliation`** — the drift-record read route (same dev gate as the
  view); the spend summary now PREFERS provider-reported cost per row where reports exist
  (`costBasis: "provider-reported"`, `providerReportedUsd`, `providerDriftPct`).
- **FD-21 structural exclusion as a TEST:** the money gate/ledger modules reference nothing from
  the provider store — pinned by `tests/unit/provider-cost-report-store.test.ts`.
- Self-action convergence model `spend-recon-sweep` (24h-latch eternal sentinel).

## Evidence

- `tests/unit/provider-cost-report-store.test.ts` — 18 cases: clamps, supersession/no-double-count,
  per-door extraction (incl. the Gemini thinking-token trap), signed drift + threshold + Near-Silent
  below it + zero-internal guard + never-throws, the FD-21 structural exclusion, and the callId
  end-to-end column discipline.
- `tests/integration/routing-spend-routes.test.ts` — the reconciliation route (dark-503/live-200)
  and the provider-preferred summary basis over real stores.
- `tests/e2e/routing-spend-lifecycle.test.ts` — the reconciliation surface constructs on the REAL
  AgentServer boot path (200 + the DB file on disk, honest empty records).
- `tests/unit/self-action-convergence.test.ts` — 50/50 with the new model.

## What to Tell Your User

Nothing yet — this layer is bookkeeping that stays empty until paid routing actually dispatches
calls (a separate, still-unbuilt piece). Once real paid calls flow, your Spend tab's dollar figures
will prefer what the PROVIDER says it charged (where the provider reports it), and a scheduled
cross-check will quietly flag any drift between the provider's numbers and ours — so a stale price
gets noticed and fixed instead of silently mispricing your books.

## Summary of New Capabilities

- (⚗️ Experimental, dark, honestly-empty) Provider-grounded cost reporting: the immutable
  provider-report store, the per-door capture parser, the reconciliation sweep + drift alerts, and
  the provider-preferred spend basis. Remaining in this train (tracked: CMT-1929): PR 4 — the
  amortized subscription display with visible derivation math + scheduled web-research price checks.
