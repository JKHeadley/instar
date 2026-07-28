# Side-Effects Review — Dev-Gate Conformance Cross-Check (Slice 3, GrowthMilestoneAnalyst R6)

**Change:** Slice 3 of DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC (converged + approved).
The layer that catches the forgot-the-gate-entirely / misconfig class: on a
development agent, every registered dev-gated feature (Slice 2's
`DEV_GATED_FEATURES`) MUST resolve LIVE — one observed DARK is surfaced as a
proactive growth-analyst finding on the very agent it affects.

- `src/monitoring/GrowthMilestoneAnalyst.ts` — new rule **R6 (devGateConformance)**:
  `computeDevGateConformanceFindings()` iterates the registry, resolves each via
  `resolveDevAgentGate(getConfigByPath(liveConfig, path), liveConfig)`, and emits a
  finding for any that resolve DARK on a dev agent. New `liveConfig?` dep, new
  `devGateDark` digest count, new `rules.devGateConformance` flag (default on),
  R6 wired into `computeFindings` + `buildDigest` + `activeSummary`.
- `src/server/AgentServer.ts` — feeds `liveConfig: options.config` into the analyst.
- `tests/unit/growth-analyst-devgate-r6.test.ts` — both sides of the R6 boundary.

**Implementation-locus note (deviation from the spec's prose, documented honestly):**
the spec's Slice 3 said "Extend FeatureRolloutReconciler … surfaces as a
growth-analyst finding." I implemented the cross-check **in the GrowthMilestoneAnalyst
itself** (rule R6), not in FeatureRolloutReconciler, because (a) the analyst is the
finding/digest surface the spec's outcome names, (b) it is itself dev-gated-LIVE so
it runs on the affected dev agent, and (c) it already consumes the registry pattern.
Same outcome (a growth-analyst finding), cleaner locus. The reconciler was not
modified.

## 1. Over-block — what legitimate inputs does this reject?
R6 is observe-only — it emits a *finding* (signal), never blocks or mutates. A
false positive would be a feature that is *intentionally* dark on a dev agent but
sits in the registry; that is prevented by Slice 2's curation (mcpProcessReaper /
resourceLedger are excluded). Adding a non-conforming feature to the registry is
the only way to mis-flag, and that is a deliberate, reviewed act.

## 2. Under-block — what does it still miss?
A dev-gated feature never added to the registry is invisible to R6 (same registry
dependency as Slice 2). And R6 only runs on a dev agent (`developmentAgent === true`)
with `liveConfig` present — on the fleet it is silent by design (fleet darkness is
expected). These are the intended bounds.

## 3. Level-of-abstraction fit
Right layer: the analyst already computes findings from sensors; R6 is one more
read-only rule over the live config + the registry. No new subsystem.

## 4. Signal vs authority
SIGNAL only. R6 produces a digest finding (the analyst never sends/blocks — it
COMPUTES findings exposed via read routes). It holds no authority over runtime.

## 5. Interactions — shadowing, double-fire, races?
None. Pure computation over injected `liveConfig` + the static registry. Wrapped
in try/catch per feature (a bad path routes to `onError`, never throws). Other
rules (R1–R5) are untouched; R6 is additive in `computeFindings`/`buildDigest`.

## 6. External surfaces
The existing `/growth/digest` + `/growth/status` routes now may include R6
findings + a `devGateDark` count — additive fields, no breaking change. Dark for
the fleet, live on dev agents (the analyst's own gate). No agent-installed files,
no Migration Parity entry.

## 7. Rollback cost
Low — revert the analyst R6 additions + the one AgentServer line + the test.
Behavior reverts to R1–R5 only; no state, no deployed artifact.

## No deferrals
This is the final slice of the initiative (CMT-1253). With Slices 1–3 shipped, the
dev-gate guard spans: lint (drift) → registry+default test (hardcoded default) →
R6 runtime cross-check (forgot-the-gate / misconfig on a live dev agent). <!-- tracked: CMT-1253 -->

## Second-pass review (independent)
Verified: R6 default-on but inert without `liveConfig` (42 existing analyst tests
unchanged green); both sides covered (hardcoded-dark on dev → finding; all-live on
dev → none; fleet → none; absent config → skip; rule-disabled → skip; digest count
+ calm-break asserted). tsc clean; the Slice-1 dark-gate lint stays clean (R6 reads
the gate via the funnel, hardcodes nothing).
