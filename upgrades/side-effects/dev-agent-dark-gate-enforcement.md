# Side-Effects Review — Dev-Agent Dark-Gate Enforcement

**Version / slug:** `dev-agent-dark-gate-enforcement`
**Date:** 2026-06-10
**Author:** echo (Instar Agent)
**Spec:** `docs/specs/DEV-AGENT-DARK-GATE-ENFORCEMENT-SPEC.md` (converged 3 rounds, approved)

## Summary of the change

Two slices. **Slice A** routes the cartographer *zero-cost read surfaces* through
the existing `resolveDevAgentGate` so they run LIVE on development agents and DARK
on the fleet (the doc-tree/navigation read + the deterministic conformance audit),
and removes the redundant `egressAcknowledged` second gate from the freshness
sweep (the sweep remains an explicit `enabled:true` opt-in even on dev agents —
NOT dev-gated — because it is the one ongoing-cost surface). **Slice B** closes the
lint hole that let cartographer ship dark-for-everyone: every `enabled: false` in
`ConfigDefaults.ts` must now be DECLARED — either dev-gated (omit `enabled` +
register) or listed in a new `DARK_GATE_EXCLUSIONS` registry with a closed-enum
category and a ≥12-char reason. A one-shot, dev-agent-only migration lights up
existing dev agents on update.

**Files changed (source):**
- `src/config/ConfigDefaults.ts` — OMIT `enabled` from `cartographer` and
  `cartographer.conformanceAudit` (gate decides at runtime); comments updated.
  `freshnessSweep`/`llmEnrichment`/`llmRerank` `enabled:false` left as-is.
- `src/commands/server.ts` — `cartographerEnabled` now via `resolveDevAgentGate`;
  freshness-sweep start predicate drops the `&& egressAcknowledged` term (now
  `enabled` alone). Off-Claude routing probe + per-pass bounds untouched.
- `src/server/routes.ts` — conformance route gate `cfg?.enabled !== true` →
  `!resolveDevAgentGate(cfg?.enabled, ctx.config)` (the only cartographer/
  conformance ACCESS gate; the `sweepEnabled` status field at ~L4169 is a response
  field, not a gate, deliberately untouched).
- `src/core/devGatedFeatures.ts` — required `justification` field on
  `DevGatedFeature` (+ on every existing entry); two new dev-gated entries
  (`cartographer`, `cartographerConformanceAudit`); new `DarkGateCategory`,
  `DarkGateExclusion`, `DARK_GATE_EXCLUSIONS` (all 19 remaining dark defaults
  classified).
- `src/core/PostUpdateMigrator.ts` — `migrateCartographerDevGate`: one-shot
  (`_instar_migrations` marker), dev-agent-only, strips a default-shaped
  `false` at `cartographer.enabled` + `cartographer.conformanceAudit.enabled`
  ONLY; never touches `freshnessSweep`; records `result.upgraded`.

**Files changed (lint/infra):**
- `scripts/lint-dev-agent-dark-gate.js` — Assertion C (unclassified-dark-default +
  registered-but-hardcoded-false), exclusion quality validation (closed category
  enum + ≥12-char reason), brace-in-string loud-fail guard, literal-only limit
  printed in failure header.
- `scripts/lib/dark-gate-attribution.js` (NEW) — single path-attribution module
  shared by the lint and the golden-path test (so the canary checks the SAME
  attributor the lint uses).

**Files changed (tests):** `tests/unit/lint-dev-agent-dark-gate.test.ts`
(extended: assertion-C cases, hand-authored golden-path map, brace-in-string,
destructive-not-gated, exclusion-quality), `tests/unit/PostUpdateMigrator-cartographerDevGate.test.ts`
(NEW), `tests/integration/conformance-dev-gate-route.test.ts` (NEW),
`tests/e2e/cartographer-dev-gate-lifecycle.test.ts` (NEW).

**Files added (docs):** the spec, its `.eli16.md` companion, and the convergence report.

## Decision-point inventory

- **`cartographer.enabled`, `cartographer.conformanceAudit.enabled`** → dev-gate
  (omit + register). Zero egress, zero spend — safe to dogfood live on dev agents.
- **`cartographer.freshnessSweep.enabled`** → NOT dev-gated; explicit opt-in
  everywhere (DARK_GATE_EXCLUSIONS, category `cost-bearing`). Auto-arming recurring
  third-party spend across the dev fleet is a P19 blast-radius risk.
- **`egressAcknowledged`** → neutralized as a second gate (privacy framing was
  incoherent: source already egresses to a model every turn). Field retained for
  back-compat; now inert on the sweep. Noted in the upgrade guide.
- **The other 18 existing `enabled:false` blocks** → classified into
  `DARK_GATE_EXCLUSIONS` (destructive / cost-bearing / structural-stub /
  optional-integration / deliberate-fleet-default). NONE retroactively dev-gated
  in this PR — that is a deliberate, bounded scope. Each observe-only sentinel
  would need its own safety judgment before going live on dev agents; this change
  makes that an explicit, lint-visible decision rather than a silent default.

## 1–7. Analysis

- **Behavioral change:** on a `developmentAgent:true` agent, cartographer's
  read-only surfaces resolve LIVE (previously dark for everyone). On the fleet,
  unchanged (still dark). The freshness sweep's activation is UNCHANGED for
  everyone except that it no longer requires the second `egressAcknowledged` flag.
- **Migration:** existing dev agents have `cartographer.enabled:false` on disk; the
  one-shot migration strips the default-shaped value so the gate decides. Run-once
  marker prevents ever re-stripping an operator's later deliberate `false`. Never
  touches the cost-bearing sweep — no surprise spend on update.
- **Security/cost:** no new egress path (the sweep was already the only egress, and
  its activation conditions only got simpler, not broader — it still needs explicit
  `enabled:true`). No new spend can be auto-armed. The new lint is deterministic,
  reads one file, no network.
- **Reversibility:** fully reversible by reverting the commit. The migration is
  additive (deletes a default-shaped key); reverting restores prior behavior on the
  next update for agents that hadn't yet run it.
- **New failure modes:** none introduced. The lint's brace-in-string guard fails
  LOUD (not silent) if an unhandled case is introduced — a safety improvement.
