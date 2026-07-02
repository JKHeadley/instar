# Side-effects review — sentinel reachability + worktree clone-isolation extension

**Scope**: Close two classes of silent recovery failures and one structural worktree-fragility that fed the 2026-05-22 incident. Reproduced from production 2026-05-24 against echo's interactive Claude Code window (rate-limit) and from May 22 (worktree).

**Files touched**:
- `src/monitoring/recoveryReachability.ts` — NEW. Single delivery policy: bound topic → lifeline → audit-only fallback (writes `logs/sentinel-events.jsonl` + `.instar/sentinel-alerts.json`). Never silent.
- `src/commands/server.ts` — `rateLimitResume` and `rateLimitNotify` now use `deliverReachable` + injection-when-untagged path. Adds `auditUnreachable` helper for the JSONL + dashboard alerts log; wires it into both rate-limit notify and the `sendConsolidated` consolidation path (so lifeline-missing and lifeline-throw on Socket/Silence escalations also surface). `telegramEscalation` derivation flips from `=== true` to `!== false` to honor the new default.
- `src/config/ConfigDefaults.ts` — `monitoring.sentinelTelegramEscalation` default flipped from `false` to `true`. Explicit-false preserved by `applyDefaults` only-add-if-missing semantics.
- `src/monitoring/SentinelNotifier.ts` — DEFAULT_CONFIG matches new default. New `perSessionCooldownMs` (5 min default) suppresses repeat (sentinel, session) escalations within the window; recorded as `escalation-suppressed`. R5 of spec's adversarial review.
- `src/core/InstarWorktreeManager.ts` — `createWorktree` uses `git clone --local --no-hardlinks` when source repo lives outside agent home. New `shouldCloneInsteadOfWorktree()` mirrors `WorktreeManager`'s helper. New `inspectWorktreeHealth()` + `WorktreeHealthEntry` for diagnosis. `INSTAR_WORKTREE_FORCE_WORKTREE=1` rollback / `INSTAR_WORKTREE_FORCE_CLONE=1` force.
- `src/core/WorktreeManager.ts` — adds `--no-hardlinks` to the existing clone path.
- `src/cli.ts` — `instar worktree health` subcommand. Reports OK / BROKEN-POINTER / DIRTY-MIGRATION-PENDING / DETACHED-NO-GIT. `--json` for machine output.
- `src/core/PostUpdateMigrator.ts` — replaces "Sentinel Notifications (silently-stopped trio)" CLAUDE.md section with new "Sentinel Recovery Reachability" content (default-on + lifeline fallback documented). Idempotent via new marker phrase.
- `tests/unit/recovery-reachability.test.ts` — NEW (7). Routing, never-silent contract, throw fallthrough, audit metrics hook.
- `tests/unit/InstarWorktreeManager-clone-isolation.test.ts` — NEW (11). Decision matrix, parent-deletion-survives, health classification.
- `tests/unit/monitoring/SentinelNotifier.test.ts` — +4 cooldown tests; existing "default OFF" test updated to assert against explicit-false.
- `tests/e2e/sentinel-reachability-lifecycle.test.ts` — NEW (6). Tier-3 reachability assertions (lifeline delivery + silent-no-op regression check + audit JSONL + dashboard alerts).
- `docs/specs/SENTINEL-REACHABILITY-SPEC.md` + `.eli16.md` — NEW. 8 adversarial review findings folded into spec §Review log.
- `upgrades/NEXT.md` — release notes.

**Under-block**: Could the lifeline-fallback hide real failures? No — the audit-only fallback ALSO writes when lifeline is missing (R6 covered by the `auditUnreachable` callback in `sendConsolidated` and the rate-limit notify path). Even when no Telegram destination exists at all, the operator sees the event in `logs/sentinel-events.jsonl` and `.instar/sentinel-alerts.json`. The lint that detects silent-no-op is the new T1 regression assertion in the E2E test ("auditPath does NOT exist" on the happy path; "auditPath has the entry" on the audit-only path).

**Over-block**: Could lifeline-fallback create new spam? Three layers protect against this:
1. Coalescing (existing) — multiple events for distinct sessions in the 5-second window merge into one consolidated message.
2. Per-(sentinel, session) cooldown (NEW, R5) — within 5 minutes of an emit for the same (sentinel, session), repeats suppress to log-only.
3. The lifeline-prefix labelling (`[sentinel/session] text`) makes lifeline messages instantly distinguishable from user-topic-bound messages so operators can filter/mute.

The 20-events-in-60s test asserts ≤2 messages emerge for a single session under realistic burst conditions.

**Level-of-abstraction fit**: `recoveryReachability` is a delivery sink, not a gate — it has no blocking authority. The decision to send remains with the sentinel; routing is the only added concern. `SentinelNotifier` already owned consolidation; the new cooldown sits at the same layer (delivery policy). `InstarWorktreeManager` continues to own worktree creation; the new clone branch is internal to it — callers don't see a different API.

**Signal vs authority**: No authority changes. Sentinels still emit signals; the notifier + reachability helper are sinks. The default flip is a configuration change, not an authority change. The new audit-unreachable events are observability, not gating.

**Interactions**:
- With `CompactionSentinel`: untouched. Bidirectional deferral via `setDeferIf` still composes correctly; the zombie-kill veto checker still includes both sentinels.
- With `InputGuard`: unchanged. `injectMessage` already handles non-bound sessions correctly (falls through to `rawInject` when `getTopicBinding` returns null). The new untagged-inject path is simply: don't add the `[telegram:N]` prefix when there's no topic. No new bypass API; R3 of the review became moot.
- With existing `sendConsolidated` consumers: the new `auditUnreachable` call when send returns false adds an audit event but does not change the return value the caller sees (still `false`).
- With existing `monitoring.sentinelTelegramEscalation: false` operators: preserved. `applyDefaults` does not touch explicit values.
- With existing `instar worktree create` users: backwards compatible. The clone path triggers only when source is outside agent home (the typical operator case); existing in-tree fixtures keep using `git worktree add`. `INSTAR_WORKTREE_FORCE_WORKTREE=1` is an immediate operator escape hatch.
- With `git-sync`: a clone-isolated worktree is a normal git repo with `origin` pointing at the source. Pulling/pushing works the same way.
- With dashboard: `.instar/sentinel-alerts.json` is a new file the dashboard's alerts panel can pick up. Existing dashboard code that doesn't know about the file is unaffected. Surfacing it in the UI is a follow-up.

**Rollback cost**: Trivial. Each part is independent:
- A1/A2 (reachability + cooldown) — `git revert` reintroduces the silent-no-op bug.
- A3 (default-on flip) — operators set `sentinelTelegramEscalation: false`, takes effect on server restart.
- B1 (clone isolation) — `INSTAR_WORKTREE_FORCE_WORKTREE=1` is immediate, no restart needed.
- The new test files would need to be removed/updated if reverting A1/A2; otherwise the test suite would fail on the regression assertions.

**Decision-point inventory**:
1. **Lifeline as fallback vs. operator DM**: Lifeline wins because every agent already has one (it's the system topic), it's where existing system notices land (operators are conditioned to look there), and there's no Telegram DM permission story to navigate. The labelled prefix `[sentinel/session]` makes the routing visible without needing a separate channel.
2. **Audit-only as 3rd-rung vs. throw**: Audit wins because the sentinel treats `notifyFn` throws as a delivery error to retry. Throwing would push the recovery into a retry loop against a destination that is provably not coming back. Audit-only is a terminal "we tried" state.
3. **Cooldown above coalescing vs. instead of**: Both, because they protect different shapes. Coalescing handles "lots of distinct events at once" (restart burst). Cooldown handles "same event keeps re-firing for minutes" (real outage). Different windows, different keys, complementary.
4. **`git clone --no-hardlinks` vs. `--no-local`**: `--local --no-hardlinks` is correct. `--local` uses copy semantics for object files within the same filesystem; adding `--no-hardlinks` makes it `cp` instead of `link`. This is what we want — fast (no network) AND independent. `--no-local` would force the slow protocol-based path even on the local filesystem.
5. **Auto-migrate existing worktrees vs. detect-and-suggest**: Detect-and-suggest wins because some existing worktrees may have uncommitted work that auto-migration would risk. The `instar worktree health` command + the audit log entry makes the upgrade path visible without acting on the operator's behalf. R7 also flagged worktree-lock contention with running sessions; opt-in migration sidesteps the race entirely.
6. **CLAUDE.md section replace vs. append**: Replace via regex match of the prior marker phrase. Appending would leave stale guidance saying "default off" that contradicts the new "default on" content. The regex is anchored on the old section header so it can only match the section it owns.

**Evidence summary**:
- 17 unit tests (recovery-reachability 7 + clone-isolation 11 + SentinelNotifier cooldown 4 — counted as +4 added to existing suite).
- 6 E2E reachability tests including the silent-no-op regression assertion.
- Parent-deletion survival reproduces the 2026-05-22 sandbox-revocation failure mode and asserts the fix.
- tsc clean.
- Adjacent worktree suites (InstarWorktreeManager 27 + WorktreeManager 12 + clone-default 7) all green.

**Out of scope**:
- Dashboard surfacing of `.instar/sentinel-alerts.json` (data is written; UI integration is a follow-up).
- Auto-migrating existing worktrees (deferred per R4 + R7; `instar worktree health` exposes them for operator action).
- Heads-up "default-on flip" notice on first upgrade (R2). The fix is the priority; the heads-up is a follow-up if operators report confusion.
- Migrating gsd-spawned sessions to be topic-bound by default.
