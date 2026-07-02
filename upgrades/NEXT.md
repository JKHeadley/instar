# Upgrade Guide — NEXT (Sentinel recovery now actually reaches you + worktrees survive sandbox revocation)

<!-- bump: patch -->
<!-- patch = bug fix to existing sentinel delivery paths + opt-in default flip + already-implemented worktree isolation extended to the cross-project CLI path; backward compatible -->

## What Changed

**RateLimitSentinel was silently no-op'ing for non-topic-bound sessions.** When Anthropic's "Server is temporarily limiting requests" throttle fired on a Claude Code session that wasn't bound to a Telegram topic (e.g. the developer's own interactive Claude Code window, gsd-spawned sub-sessions, anything not directly handling a Telegram conversation), the sentinel correctly detected the throttle and scheduled its backoff — but every recovery output silently returned because `telegram.getTopicForSession()` was null. From outside, indistinguishable from "the sentinel was never installed." Confirmed in production 2026-05-24 against echo's interactive window: 7+ minutes of visible throttle, no recovery, no Telegram notice.

The fix routes through a new `recoveryReachability` delivery policy: bound topic → lifeline (system) topic → audit-only fallback to `logs/sentinel-events.jsonl` + `.instar/sentinel-alerts.json`. Silent no-op is no longer possible.

**`sentinelTelegramEscalation` default flipped from `false` to `true`.** Socket-disconnect and active-silence sentinels were detecting correctly but only logging — operators who never explicitly flipped the flag never saw recovery notices. Coalescing + per-session cooldown in `SentinelNotifier` already protects against the topic-spam concern that justified the prior default. Operators with explicit `false` are preserved by the existing migration semantics (only-add-if-missing).

**Worktree clone-isolation extended to `instar worktree create`.** The 2026-05-22 sandbox-revocation cascade (parent `.git/` revoked mid-session → all worktree git ops fail) was already mitigated for the binding-creation path inside `WorktreeManager.createBinding`, but the operator-facing `instar worktree create` CLI in `InstarWorktreeManager.createWorktree` still used `git worktree add`. That left every worktree created via the CLI vulnerable to the same sandbox failure. Now the CLI uses the same clone-when-out-of-agent-home logic, plus `--no-hardlinks` (so deleting the parent's `.git/objects/` can't dangle the worktree's refs).

**New `instar worktree health` command + `inspectWorktreeHealth()` helper.** Classifies every worktree under agent home as `ok` (real `.git/` dir), `broken-pointer` (gitdir target unreachable — sandbox-revoked or deleted), or `dirty-migration-pending` (parent reachable but worktree has uncommitted changes blocking auto-migration).

## What to Tell Your User

Two long-standing recovery features actually start working now. The first one watches for Anthropic's brief "the servers are busy" throttle — it would detect the throttle correctly, run its backoff timer, then try to send you a "heads up, backing off" message — but the message was getting silently dropped if the session wasn't directly handling a Telegram topic. From your side, it looked like nothing was watching. Same shape on the other two recovery sentinels: they detected, they tried to tell you, the "tell you" switch defaulted to off so nothing ever reached you. Both fixed now. Default is to land notices in the lifeline (system) topic, coalesced so a real outage can't spam you. Set `monitoring.sentinelTelegramEscalation: false` in `.instar/config.json` to restore the silent-recovery behavior.

The second piece is a worktree fix. When the macOS sandbox revoked access to the main instar source mid-session, worktrees created via `instar worktree create` lost their git brain (the metadata lived back in the parent path) and every git command failed. Now those worktrees use `git clone --no-hardlinks` and have their own self-contained `.git/` directory entirely in agent home. The parent can be revoked, deleted, anything — the worktree keeps working. `instar worktree health` shows which existing worktrees still have the old pointer style.

## Summary of New Capabilities

- `src/monitoring/recoveryReachability.ts` — new delivery helper. Routes to bound topic → lifeline → audit-only fallback (never silently drops).
- `monitoring.sentinelTelegramEscalation` default flipped to `true` in `src/config/ConfigDefaults.ts`. Existing configs with explicit `false` are preserved by `applyDefaults` semantics.
- `RateLimitSentinel.resumeFn` and `notifyFn` now reach all sessions, not just topic-bound ones. Resume nudge is untagged for non-topic-bound sessions (InputGuard only enforces topic tagging when a binding exists).
- `SentinelNotifier`'s consolidated path writes a structured `recovery-unreachable` audit event when the lifeline is missing or send fails — instead of just a `notify-error` log line.
- `InstarWorktreeManager.createWorktree` uses `git clone --local --no-hardlinks` when the source repo lives outside agent home. `INSTAR_WORKTREE_FORCE_WORKTREE=1` restores the legacy path; `INSTAR_WORKTREE_FORCE_CLONE=1` forces clone unconditionally.
- `WorktreeManager`'s existing clone path now includes `--no-hardlinks` for the same pack-file independence guarantee.
- New `inspectWorktreeHealth()` helper + `instar worktree health [--json]` CLI subcommand.
- New `.instar/sentinel-alerts.json` (rolling-200 cap) surfaces `recovery-unreachable` events for the dashboard alerts panel.
- CLAUDE.md template section "Sentinel Recovery Reachability" (replaces older "Sentinel Notifications (silently-stopped trio)" section with the new defaults).

## Migration Notes

No action required.

- The config default flip lands automatically via `PostUpdateMigrator.migrateConfig()` → `applyDefaults()`. Configs missing the key get `true`; configs with an explicit `false` are preserved.
- The CLAUDE.md section is content-sniffed on a new marker so existing agents pick up the updated section in place.
- Worktree clone path is opt-in by source location: existing worktrees aren't auto-migrated (would clobber uncommitted work); new worktrees use the clone path automatically when the source lives outside agent home. Run `instar worktree health` to see which existing worktrees would benefit from being recreated.

## Evidence

- **Unit** (`tests/unit/recovery-reachability.test.ts`, 7 tests): bound-topic routing, lifeline-fallback prefixing, audit-only-on-both-missing, audit-on-topic-throw, audit-on-both-throw, never-silent contract, `auditReached` metrics hook.
- **Unit** (`tests/unit/InstarWorktreeManager-clone-isolation.test.ts`, 11 tests): `shouldCloneInsteadOfWorktree` decision (4: outside, inside, FORCE_CLONE, FORCE_WORKTREE rollback); `createWorktree` produces a real `.git/` directory; **survives parent `.git/objects/` deletion** — the production failure mode reproduced in CI; OK health entry; broken-pointer + detached-no-git classification; dotfile skip.
- **E2E** (`tests/e2e/sentinel-reachability-lifecycle.test.ts`, 6 tests): non-topic-bound rate-limit lands at lifeline with sentinel-tagged prefix (silent-no-op regression assertion: `auditPath` does NOT exist); same for socket-disconnect + active-silence; audit-only fallback writes to BOTH JSONL audit log AND dashboard alerts; topic-bound delivery still routes to bound topic (no regression); topic-throw falls through to lifeline.
- **Reproduction** of the 2026-05-22 sandbox-revocation failure: `tests/unit/InstarWorktreeManager-clone-isolation.test.ts > survives parent .git/ becoming inaccessible` removes the parent repo's `.git/objects/` after worktree creation and asserts `git log -1` in the worktree still resolves.
- **Existing suites** confirmed green: `RateLimitSentinel.test.ts` (14), `SentinelNotifier.test.ts` (11), `silently-stopped-trio-wiring.test.ts` (4), `InstarWorktreeManager.test.ts` (27), `WorktreeManager.test.ts` (12), `WorktreeManager-clone-default.test.ts` (7), `rate-limit-detection.test.ts` (12).
- tsc clean.
