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

A new function `signBoundRequest(machineId, privateKeyPem, body, { method, url, recipientMachineId })` is the single shared outbound signer. At stage 1 it returns exactly the existing five headers (v1 only); at stage 2 and above it returns those plus `X-Signature-V2`, a signature over `instar-machine-auth-v2|<machineId>|<timestamp>|<nonce>|<sequence>|<bodyHash>|<METHOD>|<path>|<recipientMachineId>`. `path` is computed from the final request URL with `new URL(url)` (pathname plus search), which is exactly what the HTTP client sends, so string concatenation cannot drift. The domain prefix keeps a v2 signature from ever verifying as v1 or as a mesh ack. `X-Signature` (v1) is always sent too. Callers never decide which form to send; the signer reads the machine's stage on every call.

Every signed call is made with `redirect: 'manual'`, as the desktop calls already are: a redirect would change the path (breaking v2) and would carry the signed headers to another location.

### 2. Three stages, advanced by release, never by coordination

Each machine has one setting, `mesh.machineAuth.stage` (1, 2 or 3), read locally. Its default is part of the release, and the stages advance by releasing a new default, so no machine ever has to agree with another at runtime:

- **Stage 1, accept (the release carrying this change, default 1):** a receiver verifies `X-Signature-V2` when present, over the request's method, `req.originalUrl ?? req.url` (the WebSocket upgrade passes a raw request with no `originalUrl`) and its own machine id. A present v2 that fails is refused (typed `binding-mismatch`, section 4). A v1-only request is accepted as today. The sender sends v1 only.
- **Stage 2, send (a later release raises the default to 2):** as stage 1, and the sender adds v2 to every signed call. A receiver still on a pre-change build ignores the unknown header and verifies v1 as before, so no machine at any version is broken by it.
- **Stage 3, refuse (a still later release raises the default to 3):** as stage 2, and a receiver refuses a v1-only request (typed `v1-refused`), with one exemption: a v1-only request from the machine that holds the lease in the receiver's own view is accepted, counted and reported (typed `v1-from-lead`), but only while that receiver has seen no valid v2 from the holder in the last 10 minutes. An updated holder sends v2 to every peer with each lease broadcast (about every 30 seconds), so for an updated holder the exemption is off within a minute of its taking the lease, and a v2-stripped copy of its requests is refused; it applies only to a holder that really is not sending v2. An attacker able to drop every v2-carrying broadcast to a receiver for 10 minutes could reopen it for that holder, which needs sustained control of the path and already breaks the lease; this is the stated residual. Refusing the lead holder could cut the agent off from the owner, because the lead is the machine that serves the owner's channels, and nothing could then carry the owner's decision back; the exemption keeps the pool working while the owner is told.

Each receiver counts, per sender, the requests it admitted with v2, those admitted v1-only, and those it refused (by reason), and shows the counts and the time of the last v2 from each sender in its status read, so the open window is measured rather than assumed. Each raise is its own small change, reviewed and released on its own. The evidence for it is judged in the release review from those counters on Echo's pool. Before the raise to 2, one or more of Echo's machines run as stage-2 canaries (the stage set locally), and the counters must show verified v2 traffic on every route the route-coverage test lists, with no binding rejection, and the tunnel-route test passing. Before the raise to 3, every active machine in Echo's pool must show a recent v2 at its peers, so an offline machine does not count as compatible. The floors under that judgment are 14 days after the previous stage's release (so auto-updating machines, which check for updates at least daily, and machines that are online only some days of the week have caught up) and 7 days of the evidence (one full week of a typical pool's on and off patterns); the review may hold longer, never shorter, so a pool that auto-updates has passed through each stage before the next arrives. A mixed pool is safe at every combination: any stage-1-or-later receiver accepts what a stage-2 sender sends; only a stage-3 receiver refuses anything, and only requests from a machine still older than stage 2.

**The compatibility window, stated.** Until a receiver is at stage 3, a captured request with its v2 stripped can still be replayed to that receiver within the 30-second window, as today. The window closes for each receiver when it reaches stage 3.

### 3. The owner's experience

Stages 1 and 2 need nothing from the owner and change nothing they see. Stage 3 also needs nothing in the ordinary case, because every machine in an updating pool is already sending v2 when it arrives.

The one case that touches the owner is a stage-3 machine receiving only the old signature from another pool machine that does not hold the lead. That machine is most likely on a build older than stage 2 (rolled back by hand, or with updates turned off), but a valid old signature proves only who signed, not which build sent it, so the agent says only what was observed, once per refused machine however many machines refuse it: "<receiver> received a request signed by <sender> with only the old signature and refused it. <sender> may be on an old version." If the old signature comes from the lead holder (`v1-from-lead`), nothing is refused and the message says that <receiver> received old-signature requests from the lead machine and is still accepting them, and asks the owner to update that machine. The agent makes no claim that the lead has moved unless it reads the lease and sees that it has.

For a refused machine the message offers one tap: accept the old format from that machine for one day or one week (one day preselected). It says what that costs: while it lasts, a copied request from that machine can be replayed, as before this fix. When an exception expires and the machine is still refused, the agent raises it again, once, with the same choices, so an exception is never left open without the owner seeing it. This change adds no remote update route between machines, because a route that installs code on another machine is a larger trust change than this finding warrants.

The tap is taken on the machine serving the owner, the lead holder. Its calls reach every stage-3 receiver whatever its build: v2 if it is updated, and v1 under the lead exemption if not. It delivers the exception the way the team-access switch is delivered: a signed per-peer call carrying an approval id, the excepted machine and the expiry. Each receiver stores it in a machine-local file under `.instar/state/` written by that route (not the replicated state manager, which is read-only on a standby). Delivery is tracked only for receivers whose status read shows they support exceptions; a pre-change build neither enforces nor needs one. The serving machine keeps the unexpired approvals and sends them to any supporting receiver that has not reported them on each cycle, so a returning or newly upgraded receiver gets them. Each approval id has a terminal state on each receiver: an exception ends when that receiver sees a valid v2 from the excepted machine, when it expires, or when the owner turns it off (a retire record with the same id); the terminal state is persisted, and a later or repeated delivery of that id is acknowledged without reinstalling it. A pool machine already acts with the agent's full authority, so no new trust question arises. Active exceptions are listed in the security summary through the existing pool read; that reply is unsigned, which is acceptable because the list is display only and enforces nothing.

**Why stage 3 is worth this one owner step.** Without stage 3 the replay this finding describes never closes, and no design closes it without refusing the replayable form somewhere. Stage 3 refuses only a machine that does not hold the lead and is still not sending the new signature at least 28 days and two releases after it began to ship. In an updating pool the owner sees nothing. The lead is never refused, so the owner's channel and the lead never break. The one step that remains is a single tap that restores one stale machine's traffic. A design with no such step would have to keep accepting the replayable form from stale machines forever, which leaves this finding open for exactly the machines least likely to be maintained.

### 4. Failures are not key evidence, and do not downgrade

When v1 verifies but v2 does not, the receiver answers `binding-mismatch` and does not call `onSignatureInvalid`, so a misrouted or replayed request never feeds identity-recovery evidence against the sender.

A `binding-mismatch` is decided in the auth middleware (or the WebSocket upgrade check) before any route handler runs, and the receiver signs the rejection, carried in an `X-Machine-Auth-Reject` response header (on the upgrade it rides the 403 response, read by the client's `unexpected-response` handler), with its own machine key under the domain `instar-machine-auth-reject-v1|<receiver>|<rejectedNonce>|binding-mismatch`. A sender treats an answer as a wrong address (`wrong-recipient`) only when the `<receiver>` field names an active pool machine, the signature verifies against that machine's key, and it names the nonce it sent. Either signer allows the retry, and only for operations whose second delivery is safe by their own semantics, so what any other machine did with an earlier delivery does not matter: the intended peer itself (a path was rewritten on that address) or another pool machine (the address now belongs to it). A server outside the pool cannot sign at all, so its rejection is never retried, as for any POST today. This proves that delivery was refused unexecuted by the machine it reached. Retry is defined per operation and outcome:

| Operation | Signed rejection | Timeout, lost reply or unsigned failure |
|---|---|---|
| Lease broadcast, capacity beat | try the next address now, signed again | no immediate other-address attempt; the next scheduled broadcast or beat carries the current state (epoch and sequence make it idempotent) |
| Live tail (GET) | try the next address now, signed again | existing GET fallback, unchanged |
| Desktop stream open | try the next address now with a newly minted ticket; a ticket is single-use and accepted only by the machine it was minted for, so no ticket is ever used twice | not retried with the same ticket; a new open mints a new ticket |
| Handoff request, yield, any other state-changing call | not retried; returns `wrong-recipient` to the caller | not retried; returns the failure to the caller |

The handoff flow re-reads the lease, the authority on who leads, before any new attempt. A lead change cannot be applied twice because a handoff request spends a single-use challenge, so a new attempt needs a fresh one, and a yield is acted on only while the incoming machine is waiting for it, so a repeated or stray yield is ignored. A state-changing call that times out or loses its reply is never retried, because the first request may have taken effect. Today fallback addresses are used only for GET (`poolPeerFetch`), so the retry lives in three named places: `HttpLeaseTransport`, which already signs per address; `fetchDesktopPeerOverRopes`, which today signs once and reuses the headers and will sign per address; and a new POST path in `poolPeerFetch`, signed per address. If every address answers with a verified `binding-mismatch`, the sender does not retry with v1 only, so no reply can become a way to force the old form. It records a loud degradation event listing, for each attempt, the intended peer, the address tried and the verified rejecting machine, and reports a binding mismatch with its possible causes (the address now belongs to another machine, or something on the route rewrote the path); the tunnel-route test below is a required gate for exactly this case.

### 5. Every caller binds

All signing call sites move to `signBoundRequest`; `signRequest` stays exported for compatibility but is not called from `src` (a unit test fails on any `signRequest(` call in `src` outside `machineAuth.ts`). A route-coverage test enumerates every route mounted behind `machineAuthMiddleware` and the WebSocket upgrade, and checks that each refuses a request whose v2 names another route or machine. Callers that do not know the recipient today get it carried through: the desktop mesh stream ticket row records the target machine id; `MessageRouter`'s `signRequestHeaders(body)` callback gains `{ method, url, recipientMachineId }`, and `relayToMachine` takes the target machine id from the envelope; broadcast calls sign per peer. Mesh RPC already binds the recipient in its envelope and is unchanged.

### 6. Replay state is claimed only on admission

A request refused for any reason (v1 failing, a v2 binding mismatch, or `v1-refused` at stage 3) leaves the nonce store and the per-sender sequence watermark unchanged, so a later correctly bound delivery of a different request is not affected. A request that passes every check claims its nonce and advances the watermark in one step before the route runs, so of two concurrent identical deliveries exactly one is admitted.

### 7. Corrections to the record

Nonces are persisted to disk and kept 60 seconds (`NonceStore`); the per-sender sequence watermark is memory-only. The code comment that calls the watermark persisted is corrected in the build.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A present v2 signature must verify over this request and this recipient | invariant | basis: irreversible-consequence; evidence: lead hand-over and lease changes cannot be undone by the receiver once acted on. |
| A machine at stage 2 or 3 sends both signatures; at stage 1 only v1 | invariant | basis: enumerable-domain; evidence: receivers at every version accept both forms, and the stage is a local setting read on every call. |
| New alternate-address retries after a binding mismatch happen only for calls safe to deliver twice, and only after a signed rejection naming their nonce; handoff never retries automatically; the existing live-tail GET fallback is unchanged | invariant | basis: irreversible-consequence; evidence: no reply proves a separate delivery did not execute, and a lead change applied twice cannot be undone. |
| All addresses answering binding-mismatch never fall back to v1 only | invariant | basis: irreversible-consequence; evidence: even a signed rejection gives the sender no authority to weaken its next request, and a fallback would reopen the replayable form. |
| When each stage's default is raised | judgment-candidate | floor: at least 14 days after the previous stage's release and 7 days of counter evidence on Echo's pool (stage-2 canaries before the raise to 2), and its own reviewed change; arbiter: the instar maintainers' release review; fallback: the default stays where it is. |
| A v1-only request reaching a stage-3 receiver | judgment-candidate | floor: accepted from the receiver's lease holder with a typed event; otherwise refused with a typed event and the owner's one-tap exception of one day or one week, re-raised once at expiry; arbiter: the owner; fallback: refuse. |

## Multi-machine posture

Each receiver's verification and its stage are local to it by design: the stage is read on every call and never has to match another machine's, and every combination of stages in a pool is safe (section 2). machine-local-justification: physical-credential-locality (verification uses keys held on that machine, and the stage only selects which signature forms that machine produces and requires). Exceptions are stored per machine, in a machine-local file on each receiver, delivered by signed per-peer calls from the machine serving the owner (section 3), and listed for display through the existing pool read. The per-sender v2 and v1-only counters are machine-local and shown through the same read.

## Simplest robust route

simplestRobustRoute: advance the three stages by release defaults, so the pool never coordinates a switch at runtime. Rejected, after review: a pool-wide runtime switch with evidence reports, probes and a replicated policy (it grew its own consensus problems: who writes, how decisions are ordered, how a revoked issuer's decisions are verified, for a medium finding); per-peer capability adverts (carried by an unsigned reply, so forgeable); a sticky per-sender record of having seen the new form (locks out a rolled-back machine); a flag-day cutover (breaks a mixed pool). Method and path are signed with the recipient because they authenticate the operation the sender intended.

## Migration

- New optional header; old receivers ignore it.
- `mesh.machineAuth.stage` absent means the release default.

## Rollout and maturation

- **Test-agent rung, mixed pool (one throwaway agent):** one disposable agent paired across three separately keyed machine instances in its roster, one on main and two on this branch, with stages set per instance. Verify, across stage combinations (main/1/1, main/2/2, 1/2/3 and 2/3/3): lease broadcasts, capacity beats, handoff request and yield, live tail and the desktop stream work in every direction where section 2 says they should; a real dual-signed request succeeds at the main instance; a lead hand-back succeeds in each combination; with the main instance holding the lead and the other two at stage 3, its requests are accepted as `v1-from-lead`, the lead stays where it is, and one owner message asks for that machine to be updated; with a stage-3 instance holding the lead and the main instance as a standby, the main instance is refused, one owner message names it, the exception tap on the lead reaches the other stage-3 instance through the signed per-peer call without editing any fixture, the main instance's traffic is restored, and the exception ends when it sends v2; a repeated delivery after the exception ended does not reinstall it; at expiry with the machine still refused the owner is asked once more; a lead hand-back to and from the main instance succeeds under the exception.
- **Test-agent rung, binding (the same throwaway agent):** all three at stage 2. A request A sends to B is accepted at B and answered with a signed `binding-mismatch` at C, replayed unchanged; replayed with v2 stripped it is accepted at a stage-2 C and refused at a stage-3 C. A tunnel route between two instances carries v2 without a mismatch. A handoff whose success reply is dropped, or that gets a signed rejection, is not retried, and the lead is not handed over twice.
- **Development-agent rung:** Echo's pool runs each stage before its default is raised for the fleet.
- **Fleet:** this change ships stage 1 as the default. Raising the default to 2, and later to 3, are two follow-up changes, each registered as a tracked commitment when this one merges, so neither depends on anyone remembering.

## Rollback

Stages 1 and 2 refuse nothing an older machine sends, so any machine can be reverted at any time. At stage 3, a reverted machine is refused and the owner gets the one-tap exception (section 3); the stage can also be set lower on any machine.

## Tests

- Unit: a refused request (v1 failure, binding mismatch or v1-refused) leaves the nonce and watermark unchanged and a later valid request is admitted; two concurrent identical deliveries admit exactly one; the per-sender v2 and v1-only counters count admitted requests; one owner message is sent per refused machine; a v1-only request from the receiver's lease holder at stage 3 is accepted as `v1-from-lead` only when no valid v2 from it arrived in the last 10 minutes, and a v2-stripped request from an updated holder is refused; an exception's terminal state survives a restart and a duplicate delivery does not reinstall it; refused requests are counted by reason; the signer returns v1 only at stage 1 and both forms at stages 2 and 3, checked at a real receiver, including the first request after a restart; v2 verifies only over the same method, path and recipient (each changed in turn is refused); a v2 failure is refused even with a valid v1 and does not call `onSignatureInvalid`; v1-only is accepted at stages 1 and 2 and refused at stage 3, except from a machine with an active exception, which ends when that machine sends a valid v2; the domain prefix keeps a v1 signature from verifying as v2; the signed path is computed from the final URL; `wrong-recipient` moves to the next address in each of the three retry places only on a signed rejection naming the sent nonce, and signs again, including a rejection signed by a third pool machine with its own key; a rejection whose receiver field names no active pool machine is not retried; a timed-out lease broadcast makes no immediate other-address attempt and the next scheduled broadcast carries the state; a handoff or yield answered by a signed rejection, or that times out, is not retried; a desktop stream retry mints a new ticket; all addresses mismatching never sends v1 only and records the degradation event; the WebSocket upgrade verifies v2 over `req.url` and carries the signed rejection on its 403; a route-coverage test enumerates every route behind `machineAuthMiddleware` and the upgrade; no `signRequest(` call remains in `src`; the SEC-147 repro, replayed with v2, is refused at C.
- Integration: the real lease and handoff routes with stage-1, stage-2 and stage-3 senders and receivers in every combination.

## Open questions

None for the operator. The stage raises are release decisions (section 2).
