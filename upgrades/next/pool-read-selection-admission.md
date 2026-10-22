## What Changed

- **A machine that was perfectly fine could show up as unreachable in the "all my machines" views.** When your agent runs on more than one computer, it asks each of the others for their sessions, jobs, attention items and guard posture. Each machine advertises several ways to be reached (Tailscale, the local network, the Cloudflare tunnel). The code that picked one of those collapsed the whole list to a single address and then checked whether that one was safe to send credentials to. If it was not, the read simply failed — even when another perfectly good, already-proven way to reach that machine was sitting in the list. The picker is now admission-aware: it walks the advertised ways in order and hands back the best one that is actually allowed, so a healthy tunnel is no longer discarded because a private address happened to come first.
- **One destination per request, and the skipped ways are reported instead of vanishing.** The picker returns which ways it passed over and why, so "I could not reach that machine" can say which rope was refused rather than leaving you to guess.
- **The reason given for refusing a Tailscale address is now the true one.** Sending credentials to a Tailscale address over plain `http` is not supported, and that refusal now says exactly that (`cgnat-plaintext-unsupported`) instead of being reported as a disallowed scheme or an unknown host, which pointed at the wrong problem.
- **A pre-existing hole in the IPv6 check is closed.** The pattern meant to recognise private IPv6 addresses also matched several addresses that are *outside* that private range, so they were being treated as private. It now requires the full address shape. The same correction was made for link-local addresses.
- **Your agent's instructions gained a short card** explaining the difference between "that address was refused", "that machine did not answer" and "I have no address for that machine" — three very different situations that used to read the same. Existing agents get the card on update; new ones get it at install.

## Honest Scope

- This fixes **which** way to a machine gets chosen. It does **not** add the ability to send credentials over a plain-`http` Tailscale address — that needs the destination to prove who it is first, which is deliberately left for later and tracked as a commitment (CMT-013) rather than quietly assumed.
- The serving-lease path between machines is untouched by this change.
- One behaviour this does not promise: a way to reach a machine can be allowed and still be dead. Choosing an allowed rope is not the same as recovering from an unreachable one.

## What to Tell Your User

If one of your machines ever showed as unreachable in the pool views — sessions, jobs, attention, guard posture — while that machine was actually running fine, this is the likely cause and the fix. Your agent now picks whichever of the machine's advertised addresses it is genuinely allowed to use, instead of giving up when the first one in the list was not usable. When it still cannot reach a machine, it can now tell you which route was refused and why.

## Evidence

- `tests/unit/peer-url-guard.test.ts` (19 tests): the selection now carries which kind of rope it is, with trap cases for loopback, `::1`, private and link-local IPv6; a table-driven "no admission path" check across four rope kinds, five allowlist shapes and four Tailscale addresses; boundary cases on both sides of the private IPv6 ranges; and a 1500-address sweep that must agree with the shared address predicates.
- `tests/unit/resolve-mesh-peer-url.test.ts` (15 tests): a regression built from the real addresses of the incident machine, a check that exactly one destination comes back per call, and a distinction between "every rope was refused" and "there were no ropes at all".
- `tests/unit/peer-presence-wiring.test.ts` and `tests/e2e/remote-session-close-lifecycle.test.ts`: the wiring checks now name the shared picker, so a regression back to the collapsing version fails rather than passing.
- Spec: `docs/specs/peer-credential-guard-tailscale-coherence.md`, converged over 18 review rounds, plus a plain-language companion. Operator-approved 2026-10-22; the approval note records that it was accepted by the operator rather than meeting the automated bar on its own.
- Side-effect review: `upgrades/side-effects/pool-read-selection-admission.md`.

## Summary of New Capabilities

- No new capability. A correctness fix to how a peer machine's address is chosen for pool-scope reads, an honest refusal reason for Tailscale-over-`http`, a closed over-admission hole in the private-IPv6 check, and an awareness card so the three different "cannot reach" situations are told apart.

## Follow-up in the same release — routes now learn which ways are dead

- **A route that stops working now demotes itself.** The first change chose the best *allowed* way to reach a machine; allowed is not the same as alive. Pool reads now report each attempt's outcome into the same route-health record the rest of the mesh already keeps, so a route that is genuinely usable and then dies stops being chosen, and recovers its place when it starts answering again.
- **Who this actually matters for:** two machines on the same local network, where a local address is a real candidate. Where the machines are on different networks, a peer's local address was already being skipped, so the first change was enough on its own.
- **It reports the route, not the verdict.** A reply that comes back — even an error reply — proves the route carried traffic, so only a genuine connection failure or timeout counts against it. Otherwise every machine answering "that feature is off" would have looked like a broken network.
