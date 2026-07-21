---
title: "Feature Maturation Discipline — enforced dark → mentee-live → fleet graduation"
slug: "feature-maturation-discipline"
author: "echo"
status: "operator-approved 2026-07-21 (Justin, topic 29723 'yes, lets move forward') — routed to Codey for spec-converge + build v1"
---

# Feature Maturation Discipline

## Problem statement

Features correctly ship **dark / off-by-default** (Instar's safe-rollout norm). But nothing
STRUCTURALLY forces a dark feature to carry — and eventually walk — a real graduation plan. A
feature can ship dark and sit there indefinitely: the "observe-mode rots without counterfactual
evidence" failure ([[observe-mode-must-graduate]]) at fleet scale. That is the exact thing
Justin flagged: *"'off by default' always scares me."*

Two coupled operator directives (2026-07-21, topic 29723) define the fix:
1. Make a robust maturation plan a **requirement enforced via infra for ALL features** — if a
   feature ships dark, its path to live must be declared and gated, not a wish.
3. Make a robust **live-testing phase MANDATORY**: the feature goes fully live for a *test
   agent* (Codey), and is tested with the *overseer agent* (me) **acting as the user** across
   scenarios — before the operator ever touches it.

These are the same machine: **the live-testing phase IS the middle rung of the graduation
ladder**, not a separate idea.

```
dark / observe-only  →  live-on-mentee (Codey) WITH overseer-as-user scenario testing  →  fleet
```

## Verified foundation (capability-grep evidence — finding #1)

Grounded against the freshest tree (`.worktrees/drive8-throughput-metrics`, v1.3.890, HEAD
`5566bb1`) — NOT the stale `.dev/instar` (v1.3.737). All refs are file:line-confirmed:

- **Spec-converge required-section gate** already exists and is the exact pattern to copy:
  `skills/spec-converge/scripts/write-convergence-tag.mjs` runs hard exit-1 gates before
  stamping — `findDecisionPointGaps()` (lines 144-168) matches `^##\s+Decision points touched`,
  returns `{ok:false, reason:'missing-section'}` when absent, and its caller (lines 260-283)
  turns that into a fatal refusal. `GRANDFATHERED_SLUGS` (line 140) is the allowlist for
  pre-existing specs, extended only by PR.
- **Commit-time refusal**: `scripts/instar-dev-precommit.js` Step 6 (lines 603-685) blocks a
  commit whose spec is `!converged` or `!approved` via `recognizeConvergence()`
  (`scripts/lib/convergence-recognition.mjs:91`) — a frontmatter-only predicate; a new required
  frontmatter field slots in here.
- **Graduated-rollout machinery is REAL and wired**: `src/core/featureRollout.ts` (`deriveRolloutStage`
  — the driver can never silently promote), `src/core/FeatureRolloutReconciler.ts` (`reconcile()`
  upserts one initiative per spec from git artifacts; wired at `server.ts:17384`),
  `src/core/InitiativeTracker.ts` (`RolloutInfo` @82, attention reasons `stale|needs-user|next-check-due|ready-to-advance`
  @361, surfaced at `GET /initiatives/digest` `routes.ts:14874`). **HONEST GAP: there is NO
  dedicated "this feature has been dark too long" flag** — only the stale/needs-user digest.
- **Live-User-Channel Proof** exists as a COMPLETION gate only: `src/core/LiveTestGate.ts`
  (vetoes a "done" verdict for an author-declared `userFacing` feature lacking a signed
  artifact; wired at `routes.ts:5822`), `src/core/LiveTestHarness.ts` / `LiveTestRunner.ts` /
  `LiveTestArtifactStore.ts` (drives the operator's OWN machines + DEMO channels). **HONEST GAP:
  the "run live on mentee Codey, overseer acts as user across scenarios" phase does NOT exist as
  combined code.** `src/core/ApprenticeshipProgram.ts` holds the overseer/mentor/mentee roles
  (@375) but has ZERO reference to LiveTestGate/Harness — the two modules are unconnected.
- **Enforcement-coverage audit**: `src/core/StandardsEnforcementAuditor.ts` classifies each
  standard by its STRONGEST guard (`ratchet>gate>lint>spec-only>documented-only`);
  `StandardEnforcementExtractor.ts` reads guard-refs ONLY from a standard's `**In practice.**` /
  `**Applied through.**` prose lines. **HONEST CORRECTION to the morning report**: the live
  `GET /conformance/coverage/health` read (1 gate / 21 documented-only / ratio 0.0455) partly
  reflects the extractor MISSING guards not cited under those exact markers — e.g. the existing
  "Maturation Path" standard names resolving refs but may not read as a `gate`. The enforcement
  layer is real but **under-surfaced**; the fix must land BOTH the guard AND its citation.
- **Migration parity** shape: one idempotent `migrateXxx(result)` in
  `src/core/PostUpdateMigrator.ts` (marker-guard pattern @1381, dispatch @1113).

## Proposed design

A new constitutional standard — **Feature Maturation Discipline** — landed as a REAL enforced
`gate` (a spec-converge refusal + a runtime registry), not more prose. Five deltas:

- **D1 — the standard.** Every feature MUST declare a graduation plan with an explicit rung
  ladder (dark → mentee-live+overseer-as-user → fleet) and a gate at each rung. Lands in
  `docs/STANDARDS-REGISTRY.md` with an `**Applied through.**` line naming a resolving guard so
  the auditor classifies it `gate` (not documented-only).
- **D2 — mandatory `## Maturation plan` spec section.** Add `findMaturationPlanGaps(specBody,
  slug)` next to `findDecisionPointGaps` in `write-convergence-tag.mjs` + an exit-1 gate block
  in `main()` — `write-convergence-tag.mjs` REFUSES to stamp the convergence tag when the
  section (rung ladder + the mandated live-testing phase + a graduation criterion + a declared
  dark-window) is missing. Symmetric to the decision-points / posture gates. Section presence =
  the cheap deterministic signal; the lessons-aware reviewer holds semantic authority over
  whether the plan is REAL. `GRANDFATHERED_SLUGS` exempts pre-existing specs.
- **D3 — mandatory live-testing phase (the graduation rung).** Broaden `LiveTestGate.evaluate`
  from `userFacing`-only to EVERY feature's declared graduation, and wire `ApprenticeshipProgram`
  (Codey as the mentee target) into `LiveTestHarness` as a run target so the harness drives a
  REAL mentee agent while the overseer (me) acts as the user across the required-risk-category
  scenario matrix, producing a signed PASS/FAIL artifact. This is the biggest net-new piece (two
  currently-unconnected modules) and generalizes the Live-User-Channel Proof harness.
- **D4 — per-feature graduation-status registry + stuck-dark surfacing.** Add a `'dark-too-long'`
  attention reason to `InitiativeTracker` keyed off the spec's DECLARED dark-window, surfaced via
  `GET /initiatives/digest` — upgrading the maturation heads-up system
  ([[maturation-headsup-system-built]]) from aggregate-informational to per-feature-bound. Builds
  on the already-wired `FeatureRolloutReconciler`; no new engine.
- **D5 — enforcement-debt backlog.** Treat the conformance audit's documented-only set as the
  backlog of standards to turn from wish into structure; THIS standard ships enforced as the
  exemplar (first repayment).

Plus a migration-parity `migrateFeatureMaturationGate()` so deployed agents get the spec-converge
gate + the standard on update, not just fresh installs.

## Phasing (dark-first, each rung gated)

- **v1 (cheapest, highest leverage — pure structure):** D2 spec-converge required-section gate
  (ships in `warn` mode first — logs would-refuse without blocking) + D1 standard landed as an
  enforced `gate` + the migration. Makes EVERY future spec declare a maturation plan. No runtime
  behavior change; no new judgment point.
- **v2:** D4 stuck-dark registry (`'dark-too-long'` reason + digest surface).
- **v3:** D3 live-testing-every-feature-on-mentee (the LiveTestGate ⟷ ApprenticeshipProgram
  wiring) — the largest, genuinely-new build. Named follow-on because it needs real mentee-side
  substrate, NOT deferral-by-avoidance.

## Multi-machine posture

The spec-converge gate + Standards Registry are git-tracked repo artifacts — **unified** (every
machine derives the same refusal from the same source). The graduation-status registry
(`FeatureRolloutReconciler`/`InitiativeTracker`) derives each feature's stage from git-tracked
spec artifacts, so it is **unified-by-derivation** — any machine reaches the same stage from the
same specs. No machine-local surface.

## Decision points touched

- **`findMaturationPlanGaps` section + per-row check** — `invariant`. Deterministic parse
  (section present + rung/window/criterion rows present), mirroring `findDecisionPointGaps`.
  Justified: a structural gate, not a competing-signals point; the semantic "is the plan real"
  judgment is delegated to the lessons-aware reviewer (Signal-vs-Authority), not decided here.
- **`'dark-too-long'` classification** — `invariant`. Deterministic: a feature past its OWN
  declared dark-window. The window is author-declared in the spec, not guessed.
- **Live-testing scenario matrix verdict** — the GATE is `invariant` (artifact present + all
  required risk categories marked PASS is a deterministic check); the per-scenario PASS/FAIL is
  the **human overseer's** judgment recorded in a signed artifact, NOT an automated/LLM decision
  point. No new machine judgment gate is introduced.

## Maturation plan

*(dogfoods the very section this spec mandates)*

- **dark:** D2's gate ships in `warn` mode — spec-converge still stamps but emits a would-refuse
  warning on a missing `## Maturation plan` section. Soaks on the development agent.
- **live-on-mentee (overseer-as-user):** Codey's next spec must carry a real `## Maturation plan`
  section; I (overseer) drive specs through the gate across scenarios on Codey's install —
  missing section → refused, partial → refused, complete → stamped — recording a signed
  PASS/FAIL matrix. This IS D3 proving itself on its own gate.
- **fleet:** flip the gate to hard `veto` (blocking) fleet-wide once the mentee soak is clean.
- **graduation criterion:** a clean mentee live-test matrix + zero false-refusals during the warn
  soak.
- **dark-window:** if the gate sits in `warn` mode past 14 days without a mentee live-test, D4's
  `'dark-too-long'` surfaces it (the standard nagging itself — the strongest dogfood).

## Open questions

- Should v1's warn-soak window (14d) be a config knob or fixed? (lean: config,
  `standards.maturationDiscipline.warnSoakDays`.)
- D3 scope: does "every feature" include pure-internal refactors with no observable surface, or
  only features with a config flag / rollout stage? (lean: only flag-carrying features — a
  refactor with no dark stage has nothing to graduate.)

## Migration parity

`migrateFeatureMaturationGate(result)` in `PostUpdateMigrator.ts` (marker-guarded, template-
overwrite of the updated `write-convergence-tag.mjs` gate + config-default add for the warn-soak
knob), registered in `migrate()`. Idempotent (marker early-return). Reaches deployed agents on
update, not just `init`.

## Division

Echo authored this design (grounded on the real gate / rollout / live-test / audit machinery);
Justin approved moving it forward (2026-07-21, topic 29723). Codey converges + builds v1. Same
division as throughput-floor / claim-verification. Related: [[observe-mode-must-graduate]],
[[maturation-headsup-system-built]], [[live-verify-multimachine]].
