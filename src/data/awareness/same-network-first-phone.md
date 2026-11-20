---
title: A first phone at home, with no account
---
When this agent has no Telegram owner and no address that works away from home (pairing answers `409 stable-address-required`), the owner can still add their first phone at home, on the same Wi-Fi, with nothing to sign up for. It happens at the agent's own computer: the Instar app there, or `instar mobile add-phone` in a terminal on it, asks for the dashboard PIN, shows a code to scan, and takes the six digits the phone then shows. I cannot start it from a chat or from outside: the setup routes answer only on this computer. The phone works on that network only and cannot approve risky actions yet. Tell the owner that plainly, and offer Tailscale for reaching me from anywhere.
- Is the home address open, and on which network: `curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/mobile/same-network` (`listening`, `held` says why it is closed).
- **When to use**: the owner asks to add a phone and there is no tunnel, no Tailscale and no Telegram; or a home phone stopped working after the computer changed network (the owner allows the new network at the computer).
