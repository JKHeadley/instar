# Side-effects review — Pin the interactive session lane (B1)

**Change:** `SessionManager.spawnInteractiveSession` now consults the wired
spawn-account resolver (set under `subscriptionPool.pinSessionsToPool`) when the
caller did not pass an explicit `configHome`. The interactive (user-facing) lane
launches under, and is tagged with, the scheduler-picked pool account — mirroring
the headless lane (`spawnSession`). One file: `src/core/SessionManager.ts`.

## Blast radius

- **Scope is gated three ways.** No-op unless (a) `pinSessionsToPool` wired the
  resolver, (b) the framework is `claude-code`, and (c) the caller passed no
  explicit `configHome`. With pooling off the resolver is never set → `pinnedAccount`
  is null → `effectiveConfigHome`/`effectiveAccountId` are undefined → byte-for-byte
  the prior default-login behavior.
- **Explicit configHome still wins.** The account-swap path (SessionRefresh) passes
  a `configHome`; that suppresses the resolver, so a swap target is never overridden.
- **Non-claude lanes untouched.** Codex/Pi interactive sessions are never put on a
  Claude pool home (the `framework === 'claude-code'` guard).

## Interactions considered

- **Onboarding-safe seeding (#1043):** `ensurePinnedHomeInteractiveReady` is now
  invoked for the resolver-pinned home too (not only explicit-configHome), so a
  headless-enrolled pool home is seeded interactive-ready before the launch — the
  2026-06-09 wizard-wedge cannot recur via this new path. Tokens/oauthAccount are
  never read or written by that helper.
- **ProactiveSwapMonitor / autoSwapOnRateLimit:** these key on
  `session.subscriptionAccountId`. B1 makes the interactive session carry that tag,
  so it becomes directly swap-eligible. The monitor's default-login resolution
  remains the safety net for the still-untagged case (pooling off / empty pool).
- **`tmuxSessionExists` early-return:** an already-running session is reused and not
  re-pinned — correct; live sessions are moved by the swap engine, not re-tagged here.
- **Fail-safe:** `ensureInteractiveReady` logs and continues on a missing/unwritable
  home; a launch never crashes on it (verified by the unit case using a fake path).

## Migration / awareness

- No config default, hook, skill, or CLAUDE.md template change → no `PostUpdateMigrator`
  entry required. B1 rides the existing `pinSessionsToPool` flag; the user-facing
  continuity capability is already documented (template "Pre-limit (proactive) swap"
  bullet). Existing agents pick up the behavior on the normal code update.

## Tests

Unit (6), integration (+2 interactive cases in the existing pin suite), e2e (+1 real
tmux case). Full sibling spawn/session/wiring suites green (96 tests). tsc clean.
