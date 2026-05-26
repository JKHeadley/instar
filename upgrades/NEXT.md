# Upgrade Guide — NEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

**The `/build` stop-hook is now session-scoped — it only nags the session that actually owns the build.** Before, the hook that keeps a build from quitting half-done had no idea *which* of your concurrent sessions started the build, so it fired its "keep working" block into every session — trapping unrelated ones and, worse, spending the owning build's reinforcement budget on each misfire (when that budget hit its cap, the hook stopped protecting the real builder too).

Now `build-state.py` stamps the owning session (its tmux session name, and optionally the Claude session UUID) at build start, and the hook blocks **only** the proven owner. Every other session approve-exits without touching the owner's budget. A build with no owner stamp (legacy state) gets a conservative no-adopt: the hook goes quiet rather than guessing — it never traps a session and never claims ownership.

The hook ships via the always-overwrite path (the inline `getBuildStopHook()` twin in `PostUpdateMigrator`, kept byte-identical to `src/templates/hooks/build-stop-hook.sh` and asserted by a drift test), so every agent gets it on update.

## What to Tell Your User

- **No action needed; this just stops cross-talk between your sessions.** If you run more than one session at once, a build in one of them will no longer pester the others or drain its own "keep going" budget. You won't notice anything unless you run concurrent sessions, in which case it gets quieter.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Session-scoped build stop-hook | Automatic. `build-state.py init` stamps `owner.{tmux,session,stampedAt}`; the hook blocks only the owner. |
| Owner-stamp flags on `build-state.py init` | `--owner-session "$CLAUDE_CODE_SESSION_ID"` (precision; SKILL wiring is a fast-follow), `--owner-tmux` (override seam). Tmux name is auto-resolved by default. |
| Conservative no-adopt for un-stamped builds | Automatic. No owner stamp → hook approves without claiming ownership (never traps, never drains). |
