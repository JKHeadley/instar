# Side-effects review — hookParityRule alwaysOverwrite amendment

Per L6 (Side-effects review gate). Seven dimensions.

## 1. Over-block / under-block

**Under-block risk before this change.** The hookParityRule.remediate() refused on user-edit-conflict for canonical built-in hooks. This UNDER-blocked the broken-template-stuck-forever scenario: agents whose canonical hook was buggy and got edited (even accidentally — adding a trailing newline counts as a body diff) would be locked into the broken version. Migration Parity §4 exists exactly because this happened with `hook-event-reporter.js`.

**Over-block risk after this change.** Now built-in hook user edits get clobbered on next remediation cycle. A user who intentionally customized a built-in hook in `.claude/hooks/` (not `custom/`) loses their changes. Mitigation: the sentinel emits `parity:user-edit-overwritten` for every clobber so the operator has an audit trail; the edit itself is recoverable from git history; the documented pattern for user customization is `.claude/hooks/custom/` (always-untouched per Migration Parity §4).

The over-block trade is correct per §4: the broken-template scenario is silent and unrecoverable; the user-edit-clobber scenario is logged, audit-traced, and git-recoverable. Asymmetric reversibility favors §4.

## 2. Level-of-abstraction fit

The fix lives at three levels:
- **Interface** (`src/providers/parity/types.ts`) — `alwaysOverwrite` field added to `ParityRule`. Right level: each rule declares its policy.
- **Rule** (`src/providers/parity/rules/hookParityRule.ts`) — sets `alwaysOverwrite: true` and removes the throw. Right level: hook-specific policy.
- **Sentinel** (`src/monitoring/FrameworkParitySentinel.ts`) — honors `alwaysOverwrite` and emits new audit event. Right level: the orchestrator is the place that knows when to call remediate.

The fix does NOT live in `PostUpdateMigrator` because the parity rule + sentinel are the live execution path during normal operation; the migrator is the per-update batch. Right separation.

The fix is NOT in the canonical hook source files (`.instar/hooks/canonical/`) because the policy is per-rule, not per-script.

## 3. Signal vs Authority compliance

Textbook signal-vs-authority alignment (per B11). Before this change: the stamp comparison (brittle, low-context detector) had blocking authority over remediation. That's exactly the inversion B11 warns against. After this change: the stamp comparison emits a signal (user-edit-conflict in verify() output + parity:user-edit-overwritten event from sentinel); Migration Parity §4 (higher-context policy) decides what to do with the signal.

`alwaysOverwrite: true` is the rule's way of saying "the higher policy applies to me — don't let the signal block me." For skills, `alwaysOverwrite` stays false because §5 says signals from skills CAN block (with `PostUpdateMigrator` as the bypass mechanism). Each rule expresses its applicable §-policy.

## 4. Interactions with adjacent systems

**`PostUpdateMigrator`.** Unchanged. The skill always-overwrite carve-out in §5 is unaffected (`skillParityRule.alwaysOverwrite` is undefined → defaults to false → refuse-on-conflict preserved). Hook-specific migrations in `PostUpdateMigrator` continue to work the same way — they still trigger remediation, which now actually completes for user-edited canonical hooks.

**FrameworkParitySentinel orchestration.** The new event `parity:user-edit-overwritten` is additive — existing listeners on `parity:gap-found` and `parity:remediated` keep firing as before. The sentinel's degradation reporter (3-strikes-unresolved) still triggers if remediation keeps failing, which it shouldn't for the alwaysOverwrite case (since now it succeeds).

**`/instar-dev` pre-commit gate.** Unaffected. The gate checks spec frontmatter tags, not parity rule internals.

**Existing canonical hooks.** All currently-installed canonical hooks were rendered before this change, so they have the stamp comment + match the canonical body. They keep matching → verify ok → no remediation needed. The first time the change shows behavior is when a canonical hook is updated AND a user edited the prior rendering. That's the exact scenario §4 targets.

**`SourceTreeGuard` / `SafeFsExecutor`.** The remediation path writes via `fs.writeFile` directly (not through SafeFsExecutor — see hookParityRule.ts:251, 277). That's a separate concern (consistency with other destructive-tool containment); not introduced by this change.

## 5. Rollback cost

Low. Three files changed (1 interface addition, 1 rule field, 1 sentinel field + emit). Revert is `git revert`. No data migration, no per-agent state change. The `alwaysOverwrite` field is optional with a sensible default (false → preserves old behavior).

## 6. Backwards compatibility / drift surface

Backwards-compatible. Any third-party `ParityRule` implementation (none exist currently — all rules are in this repo) that doesn't set `alwaysOverwrite` keeps the old refuse-on-conflict behavior. No interface break.

**Drift surface.** The new event `parity:user-edit-overwritten` is not yet wired to telemetry or the dashboard. v0.2 follow-up could add a Dashboard tab entry. Not blocking: the event is captured in the audit log already (sentinel passes mismatches through).

**Documentation drift.** CLAUDE.md Migration Parity §4 already documents the always-overwrite policy. No docs change needed; the code now matches what was already documented.

## 7. Authorization / Trust posture

No new permissions surfaced. The remediate path was already authorized to write to `.claude/hooks/` and `.agent/openai/hooks/`. The change is "the same authorized path now completes more often"; it's not a new authority claim.

Trust-floor mirroring (the sentinel's `remediationPolicy: 'mirror-trust'`) remains the gate on whether remediation runs at all. The `alwaysOverwrite` field is a per-rule sub-policy that only kicks in when the trust-floor gate has already allowed remediation.

## Outcome

Ship. The fix is minimal, surgical, and reverses an unintentional regression that contradicted documented Instar policy.

No items rise to "block ship for v0.1." One follow-up worth tracking: wire `parity:user-edit-overwritten` into a Dashboard view so operators see clobber events without grepping logs. Not recurrence-risking; tracked as v0.2.
