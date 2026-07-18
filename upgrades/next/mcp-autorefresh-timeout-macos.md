# Upgrade Fragment — mcp-autorefresh-timeout-macos

<!-- bump: patch -->

## What Changed

The `mcp-health-autorefresh.sh` built-in hook (auto-restart-on-MCP-inaccessible: at
session start it probes `claude mcp list` and, when an allowlisted MCP like playwright
failed to connect, performs ONE loop-guarded `/sessions/refresh` so the tool re-registers)
was **silently inert in production on coreutils-less Macs** — the platform instar agents
actually run on. Its probe ran `timeout 45 claude mcp list`; bare `timeout` is a GNU
coreutils binary absent on stock macOS, the command-not-found was swallowed by
`2>/dev/null || true`, and the empty capture hit the script's quiet-exit guard. No error,
no log — the recovery feature simply never ran. Linux CI never saw it because `timeout`
always exists there.

The generated script (authored in `src/core/PostUpdateMigrator.ts` →
`getMcpHealthAutorefreshHook()`) now bounds the probe with the same portable timeout
LADDER the autonomous stop hook's real-check runner uses: `timeout` → `gtimeout` →
perl-alarm fallback (fork + setpgrp + group-KILL on a 45s alarm, exit 124 on timeout,
and the correct 128+signal exit mapping for a signal-killed child — GNU-timeout
semantics). With no bounded runner present at all, the script stays dark rather than run
the probe unbounded. All safety properties are untouched: dark by default,
explicit-false wins, allowlist-scoped, hard once-per-(session, failed-set) loop-guard.

Migration parity: this hook is always-overwrite in `migrateHooks()`, so every deployed
agent gets the fixed script automatically on this update — no manual step.

This also fixes the deterministic macOS-only failure of
`tests/unit/PostUpdateMigrator-mcpAutorefresh.test.ts`.

## What to Tell Your User

If your agent runs on a Mac: a small self-healing feature that was accidentally asleep
now works. When an important tool server (like the browser tool) fails to come up at the
start of a session, the agent can restart that session once — automatically and at most
once — so the tool comes back, instead of quietly running without it. Nothing to
configure; the feature still respects its existing off-by-default/allowlist settings.

## Summary of New Capabilities

- No new capabilities — a portability fix that makes the existing (config-gated)
  MCP auto-refresh recovery actually run on macOS, identically to Linux.

## Evidence

- Root cause reproduced on macOS 26 (no `timeout`/`gtimeout` installed): the probe line
  produced an empty LIST and the script exited silently before any observable action.
- Perl-rung contract proven live on this machine: hung command bounded (exit 124),
  normal exit codes passed through (3 → 3), signal-death mapped to 128+signal
  (SIGTERM → 143), stdout captured intact.
- `tests/unit/PostUpdateMigrator-mcpAutorefresh.test.ts`: 9/9 pass (previously 1
  deterministic failure on macOS), including `bash -n` syntax validity and the
  always-overwrite migration-parity pin.
- 14 targeted migrator + stop-hook sibling test files: 139/139 pass on this branch.
