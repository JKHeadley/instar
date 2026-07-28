# Convergence report — secret-aware Telegram-token readiness

**Spec:** `docs/specs/recurring-warning-cleanup.md`
**Author:** echo
**Date:** 2026-05-29
**Iterations:** 1 (self-review; fast-tracked)

## Fast-track note

One tiny, self-contained, log-only fix done in autonomous mode at Justin's
request ("enter autonomous mode and tackle and fix all of these issues",
topic 15160). Removes a recurring false "token missing" alarm. No new authority,
no behavior change beyond silencing a known-false warning. Constrained
self-review; disclosed here and to Justin. Explicitly NOT multi-machine (per
Justin's directive to coordinate MM work with the other sessions).

## Material questions resolved

1. **Could it hide a genuinely-missing token?** No. It only adds the
   `{secret:true}` placeholder as a "present" case; a missing/empty token still
   fails. Both sides covered in `secret-migrator.test.ts`.
2. **Single source of truth for the placeholder shape?** Yes —
   `isSecretPlaceholder` is now exported from `SecretMigrator` and reused, rather
   than duplicating the `{secret:true}` check in CoherenceMonitor.
3. **Coordination:** the originally-paired second fix (revert-detector
   SourceTreeGuard spam) was found ALREADY FIXED on main by #552
   (`sourceTreeReadOk: true` — a better fix that keeps the detector working).
   Dropped on discovery. Concrete proof of the value of checking `main` before
   shipping concurrent work.
4. **Why are 2 of the 4 logged candidates still excluded?** Both (feedback 429,
   CapabilityMapper HMAC) need root-cause investigation — quietly suppressing
   either log could mask a real problem. Documented as out-of-scope follow-ups.

## Outcome

Converged. Unit tests green; `tsc --noEmit` clean. No migration (pure `src/`).
