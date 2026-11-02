## What Changed

- Remote Desktop peer calls (the guided setup's per-machine check, the readiness probe, and the remote-desktop session requests from the dashboard front) now try every rope the target machine advertises, in priority order, instead of only the single rope the shared selection picked. A rope the desktop gate refuses is skipped; a rope that cannot be connected to is skipped; any HTTP reply is final, and a request that may already have reached the target is never resent. Total time budgets are unchanged (8 s setup, 3 s probe and session calls).
- Before this, a machine whose preferred admissible rope was dead (for example a Windows machine under WSL advertising its WSL-internal network address) showed as "Can't reach" in setup even when it answered over Tailscale.
- `resolvePeerUrls()` entries carry an optional `ropes` list (every candidate rope in order) for this purpose.

## What to Tell Your User

If Remote Desktop setup said it couldn't reach one of your machines even though that machine was online, it should now find it. Nothing else changes.

## Evidence

- Unit tests: first rope dead → second rope used; HTTP error on first rope → no retry; ambiguous timeout → no retry; every rope dead → unreachable; single-rope peers unchanged; the session stream is relayed to the rope that answered.
- Live symptom (2026-11-02, Studio): Mama PC's tailscale rope answered 200 while its lan (WSL NAT 172.22.x) and stale quick-tunnel ropes answered nothing; setup dialled only the lan rope.

## Summary of New Capabilities

None. This is a bug fix.
