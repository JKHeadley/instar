# The one-time local dashboard link

<!-- bump: patch -->

## What Changed

A new command, `instar dashboard open`, opens this agent's dashboard on its own computer through a link that works once and for 15 minutes. The person still types their PIN. A browser that came in through the link is judged on its own allowance of PIN tries, so other user accounts and restricted helpers on the same computer can no longer use up the tries and lock out the person sitting at it. A browser that has unlocked before keeps exactly today's treatment, and if the link's allowance runs out, unlock falls back to today's rules.

Only the agent's own user account can make a link: the command and the server prove themselves to each other with a private key in `.instar/local-access/`, which is never synced, backed up or served. The link uses the exact address `127.0.0.1`, a restart cancels every unused link, and the secret never appears in a process list. Over SSH, `--print --port <forwarded port>` prints the link instead.

Because the `instar` command is not on the PATH on a standard install, the server writes a launcher at `.instar/bin/dashboard-open` at every start. Agents are told to run it themselves when a person at the computer cannot unlock.

It is live on development agents and off for everyone else until it graduates (`security.localAccessLink.enabled`).

## What to Tell Your User

- **A way back in at the computer**: "If you're at my computer and the dashboard says too many wrong PINs, tell me and I'll open it on the screen for you with a one-time link. You still type your PIN, but other programs on the computer can't use up your tries."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One-time local dashboard link | Run `.instar/bin/dashboard-open` (or `instar dashboard open` inside the agent folder) on the agent's computer |
| SSH | `dashboard-open --print --port <forwarded port>`, with `ssh -L 127.0.0.1:<port>:127.0.0.1:<agent port>` |

## Evidence

- Unit: `tests/unit/local-access-store.test.ts` (16), `tests/unit/local-access-routes.test.ts` (12).
- Integration: `tests/integration/local-access-link.test.ts` (mint refusals, response proof, one key per ticket, verified unlock while the loopback budget is exhausted, fallback at a full budget, print-mode ports, restart revocation, switch off).
- E2E: `tests/e2e/local-access-link-alive.test.ts` (the CLI's own mint against a real server, then exchange and unlock; dark on a fleet agent).
- Throwaway agent with a real browser: see the PR.
