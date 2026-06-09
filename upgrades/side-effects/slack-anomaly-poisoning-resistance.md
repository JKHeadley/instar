# Side-Effects Review — Slack relationship-anomaly baseline-poisoning resistance (Phase-3 follow-ups #2/#3)

**Version / slug:** `slack-anomaly-poisoning-resistance`
**Date:** 2026-06-09
**Author:** Instar Agent (echo)
**Second-pass reviewer:** not required (see §5 — detector-only, observe-only/dark; no blocking authority added)

## Summary of the change

Deepens baseline-poisoning resistance for the Slack relationship-aware anomaly detector (Pillar 3, SLACK-ORG-INTEGRATION-SPEC.md §7), the pre-enforce follow-ups #2/#3 flagged by the Phase-3 adversarial review (PR #1022). The threat is a patient attacker / slowly-compromised account that injects many normal-looking observations (and/or a burst) to reshape a principal's behavioral baseline so a later out-of-character request scores low. Three additive, backward-compatible, observe-only hardenings: (#2) recency/decay weighting via optional time-bucketed history + exponential bucket-age decay, scored as the max-anomaly across BOTH the cumulative and the decayed view so the hardening only ever adds resistance; (#3a) a minimum-baseline-AGE requirement (a baseline is "established" only when firstSeen is older than N days AND interactionCount ≥ establishedMin); (#3b) a per-principal observation-rate cap (excess observations in a rolling window are dropped + logged, never recorded). Files: `src/permissions/RelationshipBehaviorStore.ts` (buckets, decay helpers, rate cap), `src/permissions/RelationshipAnomalyScorer.ts` (dual-view max-anomaly scoring + min-age gate), `src/commands/server.ts` (wire `permissionGate.relationshipAnomaly.poisoningResistance` config), `docs/specs/SLACK-ORG-INTEGRATION-SPEC.md` (§7.7), `tests/unit/slack-relationship-anomaly.test.ts` (12 new tests + aged-seed fixtures). The decision point touched is the anomaly SCORER (a detector), not any authority.

## Decision-point inventory

- `RelationshipAnomalyScorer.assess/deterministicScore` — modify — strengthens the anomaly SCORE (a signal); produces no block/allow. The consuming SlackPermissionGate (the authority) is unchanged.
- `RelationshipBehaviorStore.record` — modify — adds a structural write-bound (rate cap) on what SHAPE gets recorded; produces no block/allow on the message path.
- `permissionGate.relationshipAnomaly.poisoningResistance` config (server.ts) — add — optional knobs; absence preserves shipped defaults.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The scorer produces a 0..1 anomaly score + reasons (a signal); the whole Pillar-3 feature ships observe-only/dark (§7.6: would-be step-ups are logged, never live-challenged). The closest analog to "over-fire" is a false-positive anomaly. The min-age gate (#3a) and the never-lower invariant make the hardening *more* conservative about firing on thin/young baselines, not less; the dual-view max-anomaly never invents a step-up on a no/thin baseline (a new principal still scores 0, confidence 'none'). The rate cap drops *recording*, not requests — a dropped observation never affects the message path; at worst the baseline grows slightly slower, which only lowers anomaly confidence (more conservative).

## 2. Under-block

No block/allow surface — under-block not applicable. As a detector, the residual gaps are: (a) a *very* slow attacker who stays under the rate cap for many windows AND sustains a campaign long enough that the action's share rises above the floor in BOTH views can still normalize an action — but this requires a sustained multi-week campaign the cap throttles, far harder than the single-burst / single-seeded-observation attacks #1/#2/#3 close; (b) decay half-life is a tuning choice — too short helps a recent burst, too long lets stale behavior dominate; default 30 windows is conservative and config-overridable. The floor protection (RolePolicy / Layer-0 grants) protects dangerous actions regardless of anomaly, so an under-fire is harmless (nothing is blocked in observe mode, and a floor action still needs a grant when enforcement is on).

## 3. Level-of-abstraction fit

Correct layer. The hardening lives in the same module that owns the baseline (the store) and the same scorer that owns the signal — it does not reach up into the gate/authority or down into transport. The rate cap belongs in `record()` (the single write funnel for the baseline) and the decay/age logic belongs in the scorer's read path (pure, deterministic, testable). No higher layer should own per-principal histogram robustness; no lower layer sees principal identity. The decayed-view computation is a pure read-time function — the store still persists raw counts, so the model can be retuned without a data migration.

## 4. Signal vs authority compliance

Compliant (the load-bearing question). Per `docs/signal-vs-authority.md`: the scorer is a DETECTOR — it surfaces an anomaly score + human-readable reasons and holds zero blocking power. The single authority for the permission decision (SlackPermissionGate) is untouched and still the only thing that can raise a verdict to step-up, and only ever to RAISE a would-be-allowed floor action (§7.4 never-lower). The dual-view max-anomaly design is explicitly an "only add" rule: a hardening must never DISARM a signal the pre-hardening cumulative baseline would have fired (the cumulative view is always evaluated alongside the decayed view and the more-anomalous wins). The rate cap is a structural write-bound (a validator on recorded SHAPE), not a brittle blocker on inputs. No new brittle authority is introduced.

## 5. Interactions

- **With mitigation #1 (share-floor, already merged):** complementary. #1 made out-of-character fire on low SHARE not only never-seen; #3b's rate cap keeps a burst's share *small* so #1's floor keeps biting; #2's decayed view re-arms #1 once a burst ages out. The counter-test (`WITHOUT the rate cap … demonstrating the cap is load-bearing`) proves #1 alone is defeated by an uncapped 100-obs burst and that #3b is what preserves it.
- **With the LLM style check (optional, fail-closed):** unchanged. It still adds-only and fails closed; it reads a coarse cumulative summary (a prose hint), not the scoring path.
- **Buckets-sum invariant:** the cumulative counts remain the exact sum of bucket counts + the legacy (pre-bucketing) base, so an old reader of the persisted profile sees identical numbers. A dropped observation touches NEITHER the cumulative nor the bucket counts, so the cap can't desync them.
- **No double-fire / no race:** `record()` is the existing single write funnel (best-effort, swallows errors, atomic temp+rename write). The rate cap adds one branch inside it; no new writer, no new file, no new timer.

## 6. External surfaces

- **Persisted state:** the `slack-relationship-baselines.json` profile gains an OPTIONAL `buckets` array (additive field under the existing `slack-relationship-baselines` state-registry category — lint-state-registry clean, no new category). A profile written by an older build (no `buckets`) is read and scored identically (degrades to its cumulative form at full weight). A profile written by this build is still readable by an older build (it ignores the unknown field).
- **API:** `GET /permissions/baselines` is unchanged (it serializes the profile as-is, including the new optional field). No new route.
- **Config:** new optional `permissionGate.relationshipAnomaly.poisoningResistance` sub-config; absence preserves shipped behavior. Feature stays dark (Null scorer default).
- **Cross-agent / cross-machine:** none. No Threadline, no messaging, no spawn surface touched.

## 7. Rollback cost

Low. The feature ships dark (observe-only; off unless `relationshipAnomaly.enabled` + a non-Null scorer). Back-out is a code revert of the five files — no release-incident class, no agent-state repair. The persisted `buckets` field is forward/backward-compatible, so a revert leaves existing baseline files readable by the reverted code (the extra field is ignored). The decay model is read-time only (raw counts persist), so a retune or revert needs no data migration. To disable the hardenings without reverting: `minBaselineAgeDays: 0` (legacy count-only established), `maxObservationsPerWindow: 0` (cap off), and a large `decayHalfLifeWindows` (decay ≈ off / cumulative).
