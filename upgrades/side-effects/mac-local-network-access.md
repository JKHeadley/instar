# Side-Effects Review — macOS Local Network access, detected and named

**Version / slug:** `mac-local-network-access`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `not required (signal only: no gate, no block, no session lifecycle)`

## Summary of the change

On the M5 the production server (started in the background by launchd) logged thousands of `graph-peer-call-network-ehostunreach` peer calls to the Studio, and conversation sync flapped between ready and not ready. Root cause, confirmed on the M5 under a LaunchAgent: macOS Local Network privacy. The permission is held per program file. The server's node (`~/echo-compute/node/bin/node`) had never been approved, while a byte-identical, identically signed node at another path had been. Under launchd the unapproved node got EHOSTUNREACH to the Studio's LAN address (192.168.87.47) at once. The approved copy got 200. Apple's `/usr/bin/curl` got 200 too. The Tailscale address answered every node (200): the brief's "Tailscale is unreachable" reading was wrong. The plain-http Tailscale endpoint is refused by the credential guard on purpose (`cgnat-plaintext-unsupported`, logged as `url-not-allowed`), and the EHOSTUNREACH lines are the LAN endpoint.

New `src/core/MacLocalNetworkAccess.ts`: a process-wide listener on undici's `undici:client:connectError` (every fetch, so no peer caller can be missed). On macOS, when a home-network (RFC 1918 / link-local / ULA / `.local`) connect fails with EHOSTUNREACH, it asks `/usr/bin/curl` whether the same address accepts a TCP connection (`%{time_connect}` > 0). Only "node refused, curl connected" is the verdict `denied`. It is reported through `DegradationReporter` as `MacLocalNetwork`, naming the exact node path and the fix: System Settings, then Privacy & Security, then Local Network, turn on "node", or ask the agent to move to an already-allowed node copy. The report repeats every 25 minutes while the problem persists, so it stays inside /health's 30-minute window, and it ages out once fixed. `undici:client:connected` to a home-network host clears the verdict. It is wired once in `startServer` right after the reporter is configured, and it is a no-op off macOS. Awareness entry: `src/data/awareness/mac-local-network-access.md`.

## Decision-point inventory

None that gates anything. The module changes no routing, retries nothing and refuses nothing. It only adds a degradation report.

## 1. Over-block

Nothing is blocked. False-positive risk: a host that refuses node but accepts curl for another reason. On macOS, EHOSTUNREACH with curl connecting to the same host:port in the same moment is the Local Network privacy signature. The worst case is a mistaken warning that ages out.

## 2. Under-block

Not covered: IPv6 global addresses on the LAN (not gated by this listener's host test), connects made outside undici (raw `net`, child processes), and machines without `/usr/bin/curl` (verdict stays unknown and nothing is said). It also does not fix reach by itself. The fix is the person's toggle or a node switch by whoever owns restarts.

## 3. Level-of-abstraction fit

The connect-error channel is the lowest common point of every fetch in the process. Hooking each peer caller (graph, lease wire, desktop rope) would miss future callers. The degradation reporter is the existing surface for "a feature is running on a fallback", and it already reaches /health, the dashboard and the alert path.

## 4. Signal vs authority compliance

Pure signal (docs/signal-vs-authority.md). No blocking authority, no brittle logic deciding anything.

## 4b. Judgment-point check

No competing-signals decision. "Node refused, curl connected" is a deterministic two-observation fact.

## 5. Interactions

At most one curl check runs at a time, each host:port is checked at most once per 10 minutes, and the map is bounded to 64 entries. The reporter is wrapped so a throw never reaches the network caller. It does not touch `PeerEndpointResolver` health and does not double-count failures, which the callers still record themselves.

## 6. External surfaces

One new degradation feature name (`MacLocalNetwork`) with plain text, and one awareness paragraph. No routes, no config. Each check spawns `/usr/bin/curl` once, bounded as above.

## 7. Multi-machine posture

Machine-local by design: the permission belongs to this Mac's own program file, so each machine reports its own. A pool read of /health already shows each machine's degradations.

## 8. Rollback cost

Revert the commit. There is no state, no config and no migration. The awareness entry disappears on the next update.
