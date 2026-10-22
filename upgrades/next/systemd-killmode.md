## What Changed

- **On Linux, restarting the agent's service no longer kills every session.** The service file had no setting for what to stop on a restart, so systemd stopped everything the service had started, including tmux, which holds every conversation and autonomous run. One `systemctl --user restart` wiped them all out (seen on a Windows/WSL machine on 2026-10-22, where a live autonomous run had to be revived by hand). The service file now says `KillMode=process`: only the agent's main program is stopped, and tmux and its sessions keep running. This matches how macOS already behaves.
- **Existing Linux installs are fixed on update.** The updater adds the line to the agent's service file (keeping a dated backup), leaves any setting the operator chose alone, and reloads systemd so the very next restart is already safe. It restarts nothing.
- **`instar server restart` still restarts the server.** Because the service restart now leaves the server running, that command stops the server's own tmux session as part of the restart (Linux and macOS), so new server code loads. Agent sessions are not touched.

## What to Tell Your User

If your agent runs on Linux, restarting its background service no longer ends the conversations and long jobs it is in the middle of. Nothing for you to do.

## Evidence

- `tests/unit/systemd-killmode.test.ts` (7 tests): new units carry the line inside `[Service]`; the migration inserts it right after `[Service]` with the rest of the file byte-identical, is idempotent, leaves an operator-chosen `KillMode` and non-service files alone, and handles CRLF files.
- Incident: Mama PC, 2026-10-22, topic 127504's autonomous run killed by a `systemctl --user restart`; the remote-hands journal shows the tmux server inside the service cgroup and each pane in its own `tmux-spawn-*.scope`.
- Side-effect review: `upgrades/side-effects/systemd-killmode.md`.

## Summary of New Capabilities

- No new capability. Agent sessions on Linux now survive a restart of the agent's service.
