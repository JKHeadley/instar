## What Changed

feat(permissions): deeper **baseline-poisoning resistance** for the Slack relationship anomaly detector — the pre-enforce follow-ups (#2/#3) from the Phase-3 adversarial review. **Observe-only / dark, additive, backward-compatible.**

- **Recency/decay (dual-view max):** the behavior store keeps optional day-bucketed counts; the scorer computes a decay-weighted view AND keeps the cumulative view, and scores each signal as the **more-suspicious of the two** (max anomaly / lower normal-ceiling / lower normal-rate). Decay can only ADD suspicion, never disarm a cumulative signal — so the never-lower invariant holds; its real job is durability (a one-time burst fades once genuine traffic resumes). Default half-life 30 day-windows.
- **Minimum-baseline-age (#3a):** "established" now requires `firstSeen` older than `minBaselineAgeDays` (default 7) AND `interactionCount >= establishedMin` — a high-count-but-young burst stays low-confidence (action/tier/style signals suppressed). `0` restores legacy count-only behavior.
- **Per-principal rate cap (#3b):** `maxObservationsPerWindow` (default 50/day-window); excess observations are dropped + logged (`onCapDrop`), never recorded — cumulative + bucket counts stay in lock-step. `0` disables.
- All under `permissionGate.relationshipAnomaly.poisoningResistance`; absence preserves shipped behavior. Decay is read-time only (raw counts persist) → retune/revert needs no migration. Legacy profiles (no `buckets` field) score identically (decayed view degrades to cumulative).

## What to Tell Your User

Nothing changes by default. This hardens the (still-dark) relationship anomaly detector against a patient attacker who tries to "train" the baseline — by slowly feeding normal-looking activity, or a burst of it — so a later out-of-character request looks normal. Three additive defenses: recent activity can't durably overwrite long-standing behavior, a freshly-created baseline isn't trusted until it's both old enough and large enough, and no single account can flood the baseline faster than a capped rate. It can still only ever ask for *more* verification, never less. Needed before the anomaly layer is ever switched from observe-only to enforcing.

## Summary of New Capabilities

- **`permissionGate.relationshipAnomaly.poisoningResistance: { decayHalfLifeWindows, minBaselineAgeDays, maxObservationsPerWindow, bucketMs }`** (opt-in; the whole anomaly feature stays dark by default) — recency-decay + minimum-baseline-age + per-principal observation-rate-cap, so a poisoned baseline can't disarm the detector.

## Evidence

- 32 anomaly tests (12 new): rate-cap burst / per-window / opt-out; min-age young-vs-aged / opt-out; decay durability + a "without the rate cap" counter-test proving the cap is load-bearing; backward-compat (legacy-profile decay/scoring/backfill). Counterfactuals confirm each hardening is load-bearing (with it off, the poisoning attack succeeds; on, it's caught). 61/61 with the permission-gate + routes integration. `tsc --noEmit` clean; full lint chain clean (state-registry, silent-fallback ratchet, topic-creation). (Full unit suite runs in CI, sharded — local run blocked by host CPU starvation.)
- Side-effects review (`upgrades/side-effects/slack-anomaly-poisoning-resistance.md`); deterministic (no LLM-in-gate-path) so reviewed by me + the counterfactual tests, never-lower preserved by the dual-view-max design.
