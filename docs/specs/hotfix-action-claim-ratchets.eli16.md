# ELI16 — Unbreak main: track #1178's action-claim section + hook in the two ratchet allowlists

## The one-sentence version

PR #1178 (the action-claim follow-through sentinel) added a CLAUDE.md awareness section and a migrator-installed hook, but forgot to register them in the two "did you keep parity?" ratchet tests — so those tests went red the moment #1178 merged, and a red `main` blocks EVERY other PR from merging (they all inherit the failure via update-branch). This change adds the two missing allowlist entries, which is exactly the acceptance step #1178 skipped, and turns `main` green again.

## What's going on

Instar has two CI ratchets that enforce its constitutional standards:
- **feature-delivery-completeness** — every CLAUDE.md section the migrator adds for existing agents must be *tracked* (either a template-shadowed feature section, or an explicitly-listed migrator-only "awareness" section). This catches a feature that updates existing agents but silently forgets new ones.
- **migration-parity-hooks** — every hook the migrator installs must either ALSO be installed on fresh init, or be listed in `INSTALL_VS_MIGRATE_KNOWN_GAPS` with a written rationale. This catches a hook that reaches updated agents but not freshly-initialized ones.

#1178 added the section "Action-Claim Follow-Through Sentinel" (via PostUpdateMigrator) and the hook `action-claim-followthrough.js` (migrator-installed, dark by default), but did not add them to either allowlist. Both ratchets correctly fired. Because `main` re-runs these on every commit and every PR rebases onto `main`, the whole repo's CI went red.

## What's new

Two allowlist additions — the standard, already-blessed acceptance pattern:
1. `'Action-Claim Follow-Through Sentinel'` → `legacyMigratorSections` (it is a dark, signal-only awareness section added by the migrator, exactly like the cartographer / "Honest progress messaging" sections already listed there).
2. `'action-claim-followthrough.js'` → `INSTALL_VS_MIGRATE_KNOWN_GAPS` with a rationale (it is dark-by-default and in dev-first soak before fleet rollout, so migrator-only-for-now is intentional — matching `free-text-guard.sh` / `skill-usage-telemetry.sh`, which are already accepted as migrator-only).

## Why allowlist rather than add fresh-init parity

Action-claim ships dark (`messaging.actionClaim.enabled`, off) and is explicitly in a dev-first soak before fleet rollout. The migrator-only posture is the author's intentional rollout choice; the codebase already accepts migrator-only dark hooks with a documented rationale. The allowlist entry carries a "Follow-up: add to installHooks() at fleet rollout" note so the parity is restored when the feature actually goes fleet-wide — it is not silenced, just deferred-with-a-tracker, which is precisely what these allowlists are for.

## What you'd decide

This is a green-the-build hotfix that completes the acceptance step another PR forgot. It changes only two test files (no runtime code), is grounded in the existing precedent in both allowlists, and the two ratchet tests pass locally (106/106). The trade-off is whether action-claim's hook should be migrator-only-for-now (this change) or installed on fresh init immediately; given the dark/dev-first posture, migrator-only-with-a-tracked-follow-up matches how the codebase already treats dark migrator hooks.
