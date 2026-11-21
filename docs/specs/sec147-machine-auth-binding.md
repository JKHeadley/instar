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

### 1. The new signature

A new function `signBoundRequest(machineId, privateKeyPem, body, { method, url, recipientMachineId })` returns the existing five headers plus `X-Signature-V2`, a signature over `instar-machine-auth-v2|<machineId>|<timestamp>|<nonce>|<sequence>|<bodyHash>|<METHOD>|<path>|<recipientMachineId>`. `path` is computed from the final request URL with `new URL(url)` (pathname plus search), which is exactly what the HTTP client sends, so string concatenation cannot drift. The domain prefix keeps a v2 signature from ever verifying as v1 or as a mesh ack. `X-Signature` (v1) is always sent too, so an old receiver keeps working.

Every signed call is made with `redirect: 'manual'`, as the desktop calls already are: a redirect would change the path (breaking v2) and would carry the signed headers to another location.

### 2. Three stages, each safe in a mixed pool

- **Stage 1, accept (this release, every machine):** a receiver verifies `X-Signature-V2` when present, over the request's method, `req.originalUrl ?? req.url` (the WebSocket upgrade passes a raw request with no `originalUrl`) and its own machine id. A present v2 that fails is refused (403, typed `binding-mismatch`). A v1-only request is accepted as today and logged `v1-only`. Each updated machine advertises `machineAuth: { acceptsV2: true }` in its signed heartbeat.
- **Stage 2, send (same release, automatic per peer):** a sender adds `X-Signature-V2` only to peers whose latest verified heartbeat advertises `acceptsV2`. A peer that has not advertised it gets v1 only, exactly as today. So the new form is sent only to machines known to check it.
- **Stage 3, refuse v1 (later, owner decision):** `mesh.machineAuth.requireV2` makes a receiver refuse v1-only requests. The agent offers it as a one-tap owner decision when every active pool machine's current signed heartbeat advertises `acceptsV2` and it has sent v2 within the last day; a machine that has not reported is listed as pending, and the owner can mark a machine that is gone as removed.

**No lockout on downgrade.** Stages 1 and 2 never refuse a v1-only request, so a machine that is rolled back, reinstalled on an older build or recovered onto an older version keeps talking to the pool, and the lead stays coherent. Only stage 3 refuses v1, and its recovery is part of it: a refused v1 sender raises a typed `v1-refused` event and the agent offers the owner a one-tap "accept the old format from <machine> for 24 hours" or "turn off requireV2", applied through the config-apply path.

**The compatibility window, stated.** Until stage 3, a captured request can still be replayed to another machine with its v2 header stripped, as today. The window ends when the owner takes stage 3, which the agent offers as soon as the evidence exists and re-raises weekly until it is taken or the owner records a reason not to.

### 3. Failures are not key evidence

When v1 verifies but v2 does not, the receiver logs `binding-mismatch` and does not call `onSignatureInvalid`, so a misrouted or replayed request never feeds identity-recovery evidence against the sender. A sender that gets `binding-mismatch` from an address treats it as an address failure (`wrong-recipient`) and tries the peer's next address, as `poolPeerFetch` does for a dead address.

### 4. Every caller binds

All signing call sites move to `signBoundRequest`; `signRequest` stays exported for compatibility but is not called from `src` (a unit test fails on any `signRequest(` call in `src` outside `machineAuth.ts`). Callers that do not know the recipient today get it carried through: the desktop mesh stream ticket row records the target machine id; `MessageRouter`'s `signRequestHeaders(body)` callback gains `{ method, url, recipientMachineId }`, and `relayToMachine` takes the target machine id from the envelope; broadcast calls sign per peer.

### 5. Corrections to the record

Nonces are persisted to disk and kept 60 seconds (`NonceStore`); the per-sender sequence watermark is memory-only. The code comment that calls the watermark persisted is corrected in the build.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A present v2 signature must verify over this request and this recipient | invariant | basis: irreversible-consequence; evidence: lead hand-over and lease changes cannot be undone by the receiver once acted on. |
| v2 is sent only to peers whose signed heartbeat advertises acceptsV2 | invariant | basis: enumerable-domain; evidence: it makes the accept and send stages independent per peer. |
| v1-only requests are accepted until requireV2 | judgment-candidate | floor: logged per request; arbiter: the owner, offered requireV2 on evidence; fallback: accept, so a mixed or rolled-back pool keeps working. |
| A refused v1 sender after requireV2 | judgment-candidate | floor: typed event and one-tap owner recovery; arbiter: the owner; fallback: refuse. |

## Multi-machine posture

Each receiver's verification is local to it, as today. Capability (`acceptsV2`) is learned from each peer's signed heartbeat, which every machine already receives. `requireV2` is set pool-wide through the config-apply path, and its readiness is read from every machine's heartbeat through the pool roster.

## Simplest robust route

simplestRobustRoute: send the new signature only to peers that advertise they check it, and refuse the old one only by an owner decision on evidence. Rejected: a sticky per-sender record of having seen the new form (it locks out a rolled-back machine and can split the lead), a flag-day cutover (breaks a mixed pool), and a version handshake before each call (an extra round trip). Method and path are signed with the recipient because they authenticate the operation the sender intended.

## Migration

- New optional headers; old receivers ignore them.
- `mesh.machineAuth.requireV2` absent means false.

## Rollout and maturation

- **Test-agent rung (mixed-version pool, throwaway agents):** three throwaway agents, one on main (v1 only), two on this branch. Verify: lease broadcasts, heartbeats, handoff request and yield, live tail and the desktop stream work in every direction; the updated agents advertise `acceptsV2` and send v2 only to each other; a replay of an A-to-B v2 request is refused at C; the old agent's requests are accepted and logged `v1-only`; a lead hand-back between the updated agents and through the old one succeeds; one updated agent rolled back to main keeps the lead working; with `requireV2` on, the rolled-back agent is refused and the one-tap recovery restores it.
- **Development-agent rung:** Echo's pool runs it; readiness for `requireV2` is every active machine's signed heartbeat advertising `acceptsV2` and a v2 send within the last day, never a count of zero v1 traffic (a silent machine sends nothing at any version).
- **Fleet:** stages 1 and 2 ship on by default; they refuse nothing an old machine sends.

## Rollback

Before `requireV2` is on: revert any machine at any time; nothing remembers the new form, so its peers see v1-only requests again. After `requireV2` is on: turn it off first (one config apply, the agent's one-tap), then revert. If a machine was already reverted, the `v1-refused` event offers the same one-tap.

## Tests

- Unit: v2 verifies only over the same method, path and recipient (each changed in turn is refused); a v2 failure is refused even with a valid v1 and does not call `onSignatureInvalid`; v1-only is accepted until `requireV2` and refused after; the domain prefix keeps a v1 signature from verifying as v2; the signed path is computed from the final URL; a sender adds v2 only for peers advertising `acceptsV2`; `wrong-recipient` moves to the next address; the WebSocket upgrade verifies v2 over `req.url`; no `signRequest(` call remains in `src`; the SEC-147 repro, replayed with v2, is refused at C.
- Integration: the real lease and handoff routes with v1-only, v2 and mixed senders.

## Open questions

None for the operator: `requireV2` is offered on evidence (section 2).
