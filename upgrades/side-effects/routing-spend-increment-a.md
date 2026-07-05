# Side-Effects Review — Routing Control Room spend/caps VIEW (Increment A)

**Version / slug:** `routing-spend-increment-a`
**Date:** `2026-07-05`
**Author:** `echo`
**Second-pass reviewer:** `not required` (read-only observability — no block/allow, session-lifecycle, coherence-gate, or sentinel/guard/gate/watchdog surface)

## Summary of the change

Ships **Increment A** of the routing-control-room-spend spec: a READ-ONLY spend/caps view. It turns the immutable per-call token record (`feature_metrics`) into dollars by joining a reviewed price manifest ON READ, and lists every metered paid-door key with its published caps and honest not-live/$0 state. It **gates nothing and books nothing** — the authoritative money ledger, the O(1) fail-closed gate, and the PIN cap controls are Increment B (deliberately NOT built here); alerts are Increment C; multi-machine slicing is Increment D. Files: new `src/core/routingPriceAuthority.ts` (Layer 1/1b price + subsidy/credit read composition), `src/core/routingSpendView.ts` (Surface 1 composer), `scripts/routing-prices.manifest.json` (canonical reviewed price manifest), `scripts/routing-price-refresh.mjs` + `src/scaffold/templates/jobs/instar/routing-price-refresh.md` (the OFF-by-default observed-cache refresh job); extended `src/monitoring/FeatureMetricsLedger.ts` (Layer 0 `door` column, Layer 2 `spend_token_rollup` upsert-on-insert + boot reconcile + batched prune); new Bearer-auth dev-gated read routes `GET /routing-spend/summary` + `/routing-spend/caps` in `src/server/routes.ts`; wired in `src/server/AgentServer.ts`; config type + `migrateConfigRoutingSpendDark` + `ROUTING_SPEND_CLAUDEMD_SECTION` (Agent Awareness); a read-only dashboard **Spend** tab; `CapabilityIndex` describe entry. Also brings the converged spec docs (spec + `.eli16` + convergence report) to main status-as-is.

## Decision-point inventory

- `GET /routing-spend/summary` / `GET /routing-spend/caps` dev-gate — **add** — `resolveDevAgentGate(routingSpend.enabled, config)` → 503 when dark (fleet), live on a dev agent. A read gate only; it decides visibility, never blocks any behavior.
- Money gate / cap enforcement — **NOT touched** — the O(1) fail-closed money gate is Increment B and is absent here. No `costBasis`, `provider_cost_report`, subsidy, or credit ever feeds a gate (there is no gate to feed).
- Rollup maintenance flag (`maintainSpendRollup`) — **add** — a construction-time boolean gating whether the daily aggregate is written; not a runtime decision point, bounds fleet blast radius.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The only gate is the read-route dev-gate (503 when dark), which is the intended maturation behavior, not an over-block of any input.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

Correct layer. This is a **reporting/observability composition** layered strictly above the immutable token ledger — the deliberate twin of the existing `natureRoutingMap.ts` (Surface 3) and `/metrics/features` read surfaces. It reuses `FeatureMetricsLedger` (Layer 0/2 token truth), `NATURE_ROUTING_DEFAULT_CHAINS` (which doors are metered), and the `resolveDevAgentGate` funnel — it re-implements none of them. The one deliberate deviation from the spec's letter: the "machine-local read index" for the price manifest is an **in-memory Map rebuilt on manifest mtime change** rather than a SQLite materialized view. For a manifest of a handful of points this is the faithful, non-authoritative, reload-on-change realisation of the spec's intent ("regenerable materialized view, rebuilt on boot AND when the manifest mtime/hash changes"); a separate SQLite substrate at this scale would add ABI/complexity risk for no benefit. The load-bearing invariants (canonical manifest is the reporting authority; the observed cache is kept in a SEPARATE index and is never the canonical source; validation fails closed; day-alignment) are all preserved, and the price-authority API separates the canonical from the observed basis so Increment B's gate can bind to canonical-only.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] **No — this change has no block/allow surface.** It is a pure signal/reporting surface. Every dollar figure is a display value derived on read; nothing it computes gates, blocks, delays, or rewrites any flow. The money authority (the thing with blocking power) is Increment B and is not built here. `FeatureMetricsLedger.record()`'s existing never-throw guarantee is preserved: the new rollup upsert is isolated in its own try/catch after the primary insert and can never affect it.

## 5. Interactions

- **Shadowing:** none. The new routes are a new prefix (`/routing-spend`), no existing route matches it. The `door` column and `spend_token_rollup` table are additive; `feature_metrics` reads (`/metrics/features`) are untouched.
- **Double-fire:** none. The rollup upsert runs once per `feature_metrics` insert (llm-kind only), fire-and-forget. The retention prune tick now also prunes the rollup table — a distinct table, no overlap with the raw prune.
- **Races:** the rollup upsert shares the `feature_metrics` DB with the primary insert but is a separate statement wrapped in its own try/catch; a boot reconcile recomputes the last 30 days from raw truth so a crash-dropped upsert self-heals. The `pruneOlderThan` change from an unbounded `DELETE` to a batched one is a strict improvement (shorter locks), same net effect.
- **Feedback loops:** none. Reporting reads never write back into token truth.

## 6. External surfaces

- **Other agents / users:** the read routes are dev-gated (503 on the fleet), so no fleet agent exposes them until flipped. New agents get the `routingSpend` config block + CLAUDE.md awareness section via init; existing agents via `migrateConfigRoutingSpendDark` + `migrateClaudeMd` (Migration Parity honored).
- **External systems:** none at runtime. The OFF-by-default `routing-price-refresh` job, IF an operator enables it, makes a bounded public HTTP GET to OpenRouter's no-auth `/models` endpoint and writes only the machine-local observed cache — it structurally never touches the canonical manifest (asserted by a unit test) and metered/web-verify probes refuse without a positive budget.
- **Persistent state:** additive + regenerable — a nullable `door` column and a `spend_token_rollup` table on the existing feature-metrics SQLite DB (rollup maintained only when the dev-gate is live), plus optional machine-local `.instar/routing-prices.{observed,overlay}.json` / `routing-credits.json` (read-only in A, absent by default). No money state, no PIN store (that is Increment B).
- **Operator surface:** the only operator-facing surface is the **read-only Spend dashboard tab** (see 6b). No PIN/approval/grant/secret action is added — the money controls that would need a phone-completable form are Increment B, out of scope.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The change adds a read-only dashboard **Spend** tab (`dashboard/index.html`). It has no operator actions (no grant/revoke/adjust/go-live — those are Increment B).

1. **Leads with the primary action?** Yes — the tab opens directly onto the headline spend totals + the by-door/model and caps tables; the only control is a grain selector + Refresh. There is no action to lead with (read-only), and the answer the operator came for (what am I spending / where do the caps sit) is the first content.
2. **Zero raw internals as primary content?** Yes — headline is plain-language stat tiles (Gross / Net / Committed / Tokens); dollar figures and human labels are primary; `keyRef`/`door`/`priceBasis` appear only as de-emphasized support columns, not headline content.
3. **Destructive actions de-emphasized?** N/A — there are no destructive (or any) actions on this read-only tab.
4. **Plain language + phone width?** Labels read plainly ("Paid-door caps", "not live", "$0 (subscription — not per-token billed)"); tables live inside `overflow-x:auto` containers so wide content scrolls within its own box rather than breaking the page; the 503/dark state renders a friendly "not enabled on this agent" message, not an error.

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read.** Token ground truth (`feature_metrics` + `spend_token_rollup`) is recorded per-machine (each machine records its own internal LLM calls), exactly like the existing `FeatureMetricsLedger`/`TokenLedger` posture. The operator-facing spend NUMBER is unified by a future `?scope=pool` fan-out (the `GET /guards?scope=pool` / `GET /subscription-pool?scope=pool` model), which Increment A does not yet implement — the routes serve the local machine's rollup honestly (the `adjustmentsSource`/`reportingBasis` labels make the source explicit). The canonical price manifest is `unified` (git-tracked, identical everywhere); the observed cache / overlay / credits are machine-local BY DESIGN (they are reporting-only operator observations that never reach a gate, so replicating them would put deal terms on every disk for zero enforcement benefit — declared in the spec's Multi-machine posture). No user-facing notices are emitted (no one-voice concern). No durable state strands on topic transfer (the rollup is per-machine spend history, not topic-scoped). No URLs are generated. A single-machine agent is a clean no-op; a fresh agent with no manifest degrades to honest `$0`/no-provider-data.

## 8. Rollback cost

Pure, reversible: revert the code change and ship a patch. Persistent state is additive/regenerable — the `door` column and `spend_token_rollup` table can be left in place harmlessly (nothing else reads them), or dropped with no data loss (the rollup is a regenerable fold of `feature_metrics`). No money state, no PIN store, no user-visible regression during the rollback window (the feature is dev-gated dark on the fleet, so fleet users never saw it). The spec docs land as documentation only.

## Conclusion

This review produced no design changes — the change is a read-only reporting surface with no blocking authority, mirroring two existing sibling surfaces. One honest deviation is documented (in-memory price index vs a SQLite materialized view, faithful to the spec's regenerable-read-index intent at this manifest scale). One scope boundary is recorded below. The change is clear to ship as Increment A: dark/reversible, no money controls, no Increment-B reach.

**Scope boundary (Layer 1c / Amendment 1).** After this task's named source SHA (34ee47730, `status: converged`), the spec received Amendment 1 (Layer 1c — a `provider_cost_report` store + capture seam + reconciliation route) and Amendment 2 (alerts to one topic), reverting the spec to `status: revising` (not re-converged). Amendment 2 is Increment C (out of scope). Amendment 1's store/capture-seam/reconciliation-route are entirely **metered-dispatch-dependent and empty in Increment A** (no metered call path exists to capture from). This PR honors Amendment 1's Surface-1 **read contract** additively — the `costBasis` / `providerReportedUsd` / `providerDriftPct` row fields ship with honest Increment-A values (`internal-derived` / `subscription-zero` / `unpriced`; provider fields `null`) plus a `providerGroundingNote` — but does NOT build the empty provider-cost store or `/routing-spend/reconciliation` route, because they are an un-reconverged amendment whose data source (real metered dispatch) is out of scope. That store + route + capture seam land when Amendment 1 re-converges and the metered dispatch seam exists to feed them. <!-- tracked: CMT-1901 routing-control-room spend, spec docs/specs/routing-control-room-spend-alerts.md Layer 1c -->

## Evidence pointers

- Unit: `tests/unit/routing-price-authority.test.ts` (14), `tests/unit/routing-spend-view.test.ts` (6), `tests/unit/feature-metrics-spend-rollup.test.ts` (9), `tests/unit/routing-price-refresh-prober.test.ts` (8), `tests/unit/migrate-routing-spend-dark.test.ts` (4)
- Integration: `tests/integration/routing-spend-routes.test.ts` (4 — 200 alive / 503 dark / caps not-live / missing-deps 503)
- E2E: `tests/e2e/routing-spend-lifecycle.test.ts` (4 — feature-alive 200-not-503 on the production init path, Bearer-gated, read-only POST→404)
- Sibling regression: `/metrics/features` unit+integration+e2e, `nature-routing-map`, `feature-delivery-completeness` (CLAUDE.md parity), `CapabilityIndex`, `no-empty-catch-blocks`, `lint-dev-agent-dark-gate` — all green.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a new read-only feature, not a fix to an LLM prompt/hook/config/skill/standard, and it adds no self-triggered controller (no loop/monitor/sentinel/reaper/scheduler/recovery path — the OFF-by-default refresh job is operator-scheduled, not self-triggered).
