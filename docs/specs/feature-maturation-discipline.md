---
title: "Feature Maturation Discipline — v1 maturation-plan visibility toward enforced graduation"
slug: "feature-maturation-discipline"
author: "echo"
approved: true
parent-principle: "Maturation Path — Test Agent → Development Agent → Fleet"
status: "operator-approved + refined 2026-07-21 — v1 WARN visibility only; three-rung enforcement completes through named v2/v3 arms"
review-convergence: "2026-07-21T18:13:37.083Z"
review-iterations: 6
review-completed-at: "2026-07-21T18:13:37.083Z"
review-report: "docs/specs/reports/feature-maturation-discipline-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# Feature Maturation Discipline

## Problem statement

Features correctly ship **dark / off-by-default** (Instar's safe-rollout norm). But nothing
STRUCTURALLY forces a dark feature to carry — and eventually walk — a real graduation plan. A
feature can ship dark and sit there indefinitely: the "observe-mode rots without counterfactual
evidence" failure ([[observe-mode-must-graduate]]) at fleet scale. That is the exact thing
Justin flagged: *"'off by default' always scares me."*

Three operator directives (2026-07-21, topic 29723) define the fix:
1. Make a robust maturation plan a **requirement enforced via infra for ALL features** — if a
   feature ships dark, its path to live must be declared and gated, not a wish.
2. Make a robust **live-testing phase MANDATORY**: the feature goes fully live for a *test
   agent* (Codey) under its overseer, and is tested with the *overseer agent* (me) **acting as
   the user** across scenarios — before the operator ever touches it.
3. **Precise rung semantics (operator clarification).** "Dark" no longer means "off for all
   except *dev* agents" (the old, inconsistently-enforced norm where Echo was the sole dev
   agent). It now means **off for all EXCEPT *test* agents** — an agent with a dedicated
   manager/overseer (the Echo→Codey relationship). A test agent runs the feature live
   immediately, but at a safe distance: the overseer observes and steps in if it misbehaves,
   so a broken new feature never reaches a user unmanaged. The graduation ladder therefore
   gains an explicit **dev-agent middle rung** between test-agent-live and fleet.

The live-testing phase IS the first (test-agent) rung; the dev-agent rung is the soak with
real user interaction before fleet. Each rung is a **gate**, not a wish:

```
dark = live for TEST agents only (Codey, under an overseer; overseer-as-user scenario testing)
   →  live for DEV agents (Echo — more responsibility + direct user/operator interaction)
   →  live for ALL agents (fleet)
```

### Agent-class glossary

- **test agent:** persisted agent-role metadata says `test`; it has a named overseer and receives
  the feature first under that supervision.
- **development agent:** persisted `developmentAgent` role metadata; it interacts directly with
  the operator during the second soak.
- **fleet:** every agent class. This is the only final rollout target.
- **overseer:** the manager recorded by the existing apprenticeship relationship; it supplies
  scenario judgment but is not another rollout class.

The resolver consumes role metadata, never agent names or ids. Codey and Echo are examples, not
entries in an allowlist.

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

A strengthening of the existing constitutional **Maturation Path** standard, backed in v1 by a
visible spec-converge WARN check, not a parallel standard or maturation engine. V1 prevents new
plans from being invisible; it does not yet prevent a feature from remaining dark. Seven deltas
are mapped below; only D1, D2, and migration parity are in v1:

- **D1 — strengthen the existing Maturation Path article in place.** Every feature MUST declare a
  graduation plan with the explicit three-rung agent-class ladder (dark = test-agent-live →
  dev-agent-live → fleet) and a gate at each rung. The existing article at
  `docs/STANDARDS-REGISTRY.md` is updated, not duplicated. Its `**Applied through.**` line cites
  the live `src/core/FeatureMaturationPlanGate.mjs` guard under an accepted extractor prefix; test
  evidence is kept outside that citation so strongest-guard precedence classifies the article
  `gate`, not `ratchet` or `documented-only`. The rung is
  keyed on agent class** (test / dev / all), derived from an agent-role field — NOT a per-agent
  allowlist — so "dark" is a precise, checkable state (which agent classes have the flag on),
  not a vibe.
- **D2 — mandatory `## Maturation plan` spec section, WARN in v1.** A pure exported
  `findMaturationPlanGaps(specBody, slug)` lives in `scripts/feature-maturation-plan-gate.mjs` and
  is imported beside `findDecisionPointGaps` in `write-convergence-tag.mjs`. In v1, a missing or
  incomplete plan emits a stable `MATURATION_PLAN_WARN` diagnostic to stderr and convergence is
  still stamped; it does not refuse. The validator requires exactly the three agent-class rung
  labels (`test-agent-live`, `dev-agent-live`, `fleet`), plus non-empty `graduation criterion` and
  `dark-window` rows. It strips YAML frontmatter and fenced code blocks before selecting the first
  real level-2 section, stops at the next level-2 heading, rejects duplicate maturation headings,
  and ignores heading/row tokens hidden inside comments or blockquotes. These adversarial parsing
  rules prevent examples, quoted text, or a later shadow section from satisfying the signal.
  `GRANDFATHERED_SLUGS` is not used for WARN mode. Structure is only the cheap deterministic
  signal; the lessons-aware reviewer remains semantic authority over whether the plan is real.
  The exact accepted syntax is one Markdown bullet per field:
  `- **test-agent-live:** ...`, `- **dev-agent-live:** ...`, `- **fleet:** ...`,
  `- **graduation criterion:** ...`, and `- **dark-window:** ...`. Each label appears exactly once
  with non-empty text after the colon; labels in prose, tables, code, comments, or quotes do not
  count.
- **D3 — v3 design, mandatory live-testing phase (the graduation rung).** Broaden `LiveTestGate.evaluate`
  from `userFacing`-only to EVERY feature's declared graduation, and wire `ApprenticeshipProgram`
  (Codey as the mentee target) into `LiveTestHarness` as a run target so the harness drives a
  REAL mentee agent while the overseer (me) acts as the user across the required-risk-category
  scenario matrix, producing a signed PASS/FAIL artifact. This is the biggest net-new piece (two
  currently-unconnected modules) and generalizes the Live-User-Channel Proof harness.
- **D4 — v2 design, per-feature graduation-status registry + stuck-dark surfacing arm.** Add a `'dark-too-long'`
  attention reason to `InitiativeTracker` keyed off the spec's DECLARED dark-window, surfaced via
  `GET /initiatives/digest` — upgrading the maturation heads-up system
  ([[maturation-headsup-system-built]]) from aggregate-informational to per-feature-bound. Builds
  on the already-wired `FeatureRolloutReconciler`; no new engine.
- **D5 — enforcement-debt backlog.** Treat the conformance audit's documented-only set as the
  backlog of standards to turn from wish into structure; THIS standard ships enforced as the
  exemplar (first repayment).
- **D6 — EXTEND, do not duplicate (operator-flagged, HARD convergence gate).** The completed
  pre-build audit maps every delta to the named existing owner:
  - D1 strengthens the existing **Maturation Path** registry article in place.
  - D2 extends the existing spec-converge chokepoint beside `findDecisionPointGaps`.
  - D3 v3 composes `LiveTestGate` + `LiveTestHarness` with the existing apprenticeship relation.
  - D4 v2 extends `FeatureRolloutReconciler` + `InitiativeTracker` with one attention reason.
  - D7 v3 reuses the throughput-metrics ledger (#1535) plus benchmark/decision-quality machinery.

  Instar already
  carries substantial maturation machinery — `FeatureRolloutReconciler` + `InitiativeTracker`
  (graduated rollout + the stale/needs-user digest), `LiveTestGate` + `LiveTestHarness`
  (Live-User-Channel Proof), and a "Maturation Path" standard. This spec EXTENDS those; it
  introduces NO parallel maturation engine (D2 adds a spec-section gate; D3 wires two already-
  existing modules; D4 adds one attention reason to the existing reconciler). The operator
  explicitly flagged the duplication risk ("we have previous work, many times, with maturation
  plans"). Anti-duplication is therefore a HARD gate: the lessons-aware / foundation-audit
  reviewer MUST confirm — before build — that each delta composes with a NAMED existing surface
  rather than re-implementing it. If a genuine duplicate is found, that is itself the operator's
  signal to strengthen **convergent-auditing enforcement in the spec-dev process** (ties to the
  *Iterative Audit to Convergence* standard) — a second-order deliverable surfaced to the
  operator, never a silent patch.
- **D7 — v3 design, measurable per-feature metrics + recurring evaluation driving arm (operator directive 3 — the
  anti-stale mechanism).** The ladder only holds if each rung's health is TRACKABLE and
  MEASURABLE and the measurement runs on a REGULAR cadence, so nothing rots at a rung. Every
  feature exposes per-rung metrics on the SAME measurement substrate as the throughput-metrics
  ledger (#1535) and the benchmark / decision-quality machinery (this is the direct tie to the
  benchmark goals the operator named), and a recurring evaluation job re-scores each
  dark/soaking feature against its declared graduation criterion + declared dark-window. D4's
  stuck-dark registry is the SURFACING arm; this recurring re-scoring is the DRIVING arm — the
  pair is what "the measuring and evaluating needs to be done on a regular basis" requires.

Plus a migration-parity `migrateFeatureMaturationGate()` so deployed agents get the spec-converge
gate + the standard on update, not just fresh installs.

## Phasing (dark-first, each rung gated)

- **v1 (this build; pure structure):** D2 WARN diagnostic + D1 in-place Maturation Path
  strengthening + migration parity. It exposes what a hard gate would reject without refusing a
  convergence stamp. No runtime feature behavior changes and no agent allowlist is introduced.
- **v2:** D4 stuck-dark registry (`'dark-too-long'` reason + digest surface).
- **v3:** D3 live-testing-every-feature-on-mentee (the LiveTestGate ⟷ ApprenticeshipProgram
  wiring) — the largest, genuinely-new build. Named follow-on because it needs real mentee-side
  substrate; its named boundary is not scope evasion.

### V1 acceptance boundary

V1 is complete when plans that previously passed invisibly now produce deterministic, tested WARN
evidence; it is accurately a **maturation-plan visibility** increment. It does not close the
stuck-dark problem. That problem is closed only when D4's v2 surfacing arm and D7's v3 recurring
driving arm operate against the same existing rollout records. The release note and ELI16 must use
this narrower claim.

Before WARN can become veto, the owner reviews the accumulated WARN corpus for false positives and
false negatives. Parser changes may add backward-compatible accepted forms or fix misclassification;
they may not introduce semantic judgment into the deterministic gate. Role precedence, temporary
role lifecycle, mixed-role handling, multiple-overseer conflict resolution, and mutation authority
are explicit v3 foundation-audit questions; until answered, unknown or conflicting roles remain
fleet-disabled. V3 scenario derivation must cite the feature's actual interfaces, risk class, and
expected user workflow rather than relying only on overseer intuition.

The v1 release artifact names the owning InitiativeTracker record, the test-rung start date, and
the 14-day WARN→veto disposition deadline. Existing reconciliation owns that record; v1 does not
create a second cadence engine. Before veto, the corpus review must either demonstrate that the
canonical Markdown form is stable or replace it with a schema-backed form through a separately
reviewed compatibility migration. Published positive and adversarial examples accompany either
form. For D3, automated contract/replay assertions are primary evidence; overseer judgment is
limited to explicitly subjective rows.

### Alternatives considered

External feature-flag lifecycle products and generic workflow schedulers can record rollout stages,
but adopting one would duplicate Instar's existing `FeatureRolloutReconciler`, `InitiativeTracker`,
spec-converge review authority, and agent-role relationships. This design therefore extends those
native owners. External systems may later supply detector signals or dashboards, but they do not
become a parallel source of rollout truth.

## Multi-machine posture

The v1 spec-converge check + Standards Registry are git-tracked repo artifacts — **unified** (every
machine derives the same diagnostic from the same source). The graduation-status registry
(`FeatureRolloutReconciler`/`InitiativeTracker`) derives each feature's stage from git-tracked
spec artifacts, so it is **unified-by-derivation** — any machine reaches the same stage from the
same specs. V1 creates no signed live-test artifact, role state, or digest state. V2/v3 must name
the existing replication or proxied read for each runtime artifact before implementation; they
may not inherit this v1 unified claim by assumption.

## Decision points touched

- **`findMaturationPlanGaps` section + per-row check** — `invariant`. Deterministic structural parse mirroring `findDecisionPointGaps`; semantic adequacy remains with the lessons-aware reviewer authority.
- **`'dark-too-long'` classification** — `invariant`. Deterministic comparison against the feature's reviewed declared window; no guessed deadline.
- **Live-testing scenario matrix gate** — `invariant` for artifact/category/assertion presence; subjective per-scenario PASS/FAIL remains recorded human judgment and is not converted into an automated gate.

## Maturation plan

*(dogfoods the very ladder this spec mandates — the three agent-class rungs)*

- **test-agent-live:** D2's gate ships in `warn` mode on Codey under its overseer — spec-
  converge still stamps but emits a would-refuse warning on a missing `## Maturation plan`
  section. It runs LIVE on the test agent (Codey) immediately: Codey's next spec must carry a
  real `## Maturation plan` section, and I (overseer) drive specs through the gate across
  scenarios on Codey's install — missing/partial section → stamped with
  `MATURATION_PLAN_WARN`, complete → stamped without that diagnostic — recording the result.
- **dev-agent-live:** after a clean test-agent soak, the gate goes live on dev agents such as Echo — I
  run real spec-dev through it with direct operator interaction, still `warn` mode.
- **fleet:** flip the gate to hard `veto` (blocking) for ALL agents once the dev-agent soak is
  clean. The ratchet is explicit: within 14 days of the test-agent rung start, record the
  three-case dogfood evidence; within 14 days of the dev-agent rung start, record the same evidence
  from direct-user spec work; then the owner must either land WARN→veto or record a failing-rung
  disposition. Hardening cannot broaden parser semantics.
- **graduation criterion:** per rung, a clean live-test matrix at the current rung + zero false
  WARN diagnostics on specs that satisfy the declared structure during that rung's soak; D7's v3
  recurring evaluator will re-score the same criterion on its named future driving arm.
- **dark-window:** if the gate sits at a rung past 14 days without advancing, D4's
  `'dark-too-long'` surfaces it (the standard nagging itself — the strongest dogfood).

## Frontloaded Decisions

- **v1 mode — invariant.** WARN only: diagnostics never change the convergence exit status.
- **Agent targeting — invariant.** Rungs are derived only from agent class: test, development,
  fleet. Per-agent allowlists are forbidden.
- **Role authority boundary — invariant.** V1 documents and parses the ladder but does not resolve
  runtime roles. V3 must reuse the authoritative agent identity/config path for `developmentAgent`
  and the existing apprenticeship relationship for overseer-managed test status; it may not add a
  second role store. Missing or unknown role metadata resolves fleet-disabled. Exact store and
  audited mutation citations are a required v3 foundation audit before runtime wiring.
- **Applicability — invariant.** The plan applies to shipped features with a dark/staged rollout;
  pure internal refactors with no rollout stage have no rung to graduate.
- **Soak duration — cheap-to-change-after.** The spec declares its own duration; this v1 parser
  validates non-empty structure and does not create a config knob or interpret duration semantics.
- **Future hardening boundary — invariant.** A later WARN→veto promotion may veto only missing or
  malformed structure using this same pure parser. Semantic adequacy can never be added to the
  deterministic veto; it stays with the lessons-aware reviewer authority.
- **Dogfood evidence shape — invariant.** Each rung record names start/end timestamps, evaluated
  spec path, expected and actual diagnostic, reviewer identity, evidence artifact path and digest
  or signature, and a pass/fail reason. At least one missing, one adversarial partial, and one
  complete plan are required before the WARN signal advances to the next agent class.
- **Future scenario classes — invariant.** D3's v3 matrix covers interactive user simulation and,
  where applicable, API contract, migration recovery, telemetry, performance, and rollback. A
  staged non-interactive feature cannot pass merely because it has no conversational UI.
- **Future evidence authority — invariant.** V3 stores replayable scenario inputs and
  machine-checkable assertions wherever possible; signed human judgments carry only remaining
  subjective rows. High-risk classes require an independent reviewer disposition before
  promotion, rather than treating one overseer's signature as sufficient.
- **Future dark-window policy — invariant.** D4/D7's v2/v3 design will supply risk-class defaults
  and maxima; a longer feature-declared window requires an explicit lessons-aware reviewer
  disposition. A `dark-too-long` item remains active until it records advance, retirement, or an
  owned re-plan; acknowledgement alone is not terminal. V1 checks only that a window is declared
  and makes no timing decision.

## Open questions

*(none)*

## Migration parity

`migrateFeatureMaturationGate(result)` in `PostUpdateMigrator.ts`, registered once in `migrate()`,
delivers the bundled validator and tag-writer to deployed agent homes. It distinguishes stock from
customized targets by exact SHA-256 membership in a versioned `PRIOR_STOCK_SHA256` set; a header
substring is never customization evidence. Missing targets are created from bundled bytes. A hash
outside the stock set is reported as customized and left byte-identical.

For an accepted stock target, replacement uses a sibling uniquely-named temp file opened with
exclusive create, writes all bundled bytes, `fsync`s and closes the file, renames it over the
target on the same filesystem, then `fsync`s the parent directory. Before replacement it writes an
equally durable `.pre-feature-maturation-v1.bak` snapshot. If any pre-rename step fails, the target
is untouched and the temp is removed; if rename succeeds but directory sync fails, the migration
reports an error and retains the backup for deterministic recovery on the next run. A subsequent
run recognizes either the new bundled hash (done) or the prior-stock/backup pair (retry), so a
crash cannot turn a partial write into an accepted migration. Tests inject failure at write,
file-sync, rename, and directory-sync boundaries and assert target/backup/retry behavior.
Targets and parent directories are resolved under the configured project root; `lstat` rejects a
symlink target, the temp inherits the target's mode, and no path component may escape the root.

## Division

Echo authored this design (grounded on the real gate / rollout / live-test / audit machinery);
Justin approved moving it forward (2026-07-21, topic 29723). Codey converges + builds v1. Same
division as throughput-floor / claim-verification. Related: [[observe-mode-must-graduate]],
[[maturation-headsup-system-built]], [[live-verify-multimachine]].
