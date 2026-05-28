# Side-effects review — feedback-factory dry-run/compare + ReadOnlyShadowStore

Spec: `docs/specs/feedback-factory-migration.md` (converged v2, approved 2026-05-26).
Increment: the Phase-1/3 dry-run/compare machinery — `ReadOnlyShadowStore` (write-guard),
`parity.ts` (invariant comparator), `dryRunCompare.ts` (runner + `ParitySource` seam).
Purely additive: three new `src/feedback-factory/` files + three new unit test files; zero
edits to existing code.

## What this ships

The mechanism that lets the ported Instar processor run **read-only against Portal's live
canonical DB** and have its decisions compared to Portal's, with Portal remaining the sole
writer through cutover (the one-shared-DB precondition that prevents split-brain). Three
order-independent invariants per spec §2.3:

1. **Fingerprint (per cluster)** — `computeFingerprint(cluster.type, cluster.title)` recomputed
   over Portal's live clusters and diffed against the stored value. Pure, no replay, fully
   order-independent. The highest-signal gate (catches byte-level Python↔JS divergence on real
   production titles). Faithful to the reference's `cmd_backfill_fingerprints` (:256).
2. **Terminal status** — keyed by fingerprint, not raw slug clusterId.
3. **Recurrence/cycling count** — keyed by fingerprint.

`result.divergent === true` is the structural signal that blocks Phase 4 cutover.

## Over-block / under-block

- **ReadOnlyShadowStore**: deliberately over-strict on writes — every one of the 6 mutating
  methods throws. This is the correct direction: the failure we are guarding against
  (corrupting Portal's curated bug history) is catastrophic and irreversible, while a false
  block is a loud, immediate, recoverable error at the seam. No under-block path exists: there
  is no method that silently no-ops a write.
- **Fingerprint comparator**: skips clusters with no stored fingerprint (pre-backfill rows) —
  prevents the false positive of flagging "divergence" against an empty string. It does NOT
  skip any cluster that *has* a fingerprint, so it cannot under-block a real divergence.
- **Outcome comparator (status/recurrence)**: treats a fingerprint present on only one side as
  a divergence (`missing-instar` / `missing-portal`) rather than ignoring it — chosen to
  surface grouping disagreements rather than hide them. This is the conservative (over-surface)
  direction, appropriate for a cutover gate.

## Level-of-abstraction fit

- The comparator is **pure** (no I/O) and lives beside the other pure processor logic in
  `processor/`. The runner owns the I/O (read source + JSONL append) and lives in a new
  `dryrun/` directory — matching the existing separation (pure decision logic vs. composition).
- `ParitySource` is the single read-only seam. The Prisma-over-Postgres adapter is the only
  production implementation and is intentionally NOT built here (credentials-gated — see
  Deferrals). The interface is the contract Dawn confirmed her adapter slots into.
- `ReadOnlyShadowStore` wraps the existing `FeedbackStore` interface rather than inventing a
  new one — it is a faithful decorator, so any present or future `FeedbackStore` consumer can
  be made read-only without changes.

## Signal-vs-authority compliance

This increment is **signal-only**, not authority. It produces a verdict (`divergent`) and a
JSONL audit trail; it takes no action — no cutover, no migration, no messaging, no mutation.
The authority to advance Phase 4 remains with the operator + Dawn's line-by-line review. This
matches the Instar separation: a brittle/automated comparator detects and emits; a
higher-context human/gate decides. The runner cannot itself flip any switch.

## Interactions

- **Portal's canonical DB**: read-only by construction (ShadowStore guard + read-only
  `ParitySource`). The runner only ever reads + appends to a *local* JSONL log. No write path
  to Portal exists in this code.
- **The ported processor (`process.ts` → `processUnprocessed`)**: the runner does NOT call it
  (it would write). The comparator uses only the pure functions. The ShadowStore guard is the
  backstop if a future caller wires `processUnprocessed` against a shadow store by mistake —
  it throws at the first write instead of corrupting data.
- **Existing feedback-factory tests**: unaffected (additive change; full unit dir green —
  128 tests including the 21 new).
- **No config, hook, route, template, or migration surface is touched** — so no Migration
  Parity / Agent Awareness obligation is triggered by *this* increment (those land with the
  receiver/dispatch wiring + observability increments, which DO touch routes/templates).

## Rollback cost

Trivial and isolated. Three new `src/` files + three new test files, no edits elsewhere,
nothing wired into server startup or routes yet. Reverting the commit removes the files with
zero downstream impact — nothing imports them in production paths. No data migration, no
state, no deployed surface.

## Deferrals

- The **Prisma-over-Postgres `ParitySource` adapter** is not built in this increment.
  Reason: it requires Dawn's read-only Postgres credentials + `prisma db pull` against the live
  schema (a genuine external dependency, not avoidable work). The `ParitySource` interface +
  `InMemoryParitySource` make the runner fully buildable and testable now; the live adapter
  slots in behind the interface the moment credentials land. <!-- tracked: topic-12476 -->
- **Auto-derivation of Instar's status/recurrence outcomes (invariants 2 & 3) from a
  point-in-time read** is not built. Reason: a faithful replay needs window-START cluster state,
  which a current-state read cannot supply; the outcomes must come from a snapshot / full-history
  export. The comparator + runner accept those outcome lists as inputs today, so the path is
  complete pending the data source. <!-- tracked: topic-12476 -->
