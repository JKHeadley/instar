# A new agent's first phone pairs at home, with no account

<!-- bump: patch -->

## What Changed

An agent with no Cloudflare tunnel, no Tailscale name and no Telegram (every agent the Windows app makes today) could not pair a phone: pairing answered `409 stable-address-required`. Now the owner can add a first phone at home, on the same Wi-Fi, at the agent's own computer. The computer asks for the dashboard PIN, opens a small second HTTPS listener with the agent's own certificate, and shows a version-2 pairing link (a QR code in the apps) carrying that certificate's public-key hash. The phone pins the hash before it speaks, redeems, and shows a six-digit number the agent issued; the owner types it at the computer, and the phone signs its own activation. The phone is then an owner phone for conversations that cannot approve yet. The listener is closed until asked, opens only on a network the owner allowed, closes itself when nothing uses it, and serves no dashboard, PIN, token or computer-bound route. Nothing arriving on it is ever treated as local. New terminal command: `instar mobile add-phone`.

## What to Tell Your User

- **Your first phone, at home**: "If you don't have Tailscale or Telegram set up, you can still add your phone: at your agent's computer choose Add your phone, then At home only. It asks for your PIN, shows a code to scan, and then a number from your phone to type in. That phone works on your home Wi-Fi."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| First phone over the same network | At the agent's computer: the app's Add your phone, or `instar mobile add-phone` |
| Home address status | `GET /mobile/same-network` from the agent's own computer |

## Evidence

Unit, integration (real TLS listener, stand-in phone that pins the hash) and end-to-end tests through `AgentServer.start()`; two independent review rounds (convergence report in docs/specs/reports). Live: a test agent made by the Windows test app on the Windows 11 test VM, from this branch's build, paired a stand-in phone over the VM's network (winapp-work/a4/live.txt).
