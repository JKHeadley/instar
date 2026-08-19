<!-- bump: patch -->

## What Changed

**A machine with two Tailscale installs no longer hides its own working Tailscale route.**

Instar detects whether this machine has a Tailscale address so it can advertise that route to its
peers. It did so by asking a Tailscale CLI *binary*, preferring the macOS app bundle.

On a machine carrying TWO Tailscale installs — the app bundle AND a standalone or brew copy — the
two CLIs talk to different daemons over different sockets. If the app-bundle copy is signed out
while the standalone daemon is the one actually up and holding the address, the CLI answers "logged
out" and the machine advertises **no** Tailscale endpoint.

Caught on real hardware (2026-08-19): the operator's laptop was reachable over Tailscale from
another machine at the very moment its own agent reported the rope absent.

The cost is off-LAN. At home the LAN rope covers it; away from home the machine falls back to the
single Cloudflare rope, which is the flaky one behind the lease disconnects.

`detectTailscaleIp` now reads the machine's own interface table first — a non-internal 100.64/10
IPv4 bound to a tunnel device. That is the machine's own network state rather than one app's opinion
of it: if the address is bound, the route exists, whichever daemon put it there.

Deliberately narrow (`utun*` / `tailscale*` / `ts<N>` only), because a carrier-grade-NAT ISP can
hand a 100.64/10 address to a real `en0` and advertising that as a Tailscale rope would be a false
positive. The CLI tier is retained as a fallback for platforms whose tunnel device is named
unconventionally — so this can only ADD a detection, never remove one that already worked.

## Evidence

- `tests/unit/MeshEndpointAdvertiser.test.ts` extended and green — interface-tier detection, the
  CGNAT-on-`en0` false-positive rejection, and CLI-tier fallback.
- Existing CLI-tier tests now pass `ifaces: null` explicitly. Without it they read the real
  interface table of whatever machine runs them, which is non-hermetic and would have masked
  exactly this bug.
- Confirmed live: the Studio reached the laptop over Tailscale while the laptop's own agent
  reported no such route.

## What to Tell Your User

- **If you run instar on more than one machine and any of them has two Tailscale installs, that
  machine was quietly dropping to its least reliable connection when away from home — this fixes it,
  no action needed.** You would have noticed it as machines intermittently looking unreachable to
  each other. Single-machine agents are unaffected.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Tailscale rope detected from the machine's own interface table | Automatic. `detectTailscaleIp` reads a 100.64/10 IPv4 bound to a tunnel device before consulting any CLI. |
| CGNAT false-positive rejection | Automatic. Only tunnel-device names qualify, so a carrier-grade-NAT address on a real ethernet interface is never advertised as a Tailscale rope. |
