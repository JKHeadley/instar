<!-- bump: patch -->
## What Changed

On macOS, a server started in the background (a LaunchAgent, or anything that outlives its ssh or terminal session) needs the Local Network privacy permission for its own node program file before it can reach home-network addresses. macOS cannot show that prompt to a background program, so an unapproved node gets EHOSTUNREACH on every LAN peer call, which reads as a dead peer. A new process-wide listener on undici's `undici:client:connectError` channel (`src/core/MacLocalNetworkAccess.ts`, wired once in `startServer`, no-op off macOS) confirms such a failure with Apple's `/usr/bin/curl`. If curl connects where node was refused, it raises the `MacLocalNetwork` degradation, which names the node path and the System Settings fix. It re-reports every 25 minutes while the problem persists, and a later home-network connect clears it. Signal only: no routing, retry or refusal changes. Awareness entry: `mac-local-network-access`.

## What to Tell Your User

If one of your Macs quietly loses touch with your other machines over your home network, I will now tell you why and how to fix it. Usually that means turning on "node" under System Settings, Privacy & Security, Local Network on that Mac. Before this, it just looked like the other machine was off.

## Summary of New Capabilities

- A Mac agent server names a macOS Local Network permission refusal instead of reporting the peer as unreachable, with the exact fix.

## Evidence

Unit tests: host classification, denied vs truly-unreachable, ignored platforms, errors and hosts, check and report cadence, clearing, reporter throw, and real `/usr/bin/curl` against a listening and a closed port. Live on the M5 under a LaunchAgent: the never-approved production node got EHOSTUNREACH to the Studio's LAN address, and the detector reported it with the node path. The approved node copy, also under launchd, got 200 on LAN and Tailscale, with no report.
