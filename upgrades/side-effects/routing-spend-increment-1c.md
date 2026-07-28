# Side-Effects Review — Routing Control Room Layer 1c (provider-reported cost + reconciliation)

**Spec:** `docs/specs/routing-control-room-spend-alerts.md` (review-convergence r7, approved, parent-principle: Token-Audit Completeness) — §Layer 1c + FD-21.
**Worktree:** `echo/money-increment-1c` off `JKHeadley/main` @ `7c2064163` (contains merged Increments B + C).
**Scope of this PR (PR 3 of the train, tracked CMT-1929):** the provider-grounded REPORTING anchor — `ProviderCostReportStore` (immutable append-only provider reports + reconciliation records, receive-clamped, 400d declared retention, `meteredCallId` join key with capturedAt supersession), the `callId` column on `feature_metrics` (full I-4 discipline: column + type + writer + INSERT), the per-door provider-report field extraction (`extractProviderReport` — OpenRouter usage.cost mandatory-include posture; Groq/Gemini token counts incl. the thinking/cached details), the capture SEAM the future metered dispatch calls strictly post-settle, the cadenced `ProviderReconciliationSweep` (reporting-side, NEVER the money lock; signed driftPct feeding the ALREADY-LIVE `SpendAlertEmitters.onReconciliationDrift`), the `GET /routing-spend/reconciliation` read route, and the summary composer's provider-preferred `costBasis` enrichment. The operator additions (amortized subscription display + web-research price checks) are PR 4.

## Phase 1 — Principle check (signal-vs-authority)

**Does this change involve a decision point?** No blocking decision anywhere: everything here is REPORTING truth. The load-bearing invariant is the opposite direction — the spec's structural exclusion (FD-21, the FD-9/FD-12 twin): NO provider report, reconciliation record, or drift figure is ever read by the money gate or the reserve/settle path. This PR ships that as a STRUCTURAL TEST (the gate/ledger modules import nothing from the provider store) plus the one-way drift rule: provider-LOWER only changes the report; provider-HIGHER raises a drift signal feeding the human-reviewed PIN price-promotion path — the committed counter is never rewritten in either direction. Compliant: signals only.

## Phase 2 — Plan

- **Decision points touched:** none with authority. The sweep DECIDES only whether a drift figure crosses the alert threshold — feeding the Increment-C dispatcher (itself notification-only, dryRun-soaked).
- **Existing detectors/authorities interacted with:** `FeatureMetricsLedger` (additive `callId` column, same ensureAddedColumns discipline as `door`); `RoutingPriceAuthority` (read-only as-of pricing for the internal-derived side of the comparison); `SpendAlertEmitters.onReconciliationDrift` (already live, already convergence-modeled); the caps read surface (committed totals for booked-vs-reported — read-only, never the per-key money mutex); `state-coherence-registry.json` (the new store registered WITH declared retention — the Bounded Accumulation ratchet is satisfied at birth, never grandfathered).
- **Store shape decision (documented deviation):** the spec says "a small SQLite table beside the rollup"; this ships as a small SQLite DB FILE beside the rollup's DB (`server-data/provider-cost-reports.db`) rather than a table inside `feature-metrics.db` — one owner per file, no cross-class schema coupling, identical query surface. Volume is bounded by metered calls only.
- **Rollout:** rides the EXISTING dev-gated `routingSpend` view flag (FD-21: "capture + display in Increment A" posture — the store/route are read-only observability like the summary); the sweep additionally requires the reconciliation config (defaults on where the view is on; inert until provider reports exist, which requires the out-of-scope metered dispatch). No paid door can route regardless (FD-11 unchanged).
- **Rollback path:** additive; disabling `routingSpend.enabled` reverts byte-for-byte (store not constructed, route 503, sweep never ticks). The DB file is inert data at rest.

## Phase 4 — Side-effects review

1. **Over-block:** N/A — nothing blocks. Over-REPORTING risk: a malformed provider body could pollute the reports; closed by receive-clamps (finite ≥0 numerics or the row is stored as `invalid: 1` with nulls — preserved for audit, excluded from every aggregate), length/charset clamps on strings, and HTML-escape at any render.
2. **Under-block / missed data:** capture is best-effort BY SPEC (a swallowed append never blocks the call and never shares a failure domain with the fail-closed settle — the seam contract); a lost report degrades that row to `internal-derived`, a first-class labeled basis, and the reconciliation surface is what makes systematic loss visible.
3. **Level-of-abstraction fit:** store + sweep live in `src/monitoring/` beside FeatureMetricsLedger (reporting side); the gate/ledger in `src/core/` remain import-free of them (structural test). The route rides the existing `/routing-spend/*` dev-gated family.
4. **Signal vs authority:** compliant (Phase 1) — with the exclusion invariant unit-pinned.
5. **Interactions:** the reserve-expiry sweep (money-side, takes the per-key mutex) and this provider-reconciliation sweep (reporting-side, never the lock) are named distinctly everywhere per the spec's vocabulary; the recon-drift alert rides the Increment-C informational lane and its already-registered convergence model. Supersession by `(meteredCallId, greatest capturedAt)` means a late `/generation` cost can never double-count.
6. **External surfaces:** one new Bearer read route (503 when dark). No egress — the sweep reads local stores only; the drift ALERT egresses through the C dispatcher (dryRun-soaked).
7. **Multi-machine posture:** `proxied-on-read` like `feature_metrics` (each machine records its own calls' reports; pool merge is a tracked follow-up with the pool summary <!-- tracked: CMT-1929 -->); the booked-vs-reported comparison that involves the money ledger runs on the metered-lease holder by construction (it reads the local caps/ledger read surface, which only the holder has live values for — a non-holder's sweep sees $0 committed and records the comparison as provider-vs-internal only).
8. **Rollback cost:** config revert; no migration; the DB file and its records are inert audit history.

## Phase 5 — Second-pass review

Not-required by the Phase-5 trigger list (no block/allow messaging decisions, no session lifecycle, no gate/sentinel authority — this is read-side reporting; the one gate-adjacent surface is the STRUCTURAL EXCLUSION test, which reduces gate blast radius). Tier-2 chain otherwise complete; the FD-21 invariant is enforced by test rather than reviewer eyes.

## Self-action convergence (unbounded-self-action — closure: guard)

One new self-triggered behavior: the reconciliation sweep's drift ALERT — already covered by the registered `spend-recon-drift` emit surface riding the Increment-C dispatcher latch (24h re-arm per (keyRef, door, driftBucket)) and the existing dispatcher convergence posture; the sweep itself is a fixed-cadence read-only pass (no feedback loop: its output never changes its input — prices and reports are external facts). Registered model: `spend-recon-sweep` pins the once-per-bucket emission under permanently-drifting pressure.

## No-deferrals accounting

PR 4 (amortized subscription display with visible derivation math + scheduled web-research price checks) and the pool-scope merge of the reconciliation view are the remaining tracked items of this train, tracked under CMT-1929 <!-- tracked: CMT-1929 --> and enumerated in `.instar/plans/money-increment-b-brief.md`; nothing in THIS PR's claimed scope is partial.

## Build outcome (staged with the change)

Delivered exactly as reviewed: 18 unit + 2 integration + 1 e2e new tests green; FD-21 exclusion pinned; retention lint green with the store registered (never grandfathered); self-action ratchet 50/50 with `spend-recon-sweep`; docs-coverage floors held (class 55 / route 55).
