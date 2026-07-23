---
title: "Feature Maturation Discipline — declared dark to live graduation"
slug: "feature-maturation-discipline"
author: "echo"
status: "operator-approved v1 core"
parent-principle: "Maturation Path — Every Feature Ships Enabled on Developer Agents"
approved: true
---

# Feature Maturation Discipline

## Outcome

The constitutional rule requires every feature spec to declare how the feature moves from dark or observe-only, through mandatory live testing on a mentee with an overseer acting as the user, to fleet availability. V1 makes every missing or malformed declaration structurally visible while WARN still permits convergence; only a later approved veto activation can guarantee that every converged spec carries the plan. V1 does not build the later runtime graduation registry or connect the live-test and apprenticeship subsystems.

V1 has three deliverables only:

1. Add the constitutional **Feature Maturation Discipline** article with an extractor-recognized `**Applied through.**` citation.
2. Add a pure `findMaturationPlanGaps()` detector to `write-convergence-tag.mjs`, mirror it beside `findDecisionPointGaps()`, and invoke it in WARN mode before convergence stamping.
3. Add `migrateFeatureMaturationGate()` so an existing stock install receives the same gate-capable script as a fresh install without overwriting a customized copy.

## Terms

- **dark:** the feature cannot affect fleet behavior.
- **live-on-mentee:** the feature is fully active on the named test agent while an overseer exercises it as the user.
- **fleet:** the feature is eligible for general rollout after its declared evidence gate passes.
- **WARN:** gaps are reported deterministically, convergence stamping continues, and process exit remains zero.
- **veto capability:** the same detector can refuse stamping, but v1 does not activate that authority.

## Verified foundation on the implementation base

Grounded on `upstream/main` commit `b52143b76` / version `1.3.897`:

- `skills/spec-converge/scripts/write-convergence-tag.mjs` already exports `findDecisionPointGaps()` and calls it before stamping. This is the exact pure-detector and caller pattern reused.
- `scripts/instar-dev-precommit.js` and `scripts/lib/convergence-recognition.mjs` already enforce converged + approved specs. V1 does not change their authority.
- `src/core/StandardEnforcementExtractor.ts` recognizes resolving references only under exact `**In practice.**` or `**Applied through.**` prose markers. The new article cites a real gate-capable function and its tests under that exact marker.
- `src/core/PostUpdateMigrator.ts` already migrates stock `.claude/skills/spec-converge/` files with marker/fingerprint checks, skips customized copies, and records upgraded/skipped/error outcomes. `migrateFeatureMaturationGate()` follows that contract rather than inventing overwrite semantics.
- The bundled source is `skills/spec-converge/scripts/write-convergence-tag.mjs`; the deployed copy is `.claude/skills/spec-converge/scripts/write-convergence-tag.mjs`. Fresh installs copy bundled skills through existing scaffold/install machinery.
- `FeatureRolloutReconciler`, `InitiativeTracker`, `LiveTestGate`, and `ApprenticeshipProgram` exist, but v1 neither imports nor modifies them.

Foundation audit: the existing decision-point gate correctly separates structural detection from semantic reviewer authority. Its only relevant gap is that migration methods historically use marker checks rather than content-addressed manifests; v1 preserves the established stock/custom boundary and tests it instead of claiming arbitrary customization can be merged safely.

## V1 design

### D1 — constitutional article and coverage classification

Add `### Feature Maturation Discipline` to `docs/STANDARDS-REGISTRY.md`. Its normative text says every feature with a dark/observe rollout must declare all five maturation rows, and that every feature must include a mandatory live-testing middle rung: fully live on a mentee, overseer acting as user, before fleet graduation. Internal or infrastructure features still carry the rung; their scenarios exercise the observable agent/operator/system contract rather than inventing a graphical user surface.

The article contains this exact extractor marker and resolving references:

> **Applied through.** The gate-capable maturation-plan enforcement chokepoint in `skills/spec-converge/scripts/write-convergence-tag.mjs`.

`StandardEnforcementExtractor` therefore extracts exactly that backtick-fenced path. Extend `StandardsEnforcementAuditor.classifyFileGuard()` with a narrow exact-path case grading this convergence-stamp chokepoint as `gate`; generic scripts remain `lint`. Test paths stay outside `Applied through.` so their stronger `ratchet` class cannot change the article's result. V1 honestly runs the guard in WARN posture; coverage class describes maximum implemented capability, not active veto posture. A classification test asserts the extracted ref and exact `enforcementKind === 'gate'`.

### D2 — closed maturation-plan grammar

Export `findMaturationPlanGaps(specBody, slug)` from `write-convergence-tag.mjs`. It returns a typed result compatible with the neighboring decision detector:

- success: `{ ok: true }`
- gaps: `{ ok: false, reason: 'missing-section' | 'duplicate-section' | 'empty-section' | 'missing-rows' | 'duplicate-rows', missing?: string[], duplicate?: string[] }`

The detector performs one bounded linear pass over the spec body:

1. Strip fenced code blocks before scanning so examples cannot satisfy the contract. Recognize openers with zero to three leading spaces followed by either at least three backticks or at least three tildes. Only the same fence character with length at least the opener closes it; longer, indented, and unclosed fences are supported, and an unclosed opener suppresses the remainder of the body.
2. Match the exact case-sensitive level-2 heading `## Maturation plan`. Zero matches is `missing-section`; more than one is `duplicate-section`.
3. The section begins after that heading and ends at the next level-2 heading or EOF. Whitespace-only content is `empty-section`.
4. Require each exact case-sensitive, line-anchored bullet label once, with zero to three leading spaces and a non-whitespace value after the colon; substrings in prose do not match:
   - `- **dark:**`
   - `- **live-on-mentee:**`
   - `- **fleet:**`
   - `- **graduation criterion:**`
   - `- **dark-window:**`
5. Missing labels produce one ordered `missing-rows` result; duplicates produce one ordered `duplicate-rows` result. Diagnostics are capped to the five canonical labels and contain no spec body excerpts.

Near-match headings, different heading levels, different casing, labels outside the section, labels after the next H2, and fenced examples never satisfy the detector. No slug is grandfathered in WARN mode; legacy specs remain stampable because warnings do not veto.

### D2 enforcement state machine

The module owns an explicit repository constant `MATURATION_PLAN_ENFORCEMENT = 'warn'` with a closed type/validation for `'warn' | 'veto'`. V1 sets it to `warn`. It also exports pure `applyMaturationPlanEnforcement(specBody, slug, mode)`, returning `{ action: 'continue' | 'refuse', diagnostic: string | null, gaps }`; tests exercise both modes without an environment/config override. Direct `main()` always passes the repository constant.

`main()` calls the detector beside `findDecisionPointGaps()` before writing the convergence tag:

- `ok: true`: continue silently.
- gap + `warn`: write one deterministic bounded stderr warning listing reason and canonical row names, then continue stamping and exit zero.
- gap + `veto`: write the same diagnostic, refuse to stamp, and exit one.

The veto branch is implemented and tested so the resolving reference is genuinely gate-capable, but changing the constant to `veto` is a separate operator-approved maturation change after live evidence. V1 never refuses a spec for maturation-plan gaps.

### Migration parity

Add `migrateFeatureMaturationGate(result)` to `PostUpdateMigrator` and invoke it in the existing migration sequence after the earlier spec-converge migrations.

Migration contract:

- marker/version: bundled and deployed scripts carry `FEATURE_MATURATION_GATE_V1`.
- installed target: `.claude/skills/spec-converge/scripts/write-convergence-tag.mjs`.
- bundled source: `skills/spec-converge/scripts/write-convergence-tag.mjs` resolved from the installed package.
- missing installed file: record `skipped` with a fixed reason; do not create a partial skill tree.
- already marked v1: return without mutation and record no duplicate upgrade.
- stock predecessor: only replace when the deployed file has the established convergence-script fingerprint (`write-convergence-tag.mjs — stamp a spec`) and lacks the v1 marker; copy the bundled file atomically and record `upgraded`.
- customized or unreadable predecessor: preserve bytes and record fixed `skipped` or `errors` metadata, including that the maturation gate remains absent; never template-overwrite unknown content. Existing PostUpdate migration reporting surfaces that outcome in the update result/log.
- dispatch is idempotent and does not add configuration. WARN is a source-controlled rollout posture, not a per-machine knob that can evade the constitutional signal.

Fresh-install versus updated-install parity tests compare the deployed script bytes/marker and detector behavior. Installed copies are machine-local derived replicas of the unified git source until each machine updates; version skew is non-blocking because v1 is WARN, and migration outcome makes skew observable.

## Named follow-ons — not authorized or implemented by v1

- **v2 / D4:** a per-feature stuck-dark registry and `dark-too-long` digest reason derived from the declared dark-window.
- **v3 / D3:** connect `LiveTestGate` to `ApprenticeshipProgram` so a real mentee is fully live while the overseer acts as user and records scenario evidence.

These names preserve sequencing only. V1 adds no registry, attention reason, API, signed live-test artifact, mentee runtime target, or import between those subsystems. Each follow-on requires its own converged and approved spec.

Until v2, dark-window enforcement is explicitly manual: the git-tracked maturation plan and release evidence are the durable review artifacts, but no timer resurfaces an overdue window. That temporary open loop is accepted only because the operator fixed v1 scope to pure structure; this spec does not misrepresent it as automated closure.

## Multi-machine posture

- Git-tracked spec, standard, detector, and tests: **unified**.
- Deployed `.claude/skills/spec-converge/` script: machine-local derived replica of the unified bundled source. Each machine receives it through normal package update migration; it holds no independent user data or authority. WARN makes temporary version skew non-blocking.
- Migration results: existing per-machine update evidence; no new URL, user notice, or durable cross-machine state.

No `machine-local-justification` marker is required because no inherently local credential or hardware resource is introduced.

## Decision points touched

- **Maturation-plan structural detector** — `invariant`. The five labels and unique H2 boundary are an enumerable grammar. It produces bounded signals and does not judge plan quality.
- **WARN/veto caller posture** — `invariant`. A closed repository constant selects whether the same structural gaps warn or refuse. V1 fixes it to WARN; semantic adequacy remains with spec-converge reviewers.
- **Stock/custom migration boundary** — `invariant`. Exact marker/fingerprint presence permits stock replacement; unknown bytes are preserved and surfaced.

No competing-signal judgment point is added. Reviewer semantic judgment already exists in spec convergence and is not replaced by string heuristics.

## Frontloaded Decisions

- **FD1:** V1 is D1 + D2 + migration parity only; D4 and D3 are separately approved follow-ons.
- **FD2:** WARN means stamps and exit zero; veto capability exists but is inactive.
- **FD3:** the five canonical Markdown bullet labels above are the complete v1 schema; no YAML/config schema is added.
- **FD4:** all features with a dark/observe stage declare the same three rungs. Test scenarios adapt to the observable contract, but the live-testing rung is never waived.
- **FD5:** WARN posture is source-controlled and has no configuration knob.
- **FD6:** migration replaces only a recognizable stock predecessor and preserves customized files.
- **FD7:** no grandfather allowlist is added while posture is WARN.
- **FD8:** Markdown rows are chosen over new YAML/JSON because the plan is primarily a human review artifact, matches existing spec conventions, and avoids a second schema/migration surface. The closed scanner supplies structural certainty; reviewers retain semantic authority.

## Maturation plan

- **dark:** Ship the detector in WARN posture; malformed or absent plans produce bounded would-refuse diagnostics without blocking convergence.
- **live-on-mentee:** Exercise the gate-capable script on the development mentee with overseer-driven valid, missing, partial, duplicate, fenced-spoof, and large-body scenarios while WARN remains active.
- **fleet:** A separately approved change may flip the source-controlled posture to veto only after the declared evidence is clean; v1 itself remains WARN on every install.
- **graduation criterion:** All parser, CLI, classification, and migration parity tests pass; the mentee WARN scenario matrix records zero false positives and every malformed fixture is detected.
- **dark-window:** Review WARN evidence within 14 days of merge; exceeding the window is visible in the plan/release evidence but v1 adds no automated stuck-dark registry.

## Acceptance matrix

1. Detector unit tests: valid; missing/empty section; each missing row; duplicate heading; duplicate row; case/near-match; backtick, tilde, longer, indented, and unclosed fenced spoofs; prose substrings; wrong heading level; next-H2 boundary; legacy spec; large body. Assert bounded deterministic diagnostics and linear implementation shape.
2. Enforcement tests: the pure function returns continue/refuse for WARN/veto. CLI tests cover the real WARN main path: exit zero, stamp convergence, and emit one warning; clean plan emits none. No env/config override exists.
3. Regression: all existing `findDecisionPointGaps` behavior remains byte-for-byte equivalent.
4. Standards: extractor/auditor classifies the exact new article as `gate` through `**Applied through.**` refs.
5. Migration: missing target, already marked, stock upgrade, customized skip, unreadable error, idempotent rerun, dispatch, and fresh-versus-updated parity.
6. Scope ratchet: tests assert v1 changes do not import or modify `FeatureRolloutReconciler`, `InitiativeTracker`, `LiveTestGate`, or `ApprenticeshipProgram`.

## Rollback

Revert the detector invocation, article, and migration dispatch in the next patch. WARN adds no blocked specs, configuration, runtime service, database, or user state. A migrated script is a stock built-in copy and can be replaced by the next stock migration; customized copies were never overwritten.

## Open questions

*(none)*
