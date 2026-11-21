---
title: "A signed request between machines names its route and the machine it is for"
slug: sec147-machine-auth-binding
author: Echo
tier: 2
status: draft
eli16-overview: sec147-machine-auth-binding.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "An Instar Agent Is Always a Multi-Machine Entity; No Single Device Lockout"
decision-source: "Chief of Staff, message of 2026-11-21 13:37:47Z: 'SEC-147 next ... The signature change must roll out in stages: machines accept both the old and new format first, then send the new format, and only then refuse the old ... a hard cutover would break the mesh and the lead hand-back. Test a mixed-version pool on throwaway agents.'"
security-ledger: "SEC-147 (medium, reproduced)"
approved: false
---
# A signed request between machines names its route and the machine it is for

## Problem statement

Machines in an agent's pool call each other with requests signed by the sending machine's identity key (`signRequest`, `machineAuthMiddleware`, `src/server/machineAuth.ts`). The signed message is `machineId|timestamp|nonce|sequence|sha256(body)`. It names the sender but not the method, the route or the machine the request is for. Each receiving machine keeps its own nonce store, so a request captured on its way from machine A to machine B can be replayed, within the 30-second window, to machine C, at any route whose body matches. Reproduced on main: headers signed for B's `POST /test` were accepted unchanged by C's `POST /api/handoff/yield`, which takes an empty body and hands the lead over.

The fix is to sign the method, the path and the receiving machine. Machines in a pool run different versions at any moment, so the change cannot be a cutover: an old receiver checks only the old message, and an old sender sends only the old one.

## Proposed design

### 1. Two signatures on every updated request

`signRequest` gains an optional binding `{ method, path, recipientMachineId }`. When given, it adds two headers beside the existing five:
- `X-Signature-V2`: a signature over `instar-machine-auth-v2|<machineId>|<timestamp>|<nonce>|<sequence>|<bodyHash>|<METHOD>|<path>|<recipientMachineId>`, where `path` is the request path and query exactly as sent (`pathname + search`), and the domain prefix keeps it from ever matching the v1 message.
- `X-Recipient-Machine`: the recipient's machine id (for diagnostics; the check uses the signed value).

`X-Signature` (v1) is still sent, so an old receiver keeps working unchanged.

### 2. What an updated receiver checks

- **`X-Signature-V2` present:** it must verify over the request's own method, `req.originalUrl` and this machine's id. A v2 signature that fails, or names another recipient, is refused (403), even if v1 is valid. The v1 signature is not consulted.
- **v2 absent:** the request is a v1-only request.
  - If this receiver has already seen a valid v2 request from that sender (`v2Seen`, recorded per sender machine id in the nonce store's directory, set on the first valid v2 request and never cleared except by the sender's revocation), it is refused: the sender is updated, so a v1-only request from it is a stripped replay.
  - Otherwise it is accepted as today (an old sender), and logged as `v1-only` in the security log.
- Nonce and sequence checks run after the signature check, as today, for both formats.

So two updated machines are protected from their first exchange, without waiting for the rest of the pool; old machines keep talking to everyone.

### 3. Every caller binds

All 19 `signRequest` call sites (lease broadcast and acks, heartbeat, handoff request/ack/yield, reply markers, live tail, mesh RPC transports, the WebSocket desktop peer auth, the CLI's machine commands) pass the binding. Each knows its target URL and the peer's machine id. A unit test enumerates every `signRequest(` call in `src` and fails if one omits the binding (the same enumeration pattern as the confined-write chokepoint test), so a new caller cannot be added unbound.

Where a request goes through a proxy that rewrites the path (none today: pool calls go direct, `poolPeerFetch`), the binding uses the path the receiver sees; the test plan includes a tunnel-routed call to confirm it is unchanged.

### 4. The last stage: refuse v1 everywhere

A setting `mesh.machineAuth.requireV2` (absent = false). When true, a receiver refuses every v1-only request. It is turned on by the agent, not by hand, once every machine in the pool reports a version that sends v2 (the pool roster already carries each machine's version). The agent offers it as a one-tap owner decision with the list of machines and versions; a machine that has not reported is shown as pending and blocks the offer. Until then the `v2Seen` rule already protects every updated pair.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A present v2 signature must verify over this request and this recipient | invariant | basis: irreversible-consequence; evidence: lead hand-over and lease changes cannot be undone by the receiver once acted on. |
| v1-only from a sender already seen sending v2 is refused | invariant | basis: enumerable-domain; evidence: an updated sender always sends v2, so v1-only from it can only be a stripped replay. |
| v1-only from a sender never seen sending v2 is accepted (until `requireV2`) | judgment-candidate | floor: logged per request; arbiter: the owner, offered `requireV2` when every pool machine runs a v2-sending version; fallback: accept, as today, so a mixed pool keeps working. |

## Multi-machine posture

`v2Seen` is per receiving machine, about each sender: machine-local by design. machine-local-justification: physical-credential-locality (it records what this machine's own verifier has observed from a sender's key; another machine's observation proves nothing about requests arriving here). `requireV2` is set pool-wide through the config-apply path, like other mesh settings.

## Simplest robust route

simplestRobustRoute: send both signatures and let each receiver learn, per sender, that the sender is updated. Rejected as worse: a version handshake before each call (an extra round trip and a new failure mode) and a flag-day cutover (breaks a mixed pool). Binding only the recipient would close the reproduced cross-machine replay; method and path are added at no extra cost so that a captured request also cannot be aimed at a different route on its own receiver in any future case where the nonce check does not catch it (for example after that receiver restarts and loses its in-memory nonces).

## Migration

- New optional headers; old receivers ignore them.
- `v2Seen` is a small JSON file beside the nonce store; absent means not seen.
- `mesh.machineAuth.requireV2` absent means false.

## Rollout and maturation

- **Test-agent rung (mixed-version pool, throwaway agents):** three throwaway agents, one on main (v1 only), two on this branch. Verify: lease broadcasts, heartbeats, handoff request and yield, and live tail all work in every direction; the two updated agents refuse a replayed A-to-B request at C and a stripped v1-only replay between them; the old agent's requests are accepted and logged `v1-only`; a lead hand-back between the updated agents and through the old one succeeds.
- **Development-agent rung:** Echo's pool runs it; the security log's `v1-only` count goes to zero once every machine is updated, which is the evidence for offering `requireV2`.
- **Fleet:** ships on by default; it refuses nothing that an updated sender sends.

## Rollback

Revert. Senders stop sending v2; receivers forget the rule. A receiver that kept a `v2Seen` file from the new version would, after a revert of only some machines, refuse their v1-only requests: the rollback instructions say to delete that file on any machine reverted while peers remain updated. (Reverting all machines together needs nothing.)

## Tests

- Unit: v2 verifies only over the same method, path and recipient (each changed in turn is refused); a v2 failure is refused even with a valid v1; v1-only accepted from an unseen sender and refused after `v2Seen`; the domain prefix keeps a v1 signature from verifying as v2; `requireV2` refuses v1-only; every `signRequest` call in `src` passes a binding (enumeration test); the SEC-147 repro now fails (replay to C refused).
- Integration: the real lease and handoff routes with v1-only, v2 and mixed senders.

## Open questions

None for the operator: `requireV2` is offered on evidence, as section 4 describes.
