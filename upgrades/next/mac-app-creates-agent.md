# The Instar Mac app can create an agent and connect to it with no terminal

<!-- bump: patch -->

## What Changed

The Instar Mac app downloaded from instar.sh can now run the installer itself and become the new agent's first owner device on the same Mac, with no PIN, code, phone, Tailscale or Telegram. The installer, when the app runs it, leaves a one-time ticket in the new agent's own folder that only the Mac's owner can read. The app reads it and asks the agent, over the Mac's internal address, to add the app as its owner device. This works only from the same Mac, only within 30 minutes, and only while the agent has no owner device yet; on any other agent the new route does not exist. A new `instar install --app-ticket --key <key>` gives the app a fresh ticket if it was interrupted.

## What to Tell Your User

- **Set up from the Mac app**: "If you know someone who'd like their own agent, the Instar Mac app can now set one up for them from a single button, with no terminal."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mac app creates an agent | The Instar Mac app from instar.sh: Create my agent |
| Fresh app setup ticket | `instar install --app-ticket --key <app device key>` (the app runs it) |

## Evidence

- Unit: `tests/unit/mobile-local-owner-device.test.ts`, `tests/unit/install-flow.test.ts`.
- Integration: `tests/integration/mac-app-creates-agent.test.ts`.
- E2E: `tests/e2e/mac-app-creates-agent-alive.test.ts`.
