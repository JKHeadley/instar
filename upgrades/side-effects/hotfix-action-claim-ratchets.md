# Side-Effects Review — Unbreak main: action-claim ratchet allowlist entries

**Version / slug:** `hotfix-action-claim-ratchets`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Tier:** 1 (test-only ratchet-acceptance; no runtime surface)

## Summary of the change

PR #1178 added the CLAUDE.md migrator section "Action-Claim Follow-Through Sentinel" and the migrator-installed hook `action-claim-followthrough.js` without registering them in the two parity ratchets, turning `main` red (`feature-delivery-completeness.test.ts` + `migration-parity-hooks.test.ts`). A red `main` blocks every PR via update-branch — this is the literal blocker for the whole open-PR backlog. This change adds the two missing allowlist entries (the acceptance step #1178 skipped), greening `main`. Two test files, 6 insertions, zero runtime code.

## Decision-point inventory

- `legacyMigratorSections += 'Action-Claim Follow-Through Sentinel'` — accepts the dark/signal-only migrator awareness section as migrator-only (matching the cartographer / "Honest progress messaging" entries).
- `INSTALL_VS_MIGRATE_KNOWN_GAPS += 'action-claim-followthrough.js'` — accepts the dark, dev-first hook as migrator-only-for-now with a "add to installHooks() at fleet rollout" follow-up (matching `free-text-guard.sh` / `skill-usage-telemetry.sh`).

## 1. Over-block
None. The change only ADDS two allowlist entries; it never tightens or rejects anything. It cannot make a passing build fail.

## 2. Under-block
The ratchets' purpose is to catch unparired features. By allowlisting action-claim as migrator-only, new agents will not get the action-claim hook/section until the tracked fleet-rollout follow-up lands. This is bounded + intentional: action-claim is dark by default (`messaging.actionClaim.enabled`, off), so a new agent missing the dark hook is a no-op until the feature is enabled fleet-wide — exactly the established posture for `free-text-guard.sh` / `skill-usage-telemetry.sh`. The follow-up note prevents the parity gap from being forgotten.

## 3. Level-of-abstraction fit
Correct layer. The ratchet allowlists ARE the designed acceptance surface for migrator-only awareness sections + deferred-install hooks; this uses them exactly as the existing entries do. No new mechanism.

## 4. Signal vs authority compliance
N/A — no runtime decision logic. These are CI test allowlists (build-time guards), not runtime gates. The change makes the existing guard's expectation match the intentional state.

## 5. Interactions
The two entries are independent string/record additions adjacent to existing entries; no ordering or shadowing concerns. Verified: both ratchet tests pass (106/106) with the additions; no other test references these allowlists.

## 6. External surfaces
None. Test-only; no API/schema/message/template/runtime change. Invisible to users and other agents. The only external effect is the intended one: `main` CI goes green, unblocking merges.

## 7. Multi-machine posture (Cross-Machine Coherence)
N/A — build-time CI guard, machine-agnostic. No replication / proxy / transfer surface.

## 8. Rollback cost
Trivial: revert the two allowlist additions (the ratchets would go red again, which is the pre-change state). No migration, no runtime state. The proper forward path (not a rollback) is the tracked follow-up: add `action-claim-followthrough.js` to `installHooks()` + shadow the section in the template at fleet rollout, then these allowlist entries can be removed.
