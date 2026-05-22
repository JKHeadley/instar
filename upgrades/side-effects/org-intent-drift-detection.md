# Side-effects review — org-intent drift detection (Phase 4)

Spec: `docs/specs/ORG-INTENT-DRIFT-DETECTION-SPEC.md`
ELI16: `docs/specs/ORG-INTENT-DRIFT-DETECTION-SPEC.eli16.md`
Phase: 4 of 4 (final). Phases 1, 2, and 3 shipped in prior PRs.

## Surface map

| Change | File | Type |
|---|---|---|
| Pure `analyzeOrgIntentDrift()` + `DriftAnalysis` type | `src/core/OrgIntentDriftAnalyzer.ts` (new file) | Additive module |
| New `GET /intent/org/drift` HTTP route | `src/server/routes.ts` | Additive route |
| Weekly drift-audit agentmd job template, `enabled: false` | `src/scaffold/templates/jobs/instar/org-intent-drift-audit.md` (new file) | Job template — distributed via `installBuiltinJobs()` |
| CLAUDE.md ORG-INTENT subsection adds Phase 4 curl line | `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` | Doc + migration |
| Tier 1 unit tests (analyzer + migration) | `tests/unit/OrgIntentDriftAnalyzer.test.ts` (new), `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` (extended) | Test addition |
| Tier 2 integration test | `tests/integration/org-intent-routes.test.ts` (extended) | Test addition |
| Tier 3 E2E test | `tests/e2e/org-intent-drift-lifecycle.test.ts` (new) | Test addition |

## Over-block analysis

**Could the new route or analyzer block anything?**

No. Pure read path. The analyzer takes a snapshot of recent review history (already retained by the gate per its existing retention policy) and produces a derived digest. The route returns the digest. Nothing writes to `ORG-INTENT.md` or to the gate's history. Per `feedback_signal_vs_authority`: SIGNAL only.

**Could the weekly job spam an operator?**

The job ships `enabled: false`. Operators must explicitly opt in. Once enabled, the digest is only sent when `shouldSurface: true` (trend = `rising` or `concerning`). The default thresholds (15% concerning, 5% rising-delta) are calibrated so most weeks stay silent.

**Could the analyzer flag false positives?**

Yes — by design. The trend labels are heuristic. A week with a single bad day might surface as `rising` even if the underlying pattern is noise. This is acceptable because:

- The job's output is a Telegram message, not a code change. The operator reads it on their phone and decides.
- The suggestions are advisory, not directive. "Check whether the constraints need updating" — not "I updated the constraints."
- False negatives (missing real drift) are worse than false positives (occasional noise on a stable agent). The defaults err toward surfacing.

Operators who want different thresholds can pass `lookbackDays` to the route or update the job template's body to override.

## Under-block analysis

**What does the analyzer NOT catch?**

- Drift that doesn't show up in gate review history. If the agent does something off-mission that the gate's reviewers don't flag (e.g. answer the wrong question instead of violating a constraint), the analyzer has no signal to work with. This is the natural limit of any system that operates on gate output.
- Channel-specific patterns. The analyzer aggregates across channels. A surge of blocks on Telegram but stable performance on direct/CLI would show up as overall rising. Future iteration may add per-channel breakdowns.
- Recovery patterns. If the agent drifted in week 1 and corrected in week 2, the half-window comparison would show falling rates, but the analyzer doesn't surface "drift detected but recovered" as a positive signal. Out of scope for v1.

## Level-of-abstraction fit

The analyzer is a pure function over a typed input. The route is a thin wrapper. The job is an agentmd template that just calls the route and renders. No new abstractions introduced. The decomposition mirrors `IntentDriftDetector` (the existing decision-journal-based detector) but operates on a different input space (gate review history vs decision journal), so they're complementary rather than overlapping.

## Signal-vs-authority compliance

Every surface in this phase is **SIGNAL**:

- The analyzer produces a digest, never blocks.
- The route returns the digest, never blocks.
- The job sends a Telegram message, never blocks.

The Coherence Gate from Phase 1 remains **AUTHORITY**. It continues to enforce constraints at message-review time. This phase consumes its output as one input among several; it never modifies the gate's behavior.

This is the right architectural pattern per `feedback_signal_vs_authority`. The drift surface can be wrong without compromising any actual outcome — the worst case is "operator gets a false-alarm Telegram message," not "agent loses a constraint enforcement."

## Interactions with existing systems

| System | Interaction | Risk |
|---|---|---|
| Coherence Gate (Phase 1) | Reads `getReviewHistory()` | None — read-only |
| Session-start injection (Phase 2) | None — different surface | None |
| Tradeoff helper (Phase 3) | None — orthogonal | None |
| Decision journal `IntentDriftDetector` | Sibling system on a different input space | None — they observe different things |
| `installBuiltinJobs()` | New template added to the source dir; will be copied on update | None — non-destructive (installs missing, doesn't overwrite user edits) |
| Existing weekly job slots | New job is independent and off by default | None |

## Rollback cost

Low. Pure additive feature. Three options:

1. **Code revert**: `git revert <PR-merge-sha>` removes new module + route + job template + test files. No data migration to roll back.
2. **Disable the job**: The job ships `enabled: false`. Operators who never enable it see zero behavior change.
3. **Ignore the route**: 404 the route via a config flag if desired (future iteration); currently the route is opt-in via being called.

## Test coverage summary

| Tier | File | Tests | Status |
|---|---|---|---|
| 1 (unit) | `tests/unit/OrgIntentDriftAnalyzer.test.ts` (new) | 11 | ✓ passing |
| 1 (unit) | `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` (extended) | 9 (1 new for Phase 4) | ✓ passing |
| 2 (integration) | `tests/integration/org-intent-routes.test.ts` (extended) | 17 (1 new for Phase 4) | ✓ passing |
| 3 (E2E lifecycle) | `tests/e2e/org-intent-drift-lifecycle.test.ts` (new) | 4 | ✓ passing |

## This is the final phase

This PR closes the four-phase ORG-INTENT runtime project that started with topic 11378 on 2026-05-21. All four phases shipped — gate / session-start / tradeoff / drift — with three-tier test coverage at every step.

## Open follow-ups (NOT this PR — future iterations)

- Per-channel drift breakdowns.
- LLM-supervised drift narrative (Tier 1 supervisor over the digest output).
- Recovery-pattern detection (positive signal when drift corrects).
- Drift digest persistence (week-over-week comparison artifacts).
- Action-level drift (catching off-mission actions that don't trip the gate).
