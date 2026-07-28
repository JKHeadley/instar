# Side-Effects Review — Slack Permission System Phase 3: relationship-aware anomaly + step-up ladder

**Version / slug:** `slack-relationship-stepup`
**Date:** 2026-06-09
**Author:** Echo
**Second-pass reviewer:** Echo (self, dedicated reviewer pass — this touches a "gate" decision surface)

## Summary of the change

Phase 3 (Pillar 3) of the Slack org permission system: a relationship-aware behavioral second factor. It adds two new modules in `src/permissions/`: `RelationshipBehaviorStore.ts` (a durable, deterministic, privacy-respecting per-principal behavioral baseline — it records the SHAPE of each interaction: action label, sensitivity tier, hour-of-day, message length, urgency flag — NEVER message content) and `RelationshipAnomalyScorer.ts` (a real implementation of the existing `AnomalyScorer` interface that scores how out-of-character a request is across five deterministic signals plus an OPTIONAL fail-closed LLM style check). `SlackPermissionObserver.ts` is extended to FEED the baseline (observe-only, directed requests only) from real traffic. `index.ts` exports the new modules. `server.ts` wires them DARK/opt-in behind `slack.permissionGate.relationshipAnomaly.enabled` (default: the existing urgency-only `HeuristicAnomalyScorer` — nothing changes). `routes.ts` adds a read-only `GET /permissions/baselines` inspection route. `state-coherence-registry.json` registers the new `slack-relationship-baselines` state category. Decision points it interacts with: the existing `SlackPermissionGate.evaluate` step-up path (§7.4 composition — anomaly can only RAISE a would-be-allowed FLOOR action to step-up, never lower any bar). Everything is OBSERVE-ONLY: the step-up verdict is computed and logged to the decision ledger; nothing is live-challenged or blocked (the observer ships enforce=false).

## Decision-point inventory

- `SlackPermissionGate.evaluate` step-up path (`src/permissions/SlackPermissionGate.ts:167-179`) — pass-through (UNCHANGED) — the gate already consumes an `AnomalyScorer.assess()` score against `stepUpThreshold` and escalates a would-be-allowed floor action to `step-up`. This change supplies a richer scorer into the SAME slot; the gate logic is untouched.
- `RelationshipAnomalyScorer.assess` (new) — add — produces a 0..1 anomaly SIGNAL (no blocking authority of its own). It is consumed by the gate; it never blocks/allows directly.
- `RelationshipBehaviorStore.record` (new) — add — append/aggregate per-principal baseline; pure data, no decision.
- `SlackPermissionObserver.recordBehavior` (new) — add — feeds the baseline observe-only; no decision, no block.
- `GET /permissions/baselines` (new route) — add — read-only inspection; no decision surface.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

In OBSERVE-ONLY mode (the only mode this ships in): NONE. No message is ever blocked or challenged — the step-up verdict is logged, never acted on (the observer's `enforce` flag stays false; this PR does not enable enforce).

For the FUTURE enforce path (data-gated, not enabled here), the relevant over-fire is a spurious step-up: e.g. a legitimate owner who genuinely changes their behavior (new role, travels to a new timezone shifting their hour-of-day, suddenly writes longer messages). The scorer mitigates this conservatively: a thin baseline (< establishedMin=5 interactions) suppresses the action/tier/style signals entirely (no "out of character" without an established "character"); a no-baseline principal scores 0 (no fabricated step-up); and anomaly can ONLY raise the bar on a request that was ALREADY going to be allowed — it never invents a new gate. The composition (§7.4) means an over-fire's worst case is "I'd like to confirm it's really you via your known channel," not a hard deny.

---

## 2. Under-block

**What failure modes does this still miss?**

- A compromised account that mimics the principal's exact style/cadence/action repertoire and avoids urgency language scores low — the behavioral factor is a probabilistic signal, not a guarantee (by design; §7 frames it as "feeling something off," not proof).
- The deterministic style signal is coarse (message LENGTH z-score only). A content-level voice mismatch is only caught when the optional LLM style check is enabled (and even then only on a clear MISMATCH).
- A NEW principal (no baseline) has no "character," so a first-ever out-of-character request from a brand-new compromised account scores 0. This is the documented conservative choice: the FLOOR (RolePolicy) still protects the dangerous action regardless — a new owner still needs owner-role authority for a floor action; anomaly is an ADD-ON tightener, not the floor.
- Off-cadence detection uses local server hour vs the principal's recorded hour histogram; a principal who legitimately works irregular hours has a flat histogram and rarely trips off-cadence (acceptable — fewer false positives).

These are acceptable for an observe-only second factor whose entire purpose is to be MEASURED (FP/FN rate) before it ever enforces.

---

## 3. Level-of-abstraction fit

This is correctly a DETECTOR (a signal producer), not an authority. `RelationshipAnomalyScorer` returns a score + reasons; it holds no block/allow authority. The AUTHORITY remains `SlackPermissionGate`, which already owns the deterministic Layer-0 floor and the role ceilings — the dangerous decisions stay in code, not in the brittle scorer. The scorer FEEDS the gate's existing step-up slot rather than running parallel to it. The durable baseline is a dedicated store rather than a retrofit onto the generic `RelationshipManager`: the generic manager has no structured per-request SHAPE history (action-tier/hour histograms, length stats) and adding privacy-sensitive structured tracking to it would over-couple a cross-platform memory system to a Slack-permission concern. The new store is small, Slack-scoped, and content-free — the right layer. This mirrors how the rest of the permissions module is decoupled (it imports nothing from core; deps are injected).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a SIGNAL consumed by an existing smart gate.

`RelationshipAnomalyScorer` is a pure signal producer: it returns `{ score, reasons }` and never blocks. The `SlackPermissionGate` (the authority) consumes that signal and is the only thing that produces a verdict — and even then, anomaly can ONLY raise a would-be-allowed floor action to step-up; it can never turn a refuse into an allow (verified by the "anomaly can only RAISE the bar" test). The OPTIONAL LLM style check is `gating: true` (provider-swaps at the IntelligenceRouter) and fails CLOSED (any failure omits its contribution; it never widens) — compliant with the No-Silent-Degradation standard. The deterministic signals stand alone with no LLM dependency, so the dangerous path never depends on an LLM.

---

## 5. Interactions

- **Shadowing:** The scorer runs INSIDE `SlackPermissionGate.evaluate`, only on the would-allow-a-floor-action branch (after the deterministic floor + grant check). It cannot shadow the floor check — the floor runs first and a refuse is returned before the scorer is ever consulted. Verified by the member-floor-request test (stays a refuse).
- **Double-fire:** The observer records the baseline AND the existing decision ledger records the verdict on the same `observe()` call — two distinct append-only writes to two distinct files, no contention. Baseline recording is gated to directed requests only (overheard chatter is excluded), so channel noise doesn't pollute the baseline.
- **Races:** `RelationshipBehaviorStore` writes via temp-file + rename (atomic-ish) so a crash mid-write can't truncate the baseline. It is per-principal-keyed within a single JSON file; the single-writer model matches the registry `conflictShape: single-writer`. The observer is the only writer in production.
- **Feedback loops:** The baseline is fed by observed traffic and read by the scorer — but recording is post-verdict and never influences the SAME message's verdict (the verdict is computed from the baseline AS-OF-BEFORE this message). No self-reinforcing loop within a turn.

---

## 6. External surfaces

- **Other agents / install base:** None. The feature ships DARK behind `slack.permissionGate.relationshipAnomaly.enabled` (default off). With the flag off, `server.ts` keeps the existing `HeuristicAnomalyScorer` (urgency-only) exactly as before — byte-for-byte unchanged behavior for every existing agent. No CLAUDE.md template or PostUpdateMigrator change (consistent with Slices 0/1/2, which also added nothing there — this is internal server-wired config, not an agent-installed file or a conversational capability).
- **External systems (Slack):** No change to Slack message handling. Observe-only: nothing is sent, blocked, or reacted-to differently.
- **Persistent state:** Adds ONE new state file `slack-relationship-baselines.json` (registered in the coherence registry, machine-local, content-free SHAPE aggregates). It is only written when the feature is enabled AND a behaviorStore is wired; otherwise the file never exists.
- **New read route:** `GET /permissions/baselines` returns SHAPE aggregates only (verified by a test asserting no message content appears in the payload).
- **Timing/runtime:** Off-cadence uses server-local hour; documented limitation, no correctness dependency.

---

## 7. Rollback cost

Pure additive code change, ships dark. Rollback = revert the commit and ship a patch; no migration, no agent-state repair, no user-visible regression (the feature was never on by default). The new state file, if any agent had enabled the feature, is a self-contained machine-local JSON that can be deleted with no downstream effect (the scorer treats a missing baseline as "no baseline" → score 0). The new coherence-registry category is descriptive metadata; removing it has no runtime effect. Estimated rollback: one revert commit, zero downtime.

## Conclusion

The review produced no design changes — the change was built as a signal producer feeding the existing authority from the start, and ships observe-only/dark, matching the spec's §7.6 ("the anomaly detector ships dark/observe-only; logs would-be step-ups; nothing gates until the FP rate is known-good"). The conservative no-baseline / thin-baseline behavior is the documented, deliberate choice (don't fabricate a step-up you can't justify from history; the floor protects the dangerous action regardless). The optional LLM style check is fail-closed and add-only. The deterministic core has no LLM dependency. Clear to ship as a dark/observe-only Phase 3 increment pending the spec's convergence gate (the spec is operator-approved but `review-convergence: pending`, so this lands as a Tier-2 increment behind that gate).

---

## Second-pass review (independent adversarial — "gate"-class change)

**Verdict: CONCUR on all five invariants, with one substantive CONCERN (baseline-poisoning) — mitigation #1 applied + regression-tested in this PR; deeper mitigations tracked as follow-ups.**

The independent adversarial reviewer verified against the code: (1) anomaly only RAISES a would-be-allowed floor verdict to step-up — it can never convert a refuse to allow, weaken the floor, or suppress a required step-up (the score is consulted only after the deterministic deny-by-default floor check passes); (2) message text cannot LOWER the deterministic score (shape-based; the urgency regex + length z-score are add-only) and the optional LLM check is strictly add-only (a prompt-injected "this is the real CEO" → MATCH/empty/unparseable → adds nothing); (3) the store persists SHAPE only (no text/topics; tests + the route assert it); (4) observe-only + dark default confirmed; (5) no authority-by-suspicion (new/thin baseline → no spurious step-up; the floor still protects).

**CONCERN — baseline poisoning (was real):** the highest-weight signal (out-of-character action, 0.45) fired only when `actionCounts[action] === 0`, so a patient attacker / slowly-compromised account could seed a single prior observation to permanently disable it; the reviewer reproduced a poisoned baseline scoring 0.45 < the 0.5 step-up threshold → no step-up. It was a follow-up (not a merge blocker) since the change ships observe-only and the deterministic floor still requires owner/grant regardless — but it had to be closed before enforcement is ever turned on (the whole value of Pillar 3 is catching a *legitimately-authorized* account behaving out of character, which is exactly what poisoning targets).

**Mitigation #1 APPLIED in this PR (`RelationshipAnomalyScorer.ts`):** the out-of-character signal now fires when the action's SHARE is below a floor (`rareActionShareFloor`, default 0.10), not only when never-seen, with the weight scaled by rarity (full at never-seen → 0 at the floor) so a genuinely-routine action never trips it. Regression test added (the reviewer's exact poisoned baseline — 50 reads + 2 seeded money-movement obs → the malicious request now scores ≥ 0.5 and the rare-action signal still names it). **Follow-ups tracked (deeper poisoning resistance):** (#2) recency/EWMA-decay weighting so a recent burst can't durably reshape the histogram; (#3) a minimum-baseline-AGE gate (using the existing `firstSeen`) + a per-principal observation-rate cap. These are schema-touching and not required while observe-only — to be done before the enforce flip.

---

## Evidence pointers

- `tests/unit/slack-relationship-anomaly.test.ts` — 19 tests (store durability/privacy, five-signal scoring, no-baseline conservatism, confidence scaling, LLM fail-closed, gate composition, observer recording).
- `tests/integration/permissions-routes.test.ts` — `GET /permissions/baselines` route (SHAPE-only, single-principal, empty-state).
- `npx tsc --noEmit` — clean. `npm run lint` — clean (state-registry lint accepts the new category; no-silent-llm-fallback ratchet accepts the gating:true style-check callsite).
- Spec: `docs/specs/SLACK-ORG-INTEGRATION-SPEC.md` §7.1–7.4, §7.6.
