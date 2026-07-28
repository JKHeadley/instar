---
review-convergence: complete
approved: true
approved-by: justin (spec docs/specs/recurring-warning-cleanup.md — approved:true, converged 2026-05-30)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — no more false "Telegram configured but token missing" warning

A health check (`readiness-telegram-token`) used a plain string-type guard to
confirm the Telegram bot token is set. After secret-externalization the token in
`config.json` is the `{ secret: true }` placeholder (the real value lives in the
encrypted store), so the guard read it as missing and warned "Telegram configured
but token missing" every coherence cycle (~20×/run) even though the token is fine.

Now a token counts as configured if it's a non-empty string OR the secret
placeholder (reusing the now-exported `isSecretPlaceholder` from `SecretMigrator`).
A genuinely-missing token still fails the check.

## What to Tell Your User

Nothing visible. If you'd noticed the recurring "token missing" line in the logs
despite Telegram working fine, that false alarm is gone.

## Summary of New Capabilities

- `isSecretPlaceholder` is exported from `SecretMigrator` (single source of truth
  for the externalization-placeholder shape).
- `CoherenceMonitor.readiness-telegram-token` treats the placeholder as "present."

## Evidence

- Unit: `tests/unit/secret-migrator.test.ts` (+`isSecretPlaceholder` cases) — pass.
- `tsc --noEmit` clean.
- Spec: `docs/specs/recurring-warning-cleanup.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/recurring-warning-cleanup.md`.
