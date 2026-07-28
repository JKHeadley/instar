# Side-Effects Review — Awareness-parity structural guard + Publishing/Attention Queue

**Change:** Close the *class* of "capability never reaches Codex" bugs (Secret
Drop, Commitments were two instances) with a structural guard, and complete the
two remaining clear gaps (Publishing, Attention Queue) the guard surfaces.

**Files:** `src/core/PostUpdateMigrator.ts` (markers + 2 ensure-blocks),
`tests/unit/feature-delivery-completeness.test.ts` (guard + curated list).
**Spec basis:** Agent Awareness Standard + portability-shadow-capabilities
mirror (same mechanism).

## What changed

1. **feature-delivery-completeness.test.ts** — new STRUCTURAL GUARD: every
   entry in the curated `featureSections` (agent-facing capabilities that must
   reach all frameworks) MUST appear in the `migrateFrameworkShadowCapabilities`
   `markers[]` allowlist, or CI fails. This turns "remember to add the shadow
   marker" into a guarantee (Structure > Willpower, instar P1). Also added
   `Publishing` + `Attention Queue` to `featureSections` (they were real
   user-facing capabilities the curated list had omitted).
2. **PostUpdateMigrator.ts** — `markers[]` += `**Publishing**`,
   `**Attention Queue**` (document order). `migrateClaudeMd` ensure-blocks for
   both (inject if absent: Publishing before Private Viewing, Attention Queue
   before Dashboard). Idempotent.

## Over/under-block

- Guard: pure assertion over source text; no runtime effect. It will fail-loud
  if a future capability is added to `featureSections` without a shadow marker —
  exactly the intent. featureSections stays a *curated* list (not auto-derived
  from every bold header), so it won't over-flag internal/observability sections.
- ensure-blocks: fire only when the marker is absent → idempotent (tested
  pattern, same as Secret Drop / Commitments). No double-insert.
- Slice-bound (from the Secret Drop fix) keeps each new section precise; verified
  on codey live — migrating both added exactly 2 sections to AGENTS.md with no
  neighbor duplication (Private Viewing count stayed 1).

## Level-of-abstraction / signal-vs-authority / interactions

- Guard lives in the existing parity test alongside the template↔migrateClaudeMd
  parity it already enforced — natural home, same intent extended to shadows.
- No runtime/gate logic. Publishing/Attention Queue server features unchanged
  (awareness-delivery only).
- Sequencing unchanged (migrateClaudeMd before shadow mirror).

## Rollback cost

Low. Revert the guard `it()` block, the two featureSections entries, the two
markers, and the two ensure-blocks. No schema/state. Idempotent migration.

## Evidence

- 70 affected unit tests green (guard + parity + ensure-section + shadow no-dup).
- Live on codey: migration mirrored Publishing + Attention Queue into AGENTS.md
  (2 sections, no dup). The behavioral mechanism is the same one proven live for
  Secret Drop (codey now uses the one-time link) and Commitments (codey now
  registers CMT-014 via POST /commitments) — this change extends that proven
  recipe and adds the guard that prevents the class from recurring.
