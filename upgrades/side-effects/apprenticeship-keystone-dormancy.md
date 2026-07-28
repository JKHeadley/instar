# Side-effects review — keystoneBalance dormancy dimension

**Change:** add an orthogonal `dormant` flag (+ `lastKeystoneAgeMs`,
`dormancyThresholdMs`) to the observe-only `keystoneBalance` block, plus a
`?keystoneDormancyMs` route knob, template awareness, and a migration.

**Signal vs authority (Phase 1):** This change involves **no decision point**. It
adds read-only computed fields to an existing observe-only signal. It never gates,
blocks, filters, or constrains any agent behavior. It is a pure signal-producer —
the consumer (a human, or a future cadence job) decides what to do with `dormant`.
`docs/signal-vs-authority.md` compliance: trivially satisfied (no authority held).

1. **Over-block:** N/A — nothing is blocked. The only "false positive" risk is
   reporting `dormant: true` for a layer that is intentionally idle. That is the
   correct report (the layer IS dormant); acting on it remains a human/cadence
   judgment. A future-dated keystone clamps age to 0, so clock skew cannot
   manufacture false dormancy.

2. **Under-block:** N/A — nothing is blocked. The signal still cannot see a layer
   that was *never* registered as an instance (the separate fragmentation finding,
   filed to the framework ledger as `apprenticeship-cycle-instance-no-referential-integrity`,
   tracked for a follow-up decision). Dormancy is scoped to a single instance's
   keystone axis by design.

3. **Level-of-abstraction fit:** Correct layer. Dormancy is computed inside
   `ApprenticeshipCycleStore.computeKeystoneBalance` alongside `starved`, from the
   same already-tallied timestamps + the store's injectable `now()`. No new store,
   no cross-store wiring, no new dependency. It belongs exactly where `starved`
   already lives.

4. **Signal vs authority compliance:** Compliant. Pure signal; zero blocking
   authority. Both knobs (`?oversightStarvationThreshold`, `?keystoneDormancyMs`)
   are observe-only tuning, not gates.

5. **Interactions:** `dormant` is orthogonal to `starved` (both can be true; unit
   test pins this). It does not shadow or get shadowed by `starved`, `driftWarning`,
   or the §4a direct-shortcut exclusion. The migration interacts with the prior
   layer-balance migration: the full-line insert fires only when `keystoneBalance`
   is absent (now appends the dormant-aware shape); the new in-place upgrade fires
   only when the pre-dormancy shape is present. The two are mutually exclusive and
   each idempotent (tested).

6. **External surfaces:** The `role-coverage` JSON response gains three fields and
   the route accepts one new query param — purely additive, no removed/renamed
   fields. The CLAUDE.md template + migration change what installed agents read
   (one awareness line). No timing/runtime dependence beyond the store's `now()`,
   which is injectable and tested with a fixed clock.

7. **Rollback cost:** Trivial. Observe-only and additive — reverting the commit
   removes the fields with no data migration, no agent-state repair, no hot-fix
   urgency (nothing depends on `dormant` to function). The CLAUDE.md awareness line
   is cosmetic and harmless if left.

**Tier:** 1 (observe-only computed fields on an existing endpoint; all three test
tiers green plus migration-parity tests). Below the risk-floor signal (2, raised
by the PostUpdateMigrator touch) — acknowledged: the migrator change is the
established idempotent doc-awareness pattern from #893, not a data migration.

**No deferrals:** the feature ships complete — code, three test tiers, template
awareness, and migration parity (new + already-migrated agents) all in this commit.
The separate cycle-instance fragmentation finding is a distinct issue (filed to the
ledger), not a deferred part of this change.
