# Side effects: home listener limits sized for a real phone, and a bounded refusal log

In plain words: the agent's home (same-network) listener now lets a phone open as many connections as a real app screen does, gives the Windows pass-through's single address the whole door where every phone arrives through it, and writes a short, bounded note of every refusal so a phone's 403 or connection error can be explained afterwards.

Tier 1 (a revert fully undoes it; no config, no migration, no new authority). Size: 3 source files (`src/server/sameNetworkListener.ts`, new `src/server/sameNetworkRefusals.ts`, `src/server/phoneSetupRoutes.ts` one read route), 1 awareness line, 1 dated note in the A4 spec, 2 new test files, 2 test files extended. Effort: one build pass, one commit attempt planned.

Why now: builder #62 paired a real iPhone app over home Wi-Fi with a Windows-made test agent. Messages never got through. Through the Windows pass-through 8 parallel TLS connections went 6/8, straight to the agent 8/8; the app log showed "refused (limit)" exactly in the phone's failure windows. The pass-through is fixed in the Windows app (24/240/64 per address, same numbers); this change makes the agent's own limits agree.

Also in this change (it blocks it): main's `tests/unit/no-silent-fallbacks.test.ts` fails (495 > baseline 494) since #3603 added a designed probe catch in `src/core/UpdateChecker.ts` `findBundledNpmCli` (`catch { /* not this layout */ }`, line 820). Bisected on a clean main worktree: 494 two commits back, 495 from #3603. That catch now carries the `@silent-fallback-ok` marker with its reason (comment only, no behaviour change); the count is 494 again.

## What changes for running agents
- `SAME_NETWORK_MAX_CONNECTIONS` 32 -> 64; `SAME_NETWORK_PER_ADDRESS_OPEN` 6 -> 24; `SAME_NETWORK_PER_ADDRESS_PER_MIN` 40 -> 240. Applies where the agent listens directly (macOS/Linux on the LAN address) and in WSL mirrored mode. WSL NAT mode is unchanged in shape: no per-address limit here (the pass-through owns it), the total is now 64, equal to the pass-through's total.
- WSL mirrored mode: the bind is loopback and every caller (the pass-through, carrying every phone) arrives as 127.0.0.1, so the old per-address bucket was one shared 6-place bucket for all phones (the spec itself noted "enough for one phone's setup"). That address (and its IPv4-mapped form) now gets `SAME_NETWORK_FORWARDER_OPEN` = 64 open and `SAME_NETWORK_FORWARDER_PER_MIN` = 960 a minute. Decided with the bind from the plan's mode, never from the caller. Any other address in mirrored mode keeps the per-phone limit. A direct (non-WSL) listener never gives loopback this bucket.
- New `SameNetworkRefusalLog`: records (a) a connection refused by a per-address limit (`address-open`, `address-per-minute`) or by the total (`total-open`, Node's `drop` event), (b) a failed TLS handshake (`tls-<code>`; a socket the listener itself closed for a limit is not recorded twice), (c) every request answered with status >= 400, by the gate or any route behind it, with the answer's own `error` code when it is a plain code (else `http-<status>`). Fields: time, kind, method, route (query dropped, id-like segments `:id`, odd characters `:x`, 120 chars max), status, first 8 characters of `X-Instar-Device` when it has an id's shape, caller's real address. Never a header value, body, query, signature, token, setup id or full device id. Bounded: 300 entries, an identical repeat of the newest only bumps its count; written as one JSON file (0600, atomic rename) at most once per 2 s and on stop; unreadable file starts empty; write errors keep entries in memory.
- `GET /mobile/same-network/refusals?limit=N` on the main listener, behind the existing `localOnly` (bearer + from this computer + no forwarding header + pairing on); not on the home listener (the gate only lets device-allowlisted routes through). Newest first, default 100, max 300.
- To read the answer's error code, the listener wraps `res.end` for that response only and keeps at most the first 512 characters of an error body in memory until the response finishes; nothing of it is stored except a matching plain code.

## 1. Over-block
Fewer refusals than before. Remaining over-block: a household where more than 64 connections are open at once through one door, or one device opening more than 240 a minute (four a second sustained). Neither matches normal phone use (ten screen loads a minute is 120).

## 2. Under-block
A misbehaving LAN device can now hold 24 sockets and open 4 a second instead of 6 and 40 a minute; the total 64, the 10 s handshake timeout and header/request timeouts still bound resources. In mirrored mode a local Windows program can use the whole 64 (it could already exhaust the old shared 6, starving every phone; a program already on the PC is outside the threat this limit addresses). The refusal log does not record successful requests (by design) nor refusals on the main listener.

Dependency named: the mirrored-mode door-sized bucket relies on the Windows pass-through limiting each real caller (24 open, 240 a minute). That is the Windows app's `LanForward` (instar-desktop-apps, commit raising its limits to 24/240/64, with tests on both sides of each limit in that repo); a Windows app older than that still refuses at 6/40 before the agent. How it is verified: the next live home-Wi-Fi phone run through the Windows app checks both hops with the refusal log and the app log.

## 3. Level of abstraction
The limits stay where A4 put them (the listener's connection handler and the pass-through). The log sits in the listener, the one place that sees connection-level, TLS-level and HTTP-level refusals of that listener; routes are unchanged. No smarter gate exists for this; the log feeds people and agents, not a gate.

## 4. Signal vs authority (docs/signal-vs-authority.md)
The log is a pure signal: it never refuses, delays or changes an answer. The limit change only moves existing numeric limits; the decision structure (deterministic resource bounds, not judgment calls) is unchanged, which is the right kind of logic for a resource bound.

## 5. Interactions
- `markSameNetworkSocket` rewrites the socket's `remoteAddress` to `sn:<addr>`; the log takes the real address from that function's return value, so `isLoopbackPeer` and arrival checks are untouched.
- Wrapping `res.end` calls the original with the same arguments; the gate's bare `/health` answer, `writeContinue` and express responses behave as before (existing integration/e2e suites pass).
- The Windows pass-through ships 24/240/64 in the same change set (separate repo), so the two hops agree; an older Windows app with 6/40/32 still refuses before the agent and is fixed by its own update.
- The wsl-listener test "per-address limit stays on in mirrored mode" now asserts the door-sized bucket.

## 6. External surfaces
One new local-only read route; a new state file in the agent's state folder (not synced). Phones see fewer refusals. No change to what the listener serves.

## 7. Multi-machine posture
Machine-local by design: each machine's home listener serves only phones on that machine's network, and its refusals are about that machine's door. The file is in `state/` and is not part of git-sync; reading another machine's refusals goes through that machine (not proxied), which matches the other `/mobile/same-network*` routes.

## 8. Rollback
Revert the commit. The state file is left behind harmlessly (nothing reads it after a revert); no migration.

## Tests
- `tests/unit/same-network-home-limits.test.ts` (new, 19): the literal numbers; a busy phone (ten 12-connection loads in a minute, then 24 open); 24/25 open and 240/241 a minute with the 59 s/60 s edges; mirrored loopback 64/65 and 960/961, IPv4-mapped form, two busy phones, another address still 24, a direct listener's loopback still 24; refusal-log route reduction, codes, device prefix, bound and coalescing, private file and restart, unreadable file; a real TLS listener records gate and route refusals (no secrets in the file), a limit refusal and a failed handshake once each. Negative control: with 6/40/32 put back, 9 of 19 fail (the limit tests; the log tests do not depend on the numbers).
- `tests/integration/same-network-refusals.test.ts` (new, 2): a stand-in phone over real TLS; refusals read back through the route without setup id, PIN, signature, pairing code or full device id; 401 without a token, 403 when forwarded.
- `tests/e2e/same-network-first-phone-alive.test.ts`: the route is alive on the production start path, and the log survives a restart.
- `tests/unit/same-network-wsl-listener.test.ts`: mirrored bucket assertion updated.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given the diff, the artifact and the A4 spec), 2026-11-21. Verdict: concur, nothing blocking. It traced that the forwarder bucket is set only from a mirrored bind plan (always 127.0.0.1) and never in NAT, direct or test-override binds; that nothing secret is kept and a flood writes at most once per 2 s; that the `res.end` wrap passes everything through and records once; and that the route is reachable only with the bearer from this computer (the home listener's gate answers 404 first). Non-blocking findings, handled: an error body over 512 characters lost its code (a leading `"error"` field is now read without a full parse); a request whose connection closed before any answer went unrecorded (now `closed-before-answer`); the caller address cannot tell phones apart behind the pass-through and a flood can push old entries out (said in the awareness text); the pass-through dependency is named above. Accepted: a short all-letter token-like path segment would be kept as written (no current home-listener route carries one). Test gaps closed: NAT never gets the door-sized bucket, a burst writes the file once, a clipped error body keeps its code, a hung-up request is recorded.

## Current-main repair, 2026-11-22

Fresh helper-created worktree based on JKHeadley/main 9b61d6286, version 1.3.1978. The only merge conflict was two equivalent explanatory comments on UpdateChecker.findBundledNpmCli; retained current main verbatim. No runtime source differs from the previously reviewed candidate except the already-current main. All eight side-effects answers above remain unchanged. Targeted validation: 35 unit, 2 HTTP integration, and 3 production lifecycle tests pass; TypeScript noEmit passes. Full current-tree verification is required before merge. Independent reviewer /root/review_3625_repair concurred: listener, log, route and tests byte-for-byte unchanged from c3f9c466; local-only authentication and forwarder bounds intact. One repair review, one commit attempt planned.
