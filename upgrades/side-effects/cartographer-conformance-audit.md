# Side-Effects Review — Standards Enforcement-Coverage Audit (spec #3, Tier 2)

**Version / slug:** `cartographer-conformance-audit`
**Date:** `2026-06-10`
**Author:** `Echo`
**Spec:** `docs/specs/CARTOGRAPHER-CONFORMANCE-AUDIT.md` (converged 2 rounds, approved)
**Second-pass reviewer:** `not required — convergence (2 rounds, 3 reviewers + a round-2 verifier) drove two full redesigns; this review covers the seven dimensions on the as-built deterministic code`

## Summary of the change

For each standard in `docs/STANDARDS-REGISTRY.md`, the audit verifies whether the
structural guard its prose NAMES (a test / lint / gate / route) actually exists on
disk, classifies enforcement strength (ratchet > gate > lint > spec-only >
documented-only), and surfaces the GAPS + dangling refs. Deterministic-first,
observe-only, non-gating, dark behind `cartographer.conformanceAudit.enabled`. Two
read routes + a CI ratchet (enforced-ratio floor + zero-dangling ceiling). Touches
**no** merged spec #2 code; reuses only `StandardsRegistryParser` (shipped) and the
`docs-coverage.mjs` script pattern.

**Design note:** convergence rejected two prior drafts — v1 (per-node LLM audit:
~$320/pass on Opus, never converges) and v2 (a no-op, since every node-checkable
standard is already lint-covered, and it leaned on prompt-caching + PIN-scoping the
substrate lacks). v3 inverts the question to one that is cheap, deterministic, and
produces real value day one.

## ⚠ Notable change: a one-line CONSTITUTION repair

Running the audit against the live registry surfaced a genuine **dangling
reference** (the exact broken-guarantee signal the feature exists to catch): the
"Know Your Principal" standard's `**Applied through.**` line cited
`docs/specs/OPERATOR-IDENTITY-BINDING-SPEC.md`, **which does not exist**. Its real
artifacts are `src/core/PrincipalGuard.ts`, `src/users/TopicOperatorStore.ts`, and
`docs/specs/PRINCIPAL-GUARD.md` (all verified present). I repaired that one line to
cite the artifacts that actually exist — a **factual citation correction, NOT a
change to any rule's normative content** — which the feature's own zero-dangling CI
ceiling requires for a clean baseline. This is a transparent, reversible edit to
`docs/STANDARDS-REGISTRY.md`, called out here and in the PR for operator visibility.
The detection capability is independently demonstrated by the e2e test (which plants
a synthetic dangling ref).

## Files touched

- NEW: `src/core/StandardEnforcementExtractor.ts`, `src/core/StandardsEnforcementAuditor.ts`, `scripts/standards-coverage.mjs`.
- MODIFIED (additive): `src/core/StandardsRegistryParser.ts` (`appliedThrough?` field), `src/config/ConfigDefaults.ts` (nested `conformanceAudit`), `src/server/routes.ts` (2 read routes), `src/server/CapabilityIndex.ts`, `src/core/componentCategories.ts`, `src/core/PostUpdateMigrator.ts` (CLAUDE.md section), `.github/workflows/ci.yml`, `.gitignore`, `docs/STANDARDS-REGISTRY.md` (the one-line repair above).
- TESTS: 46 across 3 tiers.

## 1. Over-block

The audit blocks nothing (observe-only). The only gate that can "fail" is the CI
ratchet (enforced-ratio floor + zero-dangling ceiling). Over-block risk = a false
dangling ref failing CI. Mitigation: the verifier scans ALL `src/server/*.ts` for
routes (not just `routes.ts` — a round-of-build fix that stopped `POST
/spec/conformance-check` from false-flagging), and the floor ships at 0 (loose,
ratchets up). A genuine transient is fail-open in the auditor (an unreadable path is
a finding, not a crash).

## 2. Under-block

Could a real gap be missed (read as enforced)? The extractor is conservative — a ref
is only counted if it matches a known enforcement shape AND verifies on disk. A
standard whose guard is named in prose the regex doesn't recognize reads as a GAP
(the safe direction — over-reports gaps, never hides one). The enforced-ratio 0.317
(26 gaps of 41) confirms it is not laxly classifying.

## 3. Level-of-abstraction fit

Extractor (pure ref-extraction) → Auditor (verify + classify) → routes (read
surface) → ratchet (CI floor). Each layer is single-purpose and independently
tested. The auditor is deterministic + idempotent (a content-hash short-circuit
mirrors `docs-coverage.mjs`), so it sits correctly as a pure computation, not a
stateful service.

## 4. Determinism / no-LLM-cost (the v1/v2 footgun this design avoids)

The shipped value is 100% deterministic — local file reads only, ZERO egress, ZERO
token cost, byte-identical output run-to-run (a determinism test pins this). The
LLM-enrichment path is a structural stub, OFF by default, and the deterministic
coverage is always the authority (Signal vs. Authority). This is the direct fix for
the rejected designs' intractable-cost / never-converge flaws.

## 5. Security / data-egress

Default config sends nothing anywhere (no LLM). The coverage report names where the
constitution is UNGUARDED (meta-level, lighter than spec #2's "where code violates
safety"), but is still owner-gated: `/conformance/coverage*` require Bearer +
`X-Instar-Request: 1` intent header (the per-handler pattern, integration-tested for
401/403). We deliberately do NOT claim PIN-scope exclusion — round-2 verification
confirmed the dashboard PIN unlock returns the same bearer token, so that primitive
does not exist; the honest control is the intent header + owner-Bearer (stated in
the spec).

## 6. Failure modes / load

The pass is milliseconds (parse + fs.existsSync + bounded grep). No poller — a slow
optional job recomputes + raises ONE aggregated notice only on gap GROWTH (Bounded
Notification Surface). The store is a single compacted JSON bounded by the standards
count (~41 rows) — no unbounded growth, no rotation needed. Default-OFF means zero
load until opt-in.

## 7. Migration / compatibility (Migration Parity)

`conformanceAudit` nests under `cartographer` (deep-merge backfill — no migrateConfig
needed, verified pattern from spec #2's `freshnessSweep`). The CLAUDE.md section
ships via `migrateClaudeMd` (own marker 'Standards Enforcement Coverage',
idempotent) AND is registered in the feature-completeness test's legacy-migrator
allowlist. The `/conformance/coverage*` routes are in CapabilityIndex.
`StandardsCoverageEnrichment` registered under category `job` (+ wiring test).
Rollback: disabling the flag 503s the routes + stops the job; the JSON store goes
inert. No migration reversal. No change to any merged spec #2 behavior (additive).
