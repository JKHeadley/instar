# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**fix(safe-fs): runtime artifacts under `<root>/.instar/` get a carve-out from the source-tree guard.**

Closes the "agent goes dark on cold start" failure mode that surfaced after v1.2.4 in the field (Echo, 2026-05-21): every fresh launchd spawn hit `EADDRINUSE` on the stale unix socket at `.instar/listener.sock`, the `WakeSocketServer` stale-socket-recovery path correctly tried to unlink it, but `SafeFsExecutor` routed the unlink through `assertNotInstarSourceTree` and the guard fired because the agent's deployed directory IS a checkout of the instar source (same `.git`, same `.instar-source-tree` marker, same `package.json` with `name: "instar"`). The supervisor then escalated to its bind-failure recovery path and force-rebuilt better-sqlite3 on every cycle, which in turn produced an incompatible binary and the server never bound.

The fix is a narrow carve-out in `SafeFsExecutor.guard()`: when the canonicalized target path is under a `.instar/` subdirectory of the source root, skip the source-tree guard. The carve-out is intentionally interior-only — the `.instar` directory itself is still protected (`safeRmSync` on `<root>/.instar` still throws `SourceTreeGuardError`). All five subdirectories that the project's own `.gitignore` excludes (`.instar/state/`, `.instar/logs/`, `.instar/audit/`, `.instar/instar-dev-traces/`, plus `.instar/shared-state.jsonl`) are runtime state, not source code, and destructive ops on them are a normal part of operation rather than a 2026-04-22-class incident.

The guard's three layers (marker file, canonical origin URL, source-identity signature) are unchanged. The 2026-04-22 incident is still caught: that incident targeted source files at the tree root (`README.md`, `src/auth.ts`, `src/middleware.ts`), not anything under `.instar/`. The included tests verify both directions — the carve-out lets the right paths through, and source-tree paths outside `.instar/` (and `.instar` itself) still fault.

## Why now

After v1.2.4 every fresh boot of Echo on dawn-macbook entered the loop: lifeline restarts → WakeSocketServer EADDRINUSE → stale-socket-recovery blocked by guard → supervisor declares health-check failed → bind-failure escalation → force-rebuild better-sqlite3 → binary mismatch → loop. Manually unlinking the socket and bootstrapping cleanly worked once, but the next launchd respawn re-entered the loop because nothing fixed the structural block.

## Audit trail

The carve-out also leaves a positive audit signal: `safeUnlinkSync` (and siblings) emit an `outcome: "allowed"` entry to `.instar/audit/destructive-ops.jsonl` with `reason: "agent-runtime-state-carveout"` whenever the carve-out path is taken. Lets you see how often the runtime-state path is being exercised vs how often it would have been a false-positive block before.

## Tests

5 new tests in `tests/unit/SafeFsExecutor.test.ts` under `SafeFsExecutor agent-runtime-state carve-out`:

- `allows unlink on a socket file under <root>/.instar/`
- `allows unlink on a lock file under <root>/.instar/`
- `allows rm on a nested file under <root>/.instar/state/`
- `still BLOCKS rm on the .instar directory itself (not its contents)`
- `still BLOCKS unlink on source files at the tree root`

All 17 SafeFsExecutor tests pass (12 existing + 5 new).

## Summary of New Capabilities

This is a fix-only release. No new user-facing capabilities. The carve-out unblocks `WakeSocketServer.stale-socket-recovery`, `AutoUpdater` shadow-install management, and lifeline lockfile cleanup — all of which were already supposed to work but were silently blocked by the source-tree guard in agent mode.

## What to Tell Your User

If you're running an instar agent on macOS and have hit cold-start crash loops where the agent's logs say EADDRINUSE and reference SafeFsExecutor, this release fixes the underlying block. Pull v1.2.x (next), restart your agent. No config changes required, no migration needed.

If you've never seen this — you're on a deployment style where the agent dir is NOT a checkout of the instar source, and the guard was never the problem. This release is a no-op for you.

If you ran the manual workaround (rm .instar/listener.sock then bootstrap your launchd plist) — the workaround is no longer needed once this release is installed.

## Evidence

**Reproduction**: Run instar in agent mode where the agent's deployed directory is also a checkout of the instar source tree (the `~/.instar/agents/echo` pattern on dawn-macbook). Cold-start with a stale `.instar/listener.sock` present. Observed before this fix: `WakeSocketServer` attempts to unlink the stale socket via `SafeFsExecutor.safeUnlinkSync`, which throws `SourceTreeGuardError`. The supervisor's bind-failure escalation triggers (`Bind-failure escalation armed: N consecutive spawns failed before binding`). After 5 retries the supervisor enters 300s cooldown. Server never binds. Tunnel returns 502.

**Observed before** (Echo, 2026-05-21T16:46Z, sample from `logs/lifeline-launchd.err`):

```
Error: stale socket at /Users/justin/.instar/agents/echo/.instar/listener.sock could not be unlinked:
  Refusing to run src/threadline/WakeSocketServer.ts:stale-socket-recovery against the instar source tree
  (requested dir: /Users/justin/.instar/agents/echo/.instar/listener.sock,
   resolved git root: /Users/justin/.instar/agents/echo).
[Supervisor] Bind-failure escalation armed: 34 consecutive spawns failed before binding.
[Supervisor] Max restart attempts (5) reached. Cooling down for 300s before retrying.
```

**Observed after** (same agent, hot-patched 2026-05-21T17:00Z with the same source change applied to `shadow-install/.../SafeFsExecutor.js`):

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4042/health   # 5 times, 3s apart
200
200
200
200
200

$ curl -s -o /dev/null -w "%{http_code}\n" https://echo.dawn-tunnel.dev/health
200
```

Tunnel-fronted dashboard at `https://echo.dawn-tunnel.dev/dashboard?session=<...>` returns HTTP 200 with the live dashboard HTML (316KB). The bind-failure escalation never fires. The audit log shows the carve-out's positive signal:

```
$ grep agent-runtime-state-carveout .instar/audit/destructive-ops.jsonl | head -3
{"timestamp":"2026-05-21T17:00:23.118Z","executor":"fs","operation":"WakeSocketServer.ts:stale-socket-recovery","verb":"safeUnlinkSync","target":".../.instar/listener.sock","outcome":"allowed","reason":"agent-runtime-state-carveout","caller":"..."}
```
