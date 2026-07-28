# Side-Effects Review — secret-aware Telegram-token readiness

**Version / slug:** `recurring-warning-cleanup`
**Date:** `2026-05-29`
**Author:** `echo`
**Spec:** `docs/specs/recurring-warning-cleanup.md` (+ `.eli16.md`)
**Convergence:** `docs/specs/reports/recurring-warning-cleanup-convergence.md` (fast-tracked self-review)
**Second-pass reviewer:** `not required` (see §"Phase 5 trigger check")

## Summary of the change

One self-contained, log-only fix (autonomous-mode work at Justin's request).
NOT multi-machine.

`CoherenceMonitor.readiness-telegram-token` used a `typeof === 'string'` guard
that read the post-externalization `{ secret: true }` token placeholder as
"missing" and false-alarmed 20×/run. Now a token is "configured" if it's a
non-empty string OR the placeholder, reusing the now-exported `isSecretPlaceholder`
from `SecretMigrator`.

(The originally-paired RevertDetector fix was dropped — found already fixed on
main by #552's `sourceTreeReadOk`; see the spec's coordination note.)

## Files touched

- `src/core/SecretMigrator.ts` — export `isSecretPlaceholder` (was module-private; +doc).
- `src/monitoring/CoherenceMonitor.ts` — import + use it in the token readiness check.
- `tests/unit/secret-migrator.test.ts` (+`isSecretPlaceholder` cases).

## Decision-point inventory

- **Token present vs missing** — *modify, widening*. Adds the `{secret:true}`
  placeholder as a "present" case; a genuinely-missing/empty token still fails.
  Both sides tested. Read-only.
- **Export of `isSecretPlaceholder`** — *additive*. Was module-private; now
  exported so the readiness check reuses one definition (no drift). No behavior
  change to existing callers.

## Blast radius

- No new authority, no gate, no API route, no external surface, no destructive op.
- The only delta REMOVES a recurring false warning; no real runtime behavior
  change (a present token now correctly passes; a missing one still fails).
- No agent-installed files changed → no `PostUpdateMigrator` entry. Pure `src/`.
- Not multi-machine.

## Phase 5 trigger check (second-pass reviewer)

Second pass **not required**: no new authority, no destructive op, no external
surface, no migration, not multi-machine. Additive log-noise cleanup with
both-sides unit coverage.

## Verification

- `tests/unit/secret-migrator.test.ts` (17, incl. `isSecretPlaceholder` cases) pass.
- `tsc --noEmit` clean.
