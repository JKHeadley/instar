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

A new function `signBoundRequest(machineId, privateKeyPem, body, { method, url, recipientMachineId })` returns the existing five headers plus `X-Signature-V2`, a signature over `instar-machine-auth-v2|<machineId>|<timestamp>|<nonce>|<sequence>|<bodyHash>|<METHOD>|<path>|<recipientMachineId>`. `path` is computed from the final request URL with `new URL(url)` (pathname plus search), which is exactly what the HTTP client sends, so string concatenation cannot drift. The domain prefix keeps a v2 signature from ever verifying as v1 or as a mesh ack. `X-Signature` (v1) is always sent too.

Every signed call is made with `redirect: 'manual'`, as the desktop calls already are: a redirect would change the path (breaking v2) and would carry the signed headers to another location.

### 2. Three stages, each safe in a mixed pool

- **Stage 1, accept (this release, every machine):** a receiver verifies `X-Signature-V2` when present, over the request's method, `req.originalUrl ?? req.url` (the WebSocket upgrade passes a raw request with no `originalUrl`) and its own machine id. A present v2 that fails is refused (403, typed `binding-mismatch`). A v1-only request is accepted as today, and counted per sender as `v1-only`.
- **Stage 2, send (this release, every call):** an updated sender adds `X-Signature-V2` to every signed call, unconditionally. An old receiver ignores the unknown header and verifies v1 as before, so sending can never break an old machine. There is no per-peer capability step: an earlier draft learned capability from the capacity beat, but that beat is the plain, unverified reply to a signed mesh call, so anyone answering at a peer's address could forge or drop it, and gating on it added nothing old receivers need.
- **Stage 3, refuse v1 (later, owner decision):** `mesh.machineAuth.requireV2` makes a receiver refuse v1-only requests.

Stages 1 and 2 ship in one release because the decision's order (accept, then send, then refuse) is about never sending a form a receiver would reject. An unknown header is never rejected by an old receiver, so sending in the same release keeps that order's purpose. Refusing stays a separate, later step.

### 3. When stage 3 is offered, and how it is confirmed

Readiness is read from what each receiver authenticated itself, never from adverts. Each machine keeps, per sender, the time of the last valid v2 request and the time of the last v1-only request (memory plus a small on-disk file, kept 7 days). The agent reads every active machine's report over the existing signed pool read; the report itself carries a signature by the reporting machine under the domain `instar-machine-auth-evidence-v1|<reporter>|<timestamp>|sha256(report)`, so a reply from a stale address or an on-path party cannot be passed off as a machine's report.

The agent offers stage 3 once, when for every active pair (sender, receiver) the receiver reports a valid v2 from that sender and no v1-only from it since that v2, and every active machine, standbys included, has answered. A machine that has not answered is listed as pending; the owner can mark a machine that is gone as removed. If the owner does not take it, the decision is not raised again; it stays listed in the agent's security summary with its current evidence.

Confirmation that the switch took effect uses the same signed report, which also carries each receiver's effective `requireV2`. The switch shows as applied only when every active receiver reports it on; until then the summary shows which receivers are still pending.

### 4. The owner's experience

Stages 1 and 2 need nothing from the owner and change nothing they see. Stage 3 is one decision, offered once, in plain words: "All your machines now check the newer, safer signature. Turn off the old kind?" with Approve and Not now. After approval the summary says when every machine has applied it.

If a machine is later rolled back to an older build and is refused, the agent tells the owner which machine and offers, in one tap, either to accept the old format from that machine for a period the owner chooses (one day is preselected; a week and until turned off are offered, for a machine under longer repair) or to turn the switch off. Any active exception is listed in the security summary next to the switch. This is the smallest set of owner steps a cutover can have: a medium finding still ends with old-format traffic refused only on the owner's word, so the agent never makes the pool stricter on its own.

### 5. Failures are not key evidence, and do not downgrade

When v1 verifies but v2 does not, the receiver answers `binding-mismatch` and does not call `onSignatureInvalid`, so a misrouted or replayed request never feeds identity-recovery evidence against the sender.

A sender that gets `binding-mismatch` treats it as a wrong address (`wrong-recipient`) and tries the peer's next address, signing again for that address. Today fallback addresses are used only for GET (`poolPeerFetch`), so the retry lives in three named places: `HttpLeaseTransport`, which already signs per address; `fetchDesktopPeerOverRopes`, which today signs once and reuses the headers and will sign per address; and a new POST path in `poolPeerFetch`, signed per address. If every address answers `binding-mismatch`, the sender does not retry with v1 only (the reply is unsigned, so a forged mismatch must not become a way to force the old form). It records a loud degradation event naming the peer, which points at a path rewrite between the machines; the tunnel-route test below is a required gate for exactly this case.

### 6. Every caller binds

All signing call sites move to `signBoundRequest`; `signRequest` stays exported for compatibility but is not called from `src` (a unit test fails on any `signRequest(` call in `src` outside `machineAuth.ts`). Callers that do not know the recipient today get it carried through: the desktop mesh stream ticket row records the target machine id; `MessageRouter`'s `signRequestHeaders(body)` callback gains `{ method, url, recipientMachineId }`, and `relayToMachine` takes the target machine id from the envelope; broadcast calls sign per peer. Mesh RPC already binds the recipient in its envelope and is unchanged.

### 7. Corrections to the record

Nonces are persisted to disk and kept 60 seconds (`NonceStore`); the per-sender sequence watermark is memory-only. The code comment that calls the watermark persisted is corrected in the build.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A present v2 signature must verify over this request and this recipient | invariant | basis: irreversible-consequence; evidence: lead hand-over and lease changes cannot be undone by the receiver once acted on. |
| An updated sender always sends v2 alongside v1 | invariant | basis: enumerable-domain; evidence: old receivers ignore unknown headers, so the action has no case where it causes a refusal. |
| All addresses answering binding-mismatch never fall back to v1 only | invariant | basis: irreversible-consequence; evidence: the mismatch reply is unsigned, so a fallback would let any on-path party force the replayable form. |
| v1-only requests are accepted until requireV2 | judgment-candidate | floor: counted per sender in the signed evidence report; arbiter: the owner, offered requireV2 once on that evidence; fallback: accept, so a mixed or rolled-back pool keeps working. |
| A refused v1 sender after requireV2 | judgment-candidate | floor: typed event and one-tap owner recovery with an owner-chosen exception period; arbiter: the owner; fallback: refuse. |

## Multi-machine posture

Each receiver's verification and its per-sender evidence are local to it by design, because only the receiver authenticated the request: machine-local-justification: physical-credential-locality (each record is the result of checking a signature with keys held on that machine). The evidence is proxied on read: the agent reads every machine's signed report through the pool read, standbys included, and shows an unanswered machine as pending. `requireV2` and owner exceptions are set pool-wide through the config-apply path, and each receiver's applied value is read back through the same signed report.

## Simplest robust route

simplestRobustRoute: always send both signatures, refuse the old one only by an owner decision on what each receiver itself verified. Rejected: per-peer capability adverts (the beat that would carry them is an unsigned reply, so it can be forged, and old receivers do not need it); a sticky per-sender record of having seen the new form (it locks out a rolled-back machine and can split the lead); a flag-day cutover (breaks a mixed pool); a version handshake before each call (an extra round trip). Method and path are signed with the recipient because they authenticate the operation the sender intended.

## Migration

- New optional header; old receivers ignore it.
- `mesh.machineAuth.requireV2` absent means false.
- The evidence file is new; a machine without it reports no evidence yet, which shows as pending.

## Rollout and maturation

- **Test-agent rung, mixed pool (throwaway agents):** three throwaway agents, one on main, two on this branch. Verify: lease broadcasts, capacity beats, handoff request and yield, live tail and the desktop stream work in every direction; the old agent ignores the v2 header; its requests are accepted and counted `v1-only`; a lead hand-back between the updated agents and through the old one succeeds; one updated agent rolled back to main keeps the lead working and its rollback shows in the evidence (v1-only after its last v2), so stage 3 is not offered; with `requireV2` on, the rolled-back agent is refused and the one-tap exception restores it.
- **Test-agent rung, binding (throwaway agents):** the third agent updated too. A request A sends to B is accepted at B and answered `binding-mismatch` at C, replayed unchanged and with v2 stripped (refused at C only with `requireV2` on). A tunnel route between two agents carries v2 without a mismatch. The signed evidence report from each agent is read and verified, and a tampered report is rejected.
- **Development-agent rung:** Echo's pool runs it; stage 3 is offered from the signed evidence of every active machine, never from a count of zero v1 traffic.
- **Fleet:** stages 1 and 2 ship on by default; they refuse nothing an old machine sends.

## Rollback

Nothing remembers the new form, so before `requireV2` any machine can be reverted at any time and its peers see v1-only requests again. After `requireV2` is on: turn it off first (the agent's one tap), then revert. If a machine was already reverted, the refusal event offers the same tap or an exception for that machine.

## Tests

- Unit: v2 verifies only over the same method, path and recipient (each changed in turn is refused); a v2 failure is refused even with a valid v1 and does not call `onSignatureInvalid`; v1-only is accepted until `requireV2` and refused after, except from a sender with an active owner exception; the domain prefix keeps a v1 signature from verifying as v2; the signed path is computed from the final URL; every signed call carries v2; `wrong-recipient` moves to the next address in each of the three retry places and signs again; all addresses mismatching never sends v1 only and records the degradation event; the WebSocket upgrade verifies v2 over `req.url`; the evidence report verifies under its domain and a changed byte fails; readiness is false while any active machine is pending or shows v1-only after its last v2; no `signRequest(` call remains in `src`; the SEC-147 repro, replayed with v2, is refused at C.
- Integration: the real lease and handoff routes with v1-only, v2 and mixed senders.

## Open questions

None for the operator: `requireV2` is offered once on evidence (section 3).
