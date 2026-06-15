# Unbreak main — track #1178's action-claim section + hook in the parity ratchets

<!-- internal-only -->

## What Changed

PR #1178 (action-claim follow-through sentinel) added a CLAUDE.md migrator section and a migrator-installed hook without registering them in the two parity ratchets (`feature-delivery-completeness`, `migration-parity-hooks`), turning `main` red and blocking every open PR via update-branch. This adds the two missing allowlist entries — the standard acceptance step #1178 skipped: the section to `legacyMigratorSections` (dark, signal-only migrator awareness) and the hook to `INSTALL_VS_MIGRATE_KNOWN_GAPS` (dark/dev-first, migrator-only-for-now with a fleet-rollout follow-up). Test-only; no runtime change.

## Evidence

Both ratchet tests pass with the additions: `feature-delivery-completeness.test.ts` (101 tests) + `migration-parity-hooks.test.ts` (5 tests) = 106/106. The additions mirror existing accepted entries (`/secrets/sync-status`, `Token-Burn Alerts` for the section list; `free-text-guard.sh`, `skill-usage-telemetry.sh` for the hook gaps). No other test references these allowlists.
