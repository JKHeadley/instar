# A new agent's first phone pairs at home, with no account

<!-- bump: patch -->

## What Changed

An agent with no Cloudflare tunnel, no Tailscale name and no Telegram (every agent the Windows app makes today) could not pair a phone: pairing answered `409 stable-address-required`. Now the owner can add a first phone at home, on the same Wi-Fi, at the agent's own computer. The computer asks for the dashboard PIN, opens a small second HTTPS listener with the agent's own certificate, and shows a version-2 pairing link (a QR code in the apps) carrying that certificate's public-key hash. The phone pins the hash before it speaks, redeems, and shows a six-digit number the agent issued; the owner types it at the computer, and the phone signs its own activation. The phone is then an owner phone for conversations that cannot approve yet. The listener is closed until asked, opens only on a network the owner allowed, closes itself when nothing uses it, and serves no dashboard, PIN, token or computer-bound route. Nothing arriving on it is ever treated as local. New terminal command: `instar mobile add-phone`.

The home-network port defaults to the main port + 20000 (4040 -> 24040): the first default, main + 1000 (5040), is held by Windows' own Connected Devices Platform service on every Windows 10/11 PC. A caller may ask for an exact port (`port` in `POST /mobile/phone-setup`, `--port` in the terminal); it is never swapped for another and never moves while a phone is paired on the home address (`409 port-fixed`).

The Instar app on the agent's own computer (identity A5) may start the setup with a one-time credential instead of the PIN, which an app-made agent's owner was never told: `instar mobile ceremony-credential`, run as the agent's own user inside its own system, writes the credential's hash to a 0600 file and prints it once. It is accepted only on the main listener from this computer (the exact loopback Host, no forwarding header), only where the app the installer enrolled on this machine exists, only for an agent with no owner phone and no Telegram owner, on the lease holder, once, within ten minutes. Any refusal is final: it never falls back to the PIN.

Inside WSL the home address reads WSL's networking mode (`wslinfo`, else the Windows user's `.wslconfig` and WSL 2's NAT default) instead of guessing it from the address range. NAT opens on WSL's own NAT address; mirrored stays closed (`409 wsl-networking-mode`) unless the Windows app says it enforces the network rule (`windowsAppHandlesNetworkRule: true`), and then binds loopback with the per-address limit on; unknown or other modes stay closed. Owner actions on the home address (open, allow, close) now run one at a time, the ceremony credential's file is checked through the one handle it is read from, and the two fields that mark a phone let in at the computer are kept in agreement by the device store. Anything arriving on the home address other than the pairing redeem and ping needs a verified device signature even on an agent with no token, a home or at-computer phone is never a document device, and approval notices are not pushed to a phone let in at the computer.

## What to Tell Your User

- **Your first phone, at home**: "If you don't have Tailscale or Telegram set up, you can still add your phone: at your agent's computer choose Add your phone, then At home only. It asks for your PIN, shows a code to scan, and then a number from your phone to type in. That phone works on your home Wi-Fi."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| First phone over the same network | At the agent's computer: the app's Add your phone, or `instar mobile add-phone` |
| Home address status | `GET /mobile/same-network` from the agent's own computer (`preferredPort` is the port the next open uses) |
| The app adds the first phone without the PIN | The Instar app runs `instar mobile ceremony-credential` inside the agent's system and passes it as `ceremonyCredential` |

## Evidence

Unit, integration (real TLS listener, stand-in phone that pins the hash) and end-to-end tests through `AgentServer.start()`; two independent review rounds (convergence report in docs/specs/reports). Live: a test agent made by the Windows test app on the Windows 11 test VM, from this branch's build, paired a stand-in phone over the VM's network (winapp-work/a4/live.txt).
