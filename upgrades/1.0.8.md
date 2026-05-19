# Upgrade Guide — v1.0.8

<!-- bump: patch -->

## What Changed

Restores Migration Parity §4 conformance for canonical (built-in) hooks. The Hook primitive shipped in PR #253 with a stamp-and-refuse-on-conflict pattern that resurrected the install-if-missing wedge §4 was written to prevent. This release inverts the policy so that built-in hooks are once again always overwritten on every migration run.

Three small code changes:

- The ParityRule interface gained an optional alwaysOverwrite field.
- hookParityRule sets alwaysOverwrite to true.
- FrameworkParitySentinel honors alwaysOverwrite and emits a new parity:user-edit-overwritten audit event when overwriting a user-edited rendering.

The user-edit detection stays as a signal in verify output; only the blocking authority moves from the rule to the higher-context Migration Parity policy. skillParityRule does NOT opt in because Migration Parity §5 explicitly carves out skills as refuse-on-conflict with PostUpdateMigrator override.

## Evidence

Reproduction prior to this release: render a canonical hook to .claude/hooks/session-start/inject.sh, append a user edit (e.g. echo "user added"), then run the parity scan. The verify pass reports user-edit-conflict, and the sentinel skips remediation. On the next instar update where the canonical hook source changes (the typical fix-broken-template scenario), the agent stays stuck on the user-edited stale rendering.

Observed after this release: same setup, same parity scan, the sentinel now calls remediate, the rendering is overwritten with the new canonical body, and the operator sees parity:user-edit-overwritten in the audit stream. Recovery of the user edit is available via git history if needed.

Unit-test verification: tests/unit/providers/parity/hookParityRule.test.ts now asserts remediate ALWAYS OVERWRITES user-edits per Migration Parity §4. tests/unit/monitoring/FrameworkParitySentinel.test.ts asserts the new audit event fires for alwaysOverwrite rules.

## What to Tell Your User

- "When Instar ships a built-in hook, the canonical version always wins on the next update. A subtle regression in the Hook primitive was making us refuse to overwrite hooks that anyone had edited locally — which is exactly the pattern that left us stuck on a broken template once before. This release puts the always-overwrite policy back in place, and adds an audit signal so any clobbered edit is visible and recoverable from git."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| ParityRule alwaysOverwrite field | Set alwaysOverwrite to true on rules covered by Migration Parity §4. Defaults to false (refuse-on-conflict for §5 rules like skills). |
| parity:user-edit-overwritten audit event | Sentinel emits this whenever an alwaysOverwrite rule clobbers a user-edited rendering. Listen via FrameworkParitySentinel events. |
| Canonical hook always-overwrite restored | No action required; built-in hooks are now once again always overwritten on every migration cycle. Custom hooks in .claude/hooks/custom/ continue to be untouched. |

## Deferred (Tracked Follow-ups)

- Wire parity:user-edit-overwritten into a Dashboard view so operators see clobber events without grepping logs.
- Audit the remaining merged primitive PRs (#254 Agent/Tool/Memory and #255 Sentinel ship-order) using the lessons-aware reviewer; corrective amendments per finding.
