# Side-Effects Review — Burn-detector absolute-share activity gate

**Version / slug:** `burn-detector-activity-gate`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The `BurnDetector` absolute-share trigger fired whenever one attribution key crossed 25% of the
trailing-24h token spend, with no check that the key was still spending. A heavy session that
finished hours ago kept re-tripping the alarm every cooldown for a full 24h with self-contradictory
"consumed 67% of 24h spend … Projected 0 tokens" messages. This change adds an activity gate
(`tokens1h > absoluteShareActivityFloorTokens`, default 0) so the absolute-share trigger only fires
for a key actively spending in the last hour. It also exposes the previously-hardcoded
burn-detection config as `monitoring.burnDetection.*` (master off-switch + tuning knobs), cleans the
alert text, and adds a content-sniffed `PostUpdateMigrator` awareness section. Files touched:
`src/monitoring/BurnDetector.ts`, `src/server/AgentServer.ts`, `src/core/types.ts`,
`src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, plus
`tests/unit/burn-detection-phase-3.test.ts` and `tests/unit/PostUpdateMigrator-tokenBurnAlerts.test.ts`.

## Decision-point inventory

- `BurnDetector.tick` absolute-share trigger — **modify** — adds an AND-condition (`isActivelySpending`)
  before the existing `share > threshold` test. Strictly narrows when the trigger fires; never widens.
- `AgentServer` burn-detection startup — **modify** — reads `monitoring.burnDetection`; `enabled:false`
  skips the whole subsystem; other knobs are passed through to `BurnDetector` / `BurnThrottleRunbook`
  only when explicitly set (partial configs built without `undefined` keys so a default is never clobbered).
- `PostUpdateMigrator.migrateClaudeMd` — **add** — one idempotent, content-sniffed section append.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

A genuine live burn that happens to log zero tokens in the most recent hour would be gated out. In
practice this can't be a sustained burn — `tokens1h` is computed from a real 1h ledger query, so a
key actively spending necessarily has positive last-hour tokens. The only "rejected" case is a key
whose 24h share is high but whose current rate is zero, which is by definition not a live burn. The
default floor of 0 is the most conservative choice: it suppresses only the provably-finished case.

## 2. Under-block

**What failure modes does this still miss?**

It does not improve attribution — spend still labelled `unknown::<sessionId>` (resolver ran, found no
named component) is a coverage gap, not a burn, and is out of scope here. A burst that ends but
leaves a small warm-session cache trickle in the last hour (tokens1h slightly > 0) would still fire
if its 24h share exceeds the threshold; operators who see that can raise
`absoluteShareActivityFloorTokens`. The baseline-divergence trigger is unchanged.

## 3. Level-of-abstraction fit

**Is this at the right layer?** Yes. The gate lives inside `BurnDetector.tick` beside the existing
`rollingBaselineFloor` activity check on the sibling trigger — same layer, same shape. The config
read lives in `AgentServer` where every other monitoring subsystem is wired. The migration lives
beside the other `migrateClaudeMd` sections. No re-implementation of an existing primitive.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

`BurnDetector` is a signal producer: it emits to `DegradationReporter`; the `BurnThrottleRunbook` is
the authority that decides alert-vs-throttle. This change makes the signal *more* conservative (fewer
false positives) — it adds no blocking authority and removes none. The off-switch is operator config,
not runtime decision logic.

## 5. Interactions

- **Shadowing:** The activity gate runs before the baseline-divergence trigger in the same key loop.
  When absolute-share is gated out, baseline-divergence is still evaluated normally (and has its own
  `rollingBaselineFloor` gate), so a finished burst produces zero signals from both — confirmed by the
  new "finished burst" unit test.
- **Double-fire:** None. One signal per key per cooldown, unchanged.
- **Races:** None. `BurnDetector` reads the ledger; it shares no mutable state with concurrent code.
- **Feedback loops:** The runbook self-attribution prefix (`burn-throttle-runbook::`) remains exempt,
  so throttle activity can't feed back into the detector.

## 6. External surfaces

The user-visible Telegram alert text changes (drops the "Phase 3/Phase 4" jargon; "at current rate"
→ "at the current rate"). The `BurnVerifier.extractTokensLast1h` regex that parses the projected
number back out of the alert still matches the new wording (the captured group precedes the changed
suffix) — verified against existing fixtures. Volume of alerts drops sharply (finished bursts no
longer re-alarm). New optional `monitoring.burnDetection` config keys; absence preserves defaults.
Existing agents get the CLAUDE.md awareness section on next update via the idempotent migration. No
database/ledger schema change.

## 7. Rollback cost

Pure code + docs change. Revert and ship as the next patch. No persistent state, no data migration,
no agent-state repair. During the rollback window the only regression is the return of the original
noise — there is no correctness or data risk. An operator who needs immediate relief without a
release can set `monitoring.burnDetection.enabled: false` and restart sessions.

## Conclusion

The review surfaced no blocking concerns. The change narrows an over-firing signal-producer with a
gate that mirrors an existing sibling check, adds an operator off-switch, and is fully reversible by
revert or config. The only residual is the unchanged attribution-coverage gap (`unknown::<id>`),
explicitly out of scope and tracked as a separate, larger effort. Clear to ship.

## Evidence pointers

- `tests/unit/burn-detection-phase-3.test.ts` — 3 new activity-gate tests (both sides of the boundary
  + the configurable-floor path); 65 burn-detection tests green across phases 3–6.
- `tests/unit/PostUpdateMigrator-tokenBurnAlerts.test.ts` — 5 new migration tests (add / idempotent /
  preserve / skip-missing / template-emits).
- `tsc --noEmit` clean.
