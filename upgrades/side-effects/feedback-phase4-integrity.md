# Side effects — Phase-4 feedback-migration integrity tooling

## New files (additive only)
- `src/feedback-factory/migration/immutableGuard.ts` — `GuardedFeedbackStore` decorator +
  `isClusterImmutable` / `hasGovernanceNotes` invariants.
- `src/feedback-factory/migration/importIntegrity.ts` — pure import-gate core (checksums,
  fingerprint-uniqueness scan, schema-equivalence, referential integrity, sequence reset,
  `runIntegrityGate`).
- `tests/unit/feedback-factory/immutable-guard.test.ts` (15 tests).
- `tests/unit/feedback-factory/import-integrity.test.ts` (21 tests).

## Runtime impact
- **None at boot / on the live server.** These modules are NOT imported by `server.ts`, any
  route, job, or hook. They are library building blocks the Phase-4 cutover execution will
  call. No new endpoint, no new config key, no migration to `PostUpdateMigrator`.
- No new dependencies (uses `node:crypto` only).

## Behavioral guarantees
- `GuardedFeedbackStore` only ever REFUSES a mutation of an immutable cluster (pre-cutover
  createdAt or non-null governance note) and records a `GuardViolation`; it never alters
  data and passes all reads + non-curated writes straight through to the inner store.
- A failing `onViolation` audit sink can never break the store or surface as a mutation
  (try/caught, annotated `@silent-fallback-ok`).
- Checksums collapse null/undefined/"" so the import gate does not flap on the
  null-vs-empty governance-note distinction (that distinction is asserted separately by
  schema-equivalence).

## Reversibility
- Fully reversible: delete the two `migration/` files + their tests. Nothing else
  references them yet.

## Follow-on wiring (not in this PR)
- Phase-4 cutover executor (G2.4) constructs the `GuardedFeedbackStore` around the real
  Prisma-backed store with the cutover timestamp from config, and runs `runIntegrityGate`
  over the export/import pair as the Phase-2 gate.
