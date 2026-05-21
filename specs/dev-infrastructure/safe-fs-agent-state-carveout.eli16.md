# SafeFsExecutor Agent-Runtime-State Carve-Out — ELI16

## What's already here

Instar has a safety guard called the **source-tree guard**. It exists because once, in April, a test accidentally deleted 1,893 files from the real instar source code repo. After that, the team built a guard that says: "before you delete anything, make sure the target is NOT the instar source code." Every destructive filesystem operation (delete, unlink, rmdir) runs through this guard via `SafeFsExecutor`.

The guard checks three things to decide if a path is "the instar source":
1. Is there a special marker file `.instar-source-tree`?
2. Does the git remote URL match the canonical instar repo?
3. Does package.json say `"name": "instar"` AND are at least two instar-specific source files present?

If any of those three say yes, the guard refuses to operate.

## What changed

When instar is deployed in **agent mode** — meaning someone's running a full Echo-like agent in `~/.instar/agents/<name>/` — that agent's directory IS a full checkout of the instar source. It has the same `.git`, the same marker file, the same `package.json`. By the guard's logic, the agent dir is the instar source tree. From the guard's perspective, that's correct.

But the agent's runtime artifacts — sockets it binds to, lock files it holds, the auto-update shadow install, log files, audit trail — live at `<agent-dir>/.instar/`. Those paths are gitignored. They are NOT source code. They're working memory.

Before this change: every time the agent tried to delete one of its own stale sockets or lock files on cold start, the guard fired, the agent refused to start, and the supervisor entered a force-rebuild loop trying to "self-heal" something that wasn't actually broken. Echo went dark for hours on 2026-05-21 because of this.

After this change: paths under `<root>/.instar/<something>` bypass the guard. The `.instar` directory itself stays protected. The three guard layers stay exactly as they were for everything else.

## What the reader needs to decide

**Is the carve-out narrow enough?** The carve-out only triggers when the canonical path contains `/.instar/` as an interior segment with at least one character after it. The directory `.instar` itself is excluded. Tests verify both directions.

**Does the under-block create a new attack surface?** No. The 2026-04-22 incident damage was `README.md`, `src/auth.ts`, `src/middleware.ts` — all at the tree root, none under `.instar/`. Any future variant of that incident class still hits the guard. The carve-out specifically allows what the project's own `.gitignore` already says is not source.

**Is there a positive audit signal?** Yes. Every carve-out invocation logs `outcome: "allowed"` with `reason: "agent-runtime-state-carveout"` to `.instar/audit/destructive-ops.jsonl`. Operators can grep this to verify the carve-out fires exactly where expected (WakeSocketServer recovery, AutoUpdater install, lifeline lock cleanup) and nowhere else.

**Is the fix reversible?** Yes. Single-commit revert. The carve-out is one helper function and one branch in `guard()`. No data migration, no state change, no API change.

## Why ship now

Echo's deployed install on dawn-macbook entered an endless cold-start crash loop after v1.2.4. Each launchd respawn:
1. Tries to bind WakeSocketServer to `.instar/listener.sock`
2. Hits `EADDRINUSE` because the previous run left a stale socket
3. Tries to unlink the stale socket via SafeFsExecutor
4. SafeFsExecutor.guard() refuses (this bug)
5. WakeSocketServer emits `error: EADDRINUSE`
6. Supervisor flags "Server unhealthy" and escalates to bind-failure recovery
7. Force-rebuilds better-sqlite3 (the wrong fix for a socket problem)
8. Server still can't bind
9. Loop

Manually unlinking the socket and restarting cleanly worked once — but the next respawn hit step 2 again. The agent could not stay healthy without this fix.
