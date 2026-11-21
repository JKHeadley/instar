# A new agent with no SSH server and no Telegram no longer reports false health problems

<!-- bump: patch -->

## What Changed

Two false alarms on a fresh agent (seen on every Windows-app agent, and on any agent without Telegram):

- **"Health: Degraded" from the first minute.** Server-down recovery reads the host's sshd key (`/etc/ssh/ssh_host_ed25519_key.pub`) at every start and reported the degradation `ServerDownRecovery.hostSshKey` whenever it could not, which turns `/health` to `degraded`. When the key file does not exist (no SSH server on this machine), the direct SSH recovery route is now recorded as not applicable: no degradation, and the `multiMachine.serverDownRecovery.enabled` entry in `GET /guards` carries `directSshRoute: "not-applicable"` (or `available` / `unreadable`). A key file that exists but cannot be read is still reported as a degradation, now with the error code in the reason.
- **"Scheduled jobs keep failing".** The `dashboard-link-refresh` job (every 15 minutes) called `POST /telegram/dashboard-refresh`, which answered 503 when Telegram was not configured, so the job failed four times an hour. With no enabled Telegram entry in the agent's messaging config, the route now answers 200 `{"action":"skipped","reason":"telegram-not-configured"}` and the job's existing script exits 0. Telegram that is configured but not running still answers 503, so that real failure keeps reporting. No job definition changes, so existing agents get this with the update and no migration.

## What to Tell Your User

- **No more false health warnings on a new agent**: "If you set me up without Telegram, or on a computer without remote login, I no longer show a 'degraded' health status or 'scheduled jobs keep failing' for features that don't apply to you."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| See whether the SSH recovery route applies on this machine | `GET /guards` → `multiMachine.serverDownRecovery.enabled.directSshRoute` |
| Dashboard link refresh skips cleanly without Telegram | Automatic |

## Evidence

Windows dress rehearsal (builder #43, 2026-11-20, agent "Wintest", no Telegram, no openssh-server): `/health` at 00:14 said `status: degraded` with only `ServerDownRecovery.hostSshKey`; `/jobs` at 00:26 showed `dashboard-link-refresh` failing every run with "HTTP 503 ... Telegram messaging is not configured". New e2e test runs the job's real gate and script (from `getDefaultJobs`) against a listening AgentServer: on main the no-Telegram case exits 1, with the fix it exits 0 and prints "skipped"; the configured-but-not-running case exits 1 on both. Unit and integration tests cover the missing, unreadable and readable key cases and `/health`.
