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
- **Stage 2, send (same binary, its own switch):** once sending is on, an updated sender adds `X-Signature-V2` to every signed call. Sending turns on for the pool automatically when every active machine has returned a fresh signed evidence report (section 3), which only a build that verifies v2 can produce, so the accept stage is proven everywhere before anything sends. An old receiver would ignore the unknown header anyway, so a machine that joins later on an old build is not broken by it. Activation is persisted on each machine and read before its first outbound request after a restart, and a machine whose policy has `requireV2` on always sends v2, so a restarted machine never starts in a state its peers refuse. There is no per-peer capability step: an earlier draft learned capability from the capacity beat, but that beat is the plain, unverified reply to a signed mesh call, so anyone answering at a peer's address could forge or drop it, and gating on it added nothing old receivers need.
- **Stage 3, refuse v1 (later, owner decision):** `mesh.machineAuth.requireV2` makes a receiver refuse v1-only requests.

Stages 1 and 2 ship in one binary with separate activation, keeping the decision's order (accept, then send, then refuse) literally: receiving is on from install, sending turns on only on pool-wide signed proof of receiving, and refusing is the owner's later decision.

### 3. When stage 3 is offered, and how it is confirmed

Readiness is read from what each receiver authenticated itself, never from adverts. Each machine keeps, per sender, the time of the last valid v2 request and the time of the last v1-only request (memory plus a small on-disk file). Entries are kept while the sender is in the pool roster, not for a fixed period, so a quiet pair never loses its evidence by waiting. The agent reads every active machine's report over the existing signed pool read. Each read carries a fresh random nonce, and the report carries a signature by the reporting machine under the domain `instar-machine-auth-evidence-v1|<reporter>|<reader>|<readNonce>|<timestamp>|sha256(report)`, where the read nonce is the request envelope's nonce (the same pattern as `relay-ack-v1`). The agent accepts a report only when it is signed by the machine it asked, names this machine as reader and the nonce of this read, and arrives within the read's timeout, so neither a reply from a stale address or an on-path party nor a replayed earlier report can stand in for a machine's current state.

Readiness is judged per sender, not per pair, and is decided fresh for each readiness check rather than by comparing old timestamps across machines whose clocks differ. For a check, the agent opens a decision id bound to the current membership generation, a hash of the sorted active machine ids with their key fingerprints, which changes whenever a machine joins, leaves, is revoked or rotates its key, and first asks every active receiver to start observing for it; each answers with a signed acknowledgement bound like the reports, and observation counts from that moment on its own clock. Only after every receiver has acknowledged does the agent ask every active sender, through the signed pool read, to send one signed no-op request carrying that id to each peer. Each probe's acknowledgement is bound the same way (reader, request nonce, decision id). What proves a sender's current build is its own fresh signed report and its acknowledged probes; receivers' times are supporting evidence. A sender is ready for that check when at least one receiver reports a valid v2 probe from it carrying the id, and no receiver reports a v1-only request from it during the check. From its acknowledgement on, each receiver keeps a `sawV1` flag per sender for that decision id until its final report; a later v2 probe never clears it. A sender that sends no acknowledged probe (a silent machine, or a rolled-back build that has no probe handler) stays pending. The check is run again when the owner taps Approve, so a machine rolled back between the offer and the tap is caught before the switch, and the switch is written through the config-apply path as a compare-and-set on the membership generation the check ran on; if membership changed between the final report and the write, the write is refused and the check reruns. A machine that joins after the switch receives `requireV2` through pairing like any setting; it is not refused as a sender unless its requests arrive v1-only, which raises the usual refused event and one-tap offer. Older per-sender times stay in the report for diagnosis only. This also covers a quiet standby, which produces its evidence on demand. Until stage 3, and for any sender with an exception after it, the original exposure remains wherever v1 is accepted: a captured request with its v2 stripped can still be replayed to another machine within the 30-second window and its route runs. Such a replay also sets `sawV1` and delays the offer, and the summary names the receiver that reported it so the delay is explained. Every active machine, standbys included, must also have answered the report read. A machine that has not answered is listed as pending; the owner can mark a machine that is gone as removed.

The agent offers stage 3 when every active sender is ready. If the owner chooses Not now, SEC-147 stays open in the security ledger with that answer recorded, and the agent offers again only when the facts behind the answer change: a machine joins or leaves the pool, or a machine that was pending becomes ready. It is never re-offered on a timer. The agent's ledger review carries the loop until the owner approves or records that the old form should stay accepted, which closes it deliberately.

Confirmation that the switch took effect uses the same signed report, which also carries each receiver's effective `requireV2` and its active sender exceptions with their expiry times. The switch, and the removal of any exception, shows as applied only when every active receiver reports a policy matching the pool's setting in a report fresh to that read; until then the summary shows which receivers are still pending. The summary is recomputed on every read. A receiver with no fresh signed report shows as "Couldn't confirm this machine's setting", whether it is offline or rolled back. A v1-only request from a machine is reported as "We received an old-format request from this machine", never as proof of an older build, because a stripped replay looks the same; its receiver setting stays unconfirmed until a fresh signed report settles it. That uncertainty is shown with any exception offer too.

### 4. The owner's experience

Stages 1 and 2 need nothing from the owner and change nothing they see. Stage 3 is one decision, offered when the evidence is complete and again only if the pool changes, in plain words: "All your machines now check the newer, safer signature. Turn off the old kind?" with Approve and Not now. After approval the summary says when every machine has applied it.

A machine rolled back to an older build matters in two directions, and the agent says which it can confirm. As a receiver, it checks only the old signature, so requests sent to it lose the binding; nothing the owner taps restores that, and the summary shows its setting as unconfirmed until it reports again. As a sender, its requests are refused by the others; for that the agent tells the owner which machine and offers, in one tap, either to accept the old format from that machine for a period the owner chooses (one day is preselected; a week and until turned off are offered, for a machine under longer repair) or to turn the switch off. The choice says plainly what it costs: while the exception lasts, a copied request from that machine can be replayed to another machine, as before this fix. Any active exception is listed in the security summary next to the switch. This is the smallest set of owner steps a cutover can have: a medium finding still ends with old-format traffic refused only on the owner's word, so the agent never makes the pool stricter on its own.

### 5. Failures are not key evidence, and do not downgrade

When v1 verifies but v2 does not, the receiver answers `binding-mismatch` and does not call `onSignatureInvalid`, so a misrouted or replayed request never feeds identity-recovery evidence against the sender.

A `binding-mismatch` is decided in the auth middleware before any route handler runs, and the receiver signs the rejection with its own machine key under the domain `instar-machine-auth-reject-v1|<receiver>|<rejectedNonce>|binding-mismatch`. A sender treats an answer as a wrong address (`wrong-recipient`) only when the `<receiver>` field names an active pool machine, the signature verifies against that machine's key, and it names the nonce it sent. Either signer allows the retry, and only for operations whose second delivery is safe by their own semantics, so what any other machine did with an earlier delivery does not matter: the intended peer itself (a path was rewritten on that address) or another pool machine (the address now belongs to it). A server outside the pool cannot sign at all, so its rejection is never retried, as for any POST today. This proves that delivery was refused unexecuted by the machine it reached. Retry is defined per operation and outcome:

| Operation | Signed rejection | Timeout, lost reply or unsigned failure |
|---|---|---|
| Lease broadcast, capacity beat | try the next address now, signed again | no immediate other-address attempt; the next scheduled broadcast or beat carries the current state (epoch and sequence make it idempotent) |
| Live tail (GET) | try the next address now, signed again | existing GET fallback, unchanged |
| Desktop stream open | try the next address now with a newly minted ticket; a ticket is single-use and accepted only by the machine it was minted for, so no ticket is ever used twice | not retried with the same ticket; a new open mints a new ticket |
| Handoff request, yield, any other state-changing call | not retried; returns `wrong-recipient` to the caller | not retried; returns the failure to the caller |

The handoff flow re-reads the lease, the authority on who leads, before any new attempt. A lead change cannot be applied twice because a handoff request spends a single-use challenge, so a new attempt needs a fresh one, and a yield is acted on only while the incoming machine is waiting for it, so a repeated or stray yield is ignored. A state-changing call that times out or loses its reply is never retried, because the first request may have taken effect. Today fallback addresses are used only for GET (`poolPeerFetch`), so the retry lives in three named places: `HttpLeaseTransport`, which already signs per address; `fetchDesktopPeerOverRopes`, which today signs once and reuses the headers and will sign per address; and a new POST path in `poolPeerFetch`, signed per address. If every address answers with a verified `binding-mismatch`, the sender does not retry with v1 only, so no reply can become a way to force the old form. It records a loud degradation event naming the peer, which points at a path rewrite between the machines; the tunnel-route test below is a required gate for exactly this case.

### 6. Every caller binds

All signing call sites move to `signBoundRequest`; `signRequest` stays exported for compatibility but is not called from `src` (a unit test fails on any `signRequest(` call in `src` outside `machineAuth.ts`). Callers that do not know the recipient today get it carried through: the desktop mesh stream ticket row records the target machine id; `MessageRouter`'s `signRequestHeaders(body)` callback gains `{ method, url, recipientMachineId }`, and `relayToMachine` takes the target machine id from the envelope; broadcast calls sign per peer. Mesh RPC already binds the recipient in its envelope and is unchanged.

### 7. Corrections to the record

Nonces are persisted to disk and kept 60 seconds (`NonceStore`); the per-sender sequence watermark is memory-only. The code comment that calls the watermark persisted is corrected in the build.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A present v2 signature must verify over this request and this recipient | invariant | basis: irreversible-consequence; evidence: lead hand-over and lease changes cannot be undone by the receiver once acted on. |
| An updated sender always sends v2 alongside v1 | invariant | basis: enumerable-domain; evidence: old receivers ignore unknown headers, so the action has no case where it causes a refusal. |
| Only idempotent calls retry on another address, and only after a signed rejection naming their nonce; handoff never retries automatically | invariant | basis: irreversible-consequence; evidence: no reply proves a separate delivery did not execute, and a lead change applied twice cannot be undone. |
| All addresses answering binding-mismatch never fall back to v1 only | invariant | basis: irreversible-consequence; evidence: even a signed rejection gives the sender no authority to weaken its next request, and a fallback would reopen the replayable form. |
| Sending v2 turns on pool-wide once every active machine returned a fresh signed report | invariant | basis: enumerable-domain; evidence: the report can only be produced by a build that verifies v2, so it is direct proof of the accept stage. |
| v1-only requests are accepted until requireV2 | judgment-candidate | floor: counted per sender in the signed evidence report; arbiter: the owner, offered requireV2 on that evidence and again only when the pool changes; fallback: accept, so a mixed or rolled-back pool keeps working. |
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

- **Test-agent rung, mixed pool (one throwaway agent):** one disposable agent paired across three separately keyed machine instances in its roster, one on main and two on this branch. First verify that sending stays off while the old instance cannot report, and that all traffic, including a lead hand-back, works on v1. Then upgrade all three, observe sending turn on, roll one back to main, and verify that a real dual-signed request succeeds at the old receiver and that a lead hand-back works again. Across both configurations, also verify: lease broadcasts, capacity beats, handoff request and yield, live tail and the desktop stream work in every direction; the old instance ignores the v2 header; its requests are accepted and counted `v1-only`; a lead hand-back between the updated instances and through the old one succeeds; one updated instance rolled back to main keeps the lead working and shows pending or `sawV1` in the check, so stage 3 is not offered; with `requireV2` on, the rolled-back instance is refused and the one-tap exception restores it.
- **Test-agent rung, binding (the same throwaway agent):** the third machine instance updated too. A request A sends to B is accepted at B and answered with a signed `binding-mismatch` at C, replayed unchanged and with v2 stripped (refused at C only with `requireV2` on). A tunnel route between two agents carries v2 without a mismatch. The signed evidence report from each agent is read and verified; a tampered report and a previously valid report from an earlier read are both rejected, leaving that agent pending. A rollback with one agent's clock set ahead still shows that agent not ready. Rolling back a receiver shows it unconfirmed in the summary, and traffic in both directions is checked afterwards. Sending stays off until the third instance reports, then turns on. A handoff whose success reply is dropped, or that gets a signed rejection, is not retried, and the lead is not handed over twice. A silently rolled-back instance shows pending, and one that sends a v1 request during observation shows `sawV1`.
- **Development-agent rung:** Echo's pool runs it; stage 3 is offered from the signed evidence of every active machine, never from a count of zero v1 traffic.
- **Fleet:** stages 1 and 2 ship on by default; they refuse nothing an old machine sends.

## Rollback

Nothing remembers the new form, so before `requireV2` any machine can be reverted at any time and its peers see v1-only requests again. After `requireV2` is on: turn it off first (the agent's one tap), then revert. If a machine was already reverted, the refusal event offers the same tap or an exception for that machine.

## Tests

- Unit: activation survives a restart and is in place before the first outbound request; a cold start with `requireV2` on sends v2 and its report read is accepted; a membership change between the final report and the write refuses the write and reruns the check; a desktop stream retry mints a new ticket; sending stays off until every active machine has returned a fresh signed report and turns on after; a timed-out lease broadcast makes no immediate other-address attempt and the next scheduled broadcast carries the state; a v1-only request is reported as received old-format, not as an older build; v2 verifies only over the same method, path and recipient (each changed in turn is refused); a v2 failure is refused even with a valid v1 and does not call `onSignatureInvalid`; v1-only is accepted until `requireV2` and refused after, except from a sender with an active owner exception; the domain prefix keeps a v1 signature from verifying as v2; the signed path is computed from the final URL; every signed call carries v2; `wrong-recipient` moves to the next address in each of the three retry places only on a signed rejection naming the sent nonce, and signs again, including a rejection signed by a third pool machine with its own key; a rejection whose receiver field names no active pool machine is not retried; an unsigned mismatch or a timeout on a state-changing call is not retried; all addresses mismatching never sends v1 only and records the degradation event; the WebSocket upgrade verifies v2 over `req.url`; the evidence report verifies under its domain, a changed byte fails and a report with another read's nonce fails; readiness is false while any active machine is pending or any receiver has `sawV1` set for a sender in this check, and a later v2 probe does not clear it; a handoff or yield answered by a signed rejection is not retried and returns `wrong-recipient`; a v1 request during observation sets `sawV1`; a silent or rolled-back sender stays pending; a missing report shows the could-not-confirm wording; an exception removed on only some receivers leaves the others pending; a quiet machine's no-op probe makes it ready; a Not now answer is not re-offered until a machine joins, leaves or turns ready; no `signRequest(` call remains in `src`; the SEC-147 repro, replayed with v2, is refused at C.
- Integration: the real lease and handoff routes with v1-only, v2 and mixed senders.

## Open questions

None for the operator: `requireV2` is offered on evidence (section 3).
