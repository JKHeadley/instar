# ELI16 — Unbreak main: track #1178's action-claim section + hook in the two ratchet allowlists

## The one-sentence version

PR #1178 (the action-claim follow-through sentinel) added a CLAUDE.md awareness section and a migrator-installed hook, but forgot to register them in the two "did you keep parity?" ratchet tests — so those tests went red the moment #1178 merged, and a red `main` blocks EVERY other PR from merging (they all inherit the failure via update-branch). This change adds the two missing allowlist entries, which is exactly the acceptance step #1178 skipped, and turns `main` green again.

## What's going on

Instar has two CI ratchets that enforce its constitutional standards:
- **feature-delivery-completeness** — every CLAUDE.md section the migrator adds for existing agents must be *tracked* (either a template-shadowed feature section, or an explicitly-listed migrator-only "awareness" section). This catches a feature that updates existing agents but silently forgets new ones.
- **migration-parity-hooks** — every hook the migrator installs must either ALSO be installed on fresh init, or be listed in `INSTALL_VS_MIGRATE_KNOWN_GAPS` with a written rationale. This catches a hook that reaches updated agents but not freshly-initialized ones.

#1178 added the section "Action-Claim Follow-Through Sentinel" (via PostUpdateMigrator) and the hook `action-claim-followthrough.js` (migrator-installed, dark by default), but did not add them to either allowlist. Both ratchets correctly fired. Because `main` re-runs these on every commit and every PR rebases onto `main`, the whole repo's CI went red.

## What's new

#1178 actually broke FOUR gates, not two. This fixes all four fix-forward:

1. `'Action-Claim Follow-Through Sentinel'` → `legacyMigratorSections` (it is a dark, signal-only awareness section added by the migrator, exactly like the cartographer / "Honest progress messaging" sections already listed there).
2. `'action-claim-followthrough.js'` → `INSTALL_VS_MIGRATE_KNOWN_GAPS` with a rationale (it is dark-by-default and in dev-first soak before fleet rollout, so migrator-only-for-now is intentional — matching `free-text-guard.sh` / `skill-usage-telemetry.sh`, which are already accepted as migrator-only).
3. `{ prefix: 'action-claim', ... }` → `INTERNAL_PREFIXES` (`src/server/CapabilityIndex.ts`). The `capabilities-discoverability` lint found `/action-claim` registered in `routes.ts` but unclassified. The route is the Stop-hook's internal ingest for a dark sentinel — agent-invisible by design — so the lint's option (b), suppress-from-discovery, is the correct call (it would never be a `/capabilities` entry).
4. `getActionClaimFollowthroughHook` (`src/core/PostUpdateMigrator.ts`) rewritten to load `fs`/`path` via `await import('node:...')` inside the async handler instead of a top-level `const _r = require` alias. The `no-bare-require-in-generated-hooks` gate bans that alias because it crashes with "require is not defined in ES module scope" in an ESM-host agent — the exact 2026-05-27 silent-stall regression. The rewrite preserves the hook's behavior exactly (signal-only, always `exit(0)`, dark unless `messaging.actionClaim.enabled`).

## Why allowlist rather than add fresh-init parity

Action-claim ships dark (`messaging.actionClaim.enabled`, off) and is explicitly in a dev-first soak before fleet rollout. The migrator-only posture is the author's intentional rollout choice; the codebase already accepts migrator-only dark hooks with a documented rationale. The allowlist entry carries a "Follow-up: add to installHooks() at fleet rollout" note so the parity is restored when the feature actually goes fleet-wide — it is not silenced, just deferred-with-a-tracker, which is precisely what these allowlists are for.

## What you'd decide

This is a green-the-build hotfix that completes the four acceptance steps another PR forgot. It adds two CI-allowlist entries (test files) and two small, no-behavior-change runtime fixes (an internal route-prefix classification + an ESM-safe import rewrite of a dark hook), all grounded in existing precedent. All four previously-red tests pass locally (261/261) and `tsc` is clean. The trade-off is fix-forward vs revert #1178: revert was considered but rejected — #1178 is a substantial dark feature whose surfaces are individually fixable with the codebase's blessed patterns, so registering them correctly (and preserving the author's work) is lower-risk than reverting a large feature across hot files (PostUpdateMigrator). The migrator-only posture for the section/hook matches how the codebase already treats dark migrator hooks.
