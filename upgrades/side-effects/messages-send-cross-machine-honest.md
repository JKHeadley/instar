# Side-Effects Review — cross-machine /messages/send: real relay path and honest failure

**Version / slug:** `messages-send-cross-machine-honest`
**Date:** `2026-11-20`
**Author:** `Echo (instar-dev agent, outage repair run E2)`
**Second-pass reviewer:** `not performed by a separate reviewer: this work ran in a worker fork that cannot start subagents (see Second-pass review)`

## Summary of the change

Tier 1 (declared). 3 source files, 3 test files, about 120 lines of source. One review round; the first build was cut back after the commit gate's open-PR overlap check showed #3426 owns the arrival layer (see Interactions).

`src/messaging/MessageRouter.ts`:
1. **Relay URL fix.** `relayToMachine` posted to `<peer>/messages/relay-machine`, but the receiving route has always been mounted at `/api/messages/relay-machine` (`src/server/machineRoutes.ts`, Machine-HMAC). Every cross-machine relay got a 404 and fell into the outbound queue as "relay failed (machine unreachable)". Live evidence: the Studio's outbound queue holds the 17:32 message to the Mama PC with exactly that reason, 84 ms after send, while the Mama PC was paired and online. A trailing slash on the stored URL is tolerated.
2. **Revoked vs unknown target.** A target revoked in this registry fails with a revoked reason; a target absent from it fails with a "not known to this machine" reason. Neither is attempted.
3. **Honest result.** `SendResult` gains `delivered`, `failureReason`, `notice` (cross-machine sends only). A terminal failure raises one `DegradationReporter` event per target per 30 minutes (bounded map, 200 targets).

`src/server/routes.ts`: `POST /messages/send` answers **502** (the result plus `error`) when a cross-machine send failed (`phase: failed` and `delivered: false`). Every other outcome, including every same-machine outcome, keeps 201.

`src/messaging/types.ts`: the new optional `SendResult` fields.

## Decision-point inventory

- `MessageRouter.routeCrossMachine` (inactive-target branch): modify: revoked and unknown get distinct reasons, a notice and a deduped signal. Same refuse-at-once outcome as before.
- `POST /messages/send` status: modify: 502 for a failed cross-machine send.

---

## 1. Over-block

No new refusal. The inactive-target branch already failed every such send; only its reason, status code and notice change. A caller that treated any non-201 as an exception now sees one for a send that never left the machine; before, the same send returned 201 with `phase: failed`, which is the defect. In-repo callers read `phase` (`localVerifyWiring` calls the router directly); none relies on 201 for a failed cross-machine send.

## 2. Under-block

- A target this registry does not know is still not reached, even when another paired machine knows it. Routing through a third machine is not built here; see Interactions for why and where it is handed.
- A known target that is offline still goes to the outbound queue (unchanged: `phase: queued`, `delivered: false`, no notice).
- A relayed message still lands in the receiver's inbox at `received` and is not typed into a session; that is #3426's layer.

## 3. Level-of-abstraction fit

The change sits in `MessageRouter.routeCrossMachine`, the single place the cross-machine decision is made, and in the one route that returns its result. It reuses the existing relay route and Machine-HMAC. No new transport, no new endpoint, no credential sent anywhere new.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over content.

The DegradationReporter event is a signal only. The revoked/unknown branch already refused; this change only explains the refusal.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Revoked versus not-registered is a registry fact, enumerable.

## 5. Interactions

- **Open PR #3426** (`feat(messaging): cross-machine session messages are delivered (phase 1)`, converged spec `messages-reach-renamed-sessions` §D, stacked on #3422) also fixes the relay path (with a shared `RELAY_MACHINE_PATH` constant and a legacy alias), adds arrival checks, signed receipts and typing into the session, and adds `reportTerminalFailure` in the same inactive-target branch. A first version of this change also typed arrivals into the session and added a one-hop peer forwarder; both were removed because they duplicate #3426, and the forwarder would be refused by #3426's arrival check (`from.machine === signedBy === relayChain[0] === requestSigner`). What remains is compatible with #3426: its path constant replaces this one line, and its `reportTerminalFailure` call sits beside `failCrossMachine` (a small textual conflict, no semantic one). The unknown-target peer route is handed to #3426's owner as a phase-2 amendment of §D.2, with a PR comment.
- **Receiver side:** on main, `relay()` already verifies the Ed25519 signature and stores the envelope; with the path fixed, envelopes now actually arrive there.
- **Threadline:** untouched.

## 6. External surfaces

- `POST /messages/send` answers 502 for failed cross-machine sends (in the awareness entry).
- Peers now receive real `/api/messages/relay-machine` requests where before they received 404 requests on the wrong path.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change is cross-machine transport. Posture: delivery, no replicated state. Each machine decides from its own registry. User-facing notice: returned to the sending session only (one voice); the DegradationReporter event is machine-local and deduped.

## 8. Rollback cost

Pure code revert; no state migration, no config. Envelopes already delivered stay delivered.

## Conclusion

Ship as Tier 1. The URL fix makes paired-machine sends arrive; the 502 and notice remove the silent 201 for an unknown or revoked target.

## Second-pass review (if required)

This touches outbound message dispatch. The worker fork that built it cannot start subagents, so no separate reviewer ran. The change refuses nothing new and adds no authority; the self-review above was checked against the paths the unit, integration and e2e tests drive.

## Evidence pointers

- Live: Studio outbound queue entry for the Mama PC, `reason: outbound: relay failed (machine unreachable)`, 84 ms after send, target paired and online.
- `git log -S` dates the `/messages/relay-machine` vs `/api/messages/relay-machine` mismatch to the commit that introduced cross-machine routing (9be3cdddf).
- `tests/e2e/messages-send-cross-machine-alive.test.ts` fails on the old path (`expected 'queued' to be 'received'`) and passes with the fix.
- `tests/unit/message-router-cross-machine-honest.test.ts` (4), `tests/integration/messages-send-cross-machine-honest.test.ts` (4, real Machine-HMAC over real ports), the e2e (2); existing `message-router-cross-machine` (23), `messaging-routes` (75), `messaging-lifecycle` (7) green.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a source code defect in the transport; no self-triggered controller added).

## Merge with main (2026-11-21)

`origin/main` (a7f07db3d) was merged into the branch after Local Verify reported `error:conflict`. One file conflicted, `src/messaging/MessageRouter.ts`, against PR #3426 (cross-machine session messages, phase 1): (1) in `routeCrossMachine`, this PR's registry-standing check and `failCrossMachine` (honest 502 + notice, nothing queued) are kept for a revoked or unknown target, and main's `reportTerminalFailure` call (the sender's local notifier, or a signed notice back to the machine the message came from) now runs inside `failCrossMachine` after the failed write, so both behaviours hold; (2) the relay URL is built from main's `RELAY_MACHINE_PATH` constant with this PR's trailing-slash strip. Main's §D.5 relay queue now answers a same-agent session send `relaying` and settles it `received` on the peer's signed ack, so the three happy-path tests of this PR were adapted to that contract (sender wired with `peerAddresses` and `startRelayQueue()` exactly as `server.ts` does; assert `relaying`, await `received`, peer store holds the message). The honest-failure tests (revoked, unknown, no peer knows) are unchanged and still pass. No new decision point; no new side effect.
