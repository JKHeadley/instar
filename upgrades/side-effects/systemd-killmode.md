# Side-Effects Review — Linux service restart no longer kills tmux sessions

**Version / slug:** `systemd-killmode`
**Date:** `2026-10-22`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see bottom)`

## Summary of the change

The Linux systemd user unit written by `installLinuxSystemdService` (`src/commands/setup.ts`) had no `KillMode`, so systemd used the default `control-group`: on stop or restart it kills every process in the service's cgroup. The tmux server that holds every agent session is started by the lifeline (or the server) and stays in that cgroup, so one `systemctl --user restart instar-<agent>` killed every session, live autonomous runs included (Mama PC, 2026-10-22, topic 127504). The unit now carries `KillMode=process` (only the main process is signalled). `PostUpdateMigrator.migrateSystemdKillMode` inserts the line into existing units (surgical insert after `[Service]`, `.bak-<ts>` copy kept, any operator-set `KillMode` left alone) and runs `systemctl --user daemon-reload` so the running unit's next stop already uses it. Files: `src/commands/setup.ts`, `src/core/PostUpdateMigrator.ts`, `src/commands/server.ts` (restartServer), `tests/unit/systemd-killmode.test.ts`.

## Decision-point inventory

No decision-point surface. This is a service-manager configuration value and an idempotent file migration; nothing gates messages, actions or sessions.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface. Failure modes the change does NOT cover, stated so nobody assumes otherwise:
- If the whole per-user systemd manager stops (as happened on the Mama PC at 01:20 PDT the same day, when login session c1 was removed despite linger), every process under it stops, tmux included. `KillMode` cannot help there. That is reported to the operator as its own item.
- A unit an operator hand-wrote with `KillMode=control-group` keeps that behavior, by design.

## 3. Level-of-abstraction fit

Right layer. The service manager decides what a stop kills; the fix is the one line that tells it. The alternatives considered were heavier: wrapping every `tmux new-session` call site (there are ~14) in `systemd-run --user --scope`, or pre-starting the tmux server in its own scope, which breaks again whenever the tmux server exits and is restarted from inside the service. `KillMode=process` also matches macOS: launchd kills the job's process group, which the daemonized tmux server leaves, so sessions there already survive a restart.

## 4. Signal vs authority compliance

Not applicable: no detector, no gate, no authority added or changed (`docs/signal-vs-authority.md` reviewed).

## 5. Interactions

- **Lifeline mode** (Telegram configured): the lifeline is the main process and starts the server inside tmux. After a restart the server keeps running and the new lifeline's `ServerSupervisor.start()` adopts it after a `/health` check (existing behavior, the same path macOS uses after a launchd restart). So a bare `systemctl --user restart` now restarts the lifeline only, not the server (as `launchctl bootout` already does on macOS). **`instar server restart` is adjusted for this** (`restartServer` in `src/commands/server.ts`): on Linux it now does stop → stop the `<project>-server` tmux session → start, and on macOS it stops that session between bootout and bootstrap, so the command loads new server code on both platforms instead of adopting the old server (the second-pass reviewer's concern). Agent sessions are not touched by it. The lifeline's own supervisor restart paths are unchanged. The lifeline starts no children outside tmux (checked: no `spawn`/`fork` in `src/lifeline/`).
- **Server mode** (no Telegram): the server is the main process and gets SIGTERM; its graceful shutdown stops what it owns (tunnel, subprocesses). If it is SIGKILLed after the stop timeout, non-tmux children it started could outlive it, which is the same exposure macOS has today.
- **tmux pane scopes**: on the Mama PC each pane is already in its own `tmux-spawn-*.scope` (tmux's systemd support); only the tmux server process was in the service cgroup. Unchanged.
- Session reaper, resume queue, watchdogs: untouched; they now simply see fewer sessions vanish.

## 6. External surfaces

Visible to Linux operators only: the unit file gains one line, a `.bak-<timestamp>` copy sits beside it after migration, and `systemctl --user restart` no longer kills sessions. macOS and Windows: no change (migration skips non-linux).

## 7. Multi-machine posture

Machine-local BY DESIGN: the unit file is per machine and each machine's own update runs the migration. No replicated state, no notices, no URLs.

## 8. Rollback cost

Low. Revert the release, or on one machine delete the `KillMode=process` line (or restore the `.bak-<ts>` copy) and `systemctl --user daemon-reload`. No data or state to repair.

---

## Second-pass review


Concern raised (minor, documentation-level; the code change itself is sound): `instar server restart` on Linux (`restartServer` in `src/commands/server.ts`) runs `systemctl --user restart instar-<agent>` and prints "Server restarted via systemd". In lifeline mode that command used to reload the server only because the cgroup kill took the tmux-hosted server down with it. With `KillMode=process` it restarts the lifeline only; the new lifeline's `ServerSupervisor.start()` adopts the still-healthy old server, so new server code does NOT load. This matches macOS (`launchctl bootout` leaves the setsid'd tmux server alive too), so it is not a new class of bug, but §5's "existing restart paths unchanged" misses this CLI path and its now-misleading success message. Name it in §5 (and ideally follow up so `restartServer` also kills the server tmux session, or says "lifeline restarted; server adopted").

Checked: lifeline starts no long-lived non-tmux children (only `execFile` of tmux in `TelegramLifeline.ts`; `RestartOrchestrator` never stops the server); `ServerSupervisor.start()` adopts a server whose tmux session is alive AND answers `/health`, so no duplicate/port clash. Server mode: SIGTERM shutdown is bounded at 20s (under systemd's 90s TimeoutStopSec), stops the tunnel/pipe spawns and releases `SingleInstanceLock`, which also reclaims a dead pid, so a lingering orphan cannot block the next start; detached children (MergeRunner, localVerify seams, caffeinate) now outlive a Linux restart as they already do on macOS. Migration: insert is idempotent, skips any existing `KillMode=` (a commented `#KillMode` correctly does not count), tolerates CRLF (inserted line is LF, which systemd accepts), keeps a `.bak`, and `daemon-reload` restarts nothing and is skipped under VITEST/INSTAR_SKIP_LAUNCHCTL_LOAD. Other unit writers (`installAutoStart` from migrator/machine/server) use the updated template.


Author response (2026-10-22): the concern is addressed in this same change — `restartServer` now stops the server's tmux session as part of the restart on both Linux and macOS (see §5).
