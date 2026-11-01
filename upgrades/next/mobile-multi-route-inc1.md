# The iPhone app's phone credential works on this machine's Tailscale name too

## What Changed

A paired phone's signed request used to be accepted only on the one Cloudflare hostname it paired with. With `mobilePairing.multiRoute.enabled` (omitted ⇒ on for a development agent, off on the fleet; read at boot), the server now accepts it on any of this machine's own names: its Cloudflare tunnel hostname and its Tailscale HTTPS name. A name counts only if local configuration names it (the tunnel hostname; `tailscale status` + `tailscale serve` showing HTTPS 443 → this agent's port, through `tailscale.exe` under WSL) and the pairing ping proved this process answers on it with the Host echoed, through this machine's own TLS front, with no other machine claiming it. A request is accepted only on a name still configured here and only when it arrived through that local front, so a failed outbound check never locks a phone out, and a request captured on one name cannot be replayed on another. Names are saved in `.instar/state/mobile-own-names.json`; existing phones are kept working by seeding the paired tunnel host on first boot. Probes are braked (one in flight, 3 s, 60 s healthy, backoff to 15 min, pause after 8 failures with one `MobileRoutes.probe` degradation). At boot the agent sets up `tailscale serve` (HTTPS 443 → its port) only when 443 has nothing configured, and reports a different setup without changing it. New device route `GET /mobile/routes` lists the routes for the app; Bearer `/health` shows them under `mobileRoutes`.

## What to Tell Your User

Your iPhone app can now reach me through Tailscale as well as through Cloudflare, with the same pairing. Nothing to set up: I configure my Tailscale address myself. The app update that switches routes automatically comes next; this release makes the server side ready.

## Summary of New Capabilities

- A paired phone is accepted on this machine's Tailscale HTTPS name and its Cloudflare name, never on another machine's name.
- `GET /mobile/routes` (device-signed) lists this machine's routes, Tailscale first.
- Bearer `/health` → `mobileRoutes` shows own names, their probe health, candidates that never passed with the reason, and the `tailscale serve` state.

## Evidence

Unit, integration and end-to-end tests: one device record accepted on both a Tailscale name and the Cloudflare name through the production auth middleware; a foreign host and a request captured on one name and sent on another are refused; a request through the local front is accepted while every outbound probe fails; a request not through a local front is refused; flag off uses the stored paired host exactly as before.
