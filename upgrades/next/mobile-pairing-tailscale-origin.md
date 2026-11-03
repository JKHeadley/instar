# Phone pairing over Tailscale; pairing links last 30 minutes

<!-- bump: patch -->

## What Changed

`POST /mobile/pairing-codes` no longer requires a running Cloudflare named tunnel when multi-route is on. A machine without one mints a link over its own Tailscale HTTPS name (a proven own name that its local `tailscale status` + `tailscale serve` still name). The Cloudflare tunnel stays preferred while it runs. Each code is bound to the host and kind it was minted for, and redeem accepts only that host. Mint refuses `409 approval-unavailable` on a machine that cannot deliver the confirmation code, and a Tailscale link waits (`409 address-unverified`) while a backup relay may carry traffic. The mint response gains `originKind`. Pairing links and waiting devices now last 30 minutes (were 10 and 15). The CLAUDE.md pairing section is updated, and existing agents receive the rewrite.

## What to Tell Your User

Adding an agent to the Instar iPhone app no longer needs a Cloudflare address: if the agent's machine is on your Tailscale network, the link can use that. If so, I'll tell you the link only opens on a phone with Tailscale switched on. Pairing links and the wait for the confirmation code now last 30 minutes instead of 10 and 15.

## Summary of New Capabilities

Phone pairing works on a machine reachable only over Tailscale, and pairing links last 30 minutes.

## Evidence

On 2026-11-02 a fresh cloud agent with a verified Tailscale own name was refused `409 stable-address-required`, and two links expired before the operator opened them. Integration tests cover Tailscale-only mint+redeem, Cloudflare preference, the down-tunnel fallback, the relay wait at mint and redeem, binding (a Tailscale link survives Cloudflare returning; an altered host is refused), and the standby refusal.
