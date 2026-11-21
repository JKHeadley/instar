# Open the dashboard without the PIN from Windows, when your agent runs in WSL

<!-- bump: patch -->

## What Changed

The one-time local link now works when your agent runs inside WSL and your browser is on Windows. Run `instar dashboard open` in your WSL terminal and it prints a private link that works once. Open it in your Windows browser.

It works whether Windows reaches WSL through WSL's own forwarding or through a Windows port forward. The one-time secret in the link is what lets you in.

## What to Tell Your User

- **Dashboard from Windows**: "If your agent runs in WSL, I can give you a one-time link to open the dashboard in your Windows browser without the PIN. It works once and expires in 15 minutes."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One-time local link from Windows to a WSL agent | `instar dashboard open` inside WSL; `--port` for a different Windows port |

## Evidence

- Unit: `tests/unit/identity-piece1g-wsl-local-link.test.ts`. Live socket check on a Windows + WSL machine.
