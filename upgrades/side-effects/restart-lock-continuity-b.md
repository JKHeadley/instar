# Side-Effects Review — A machine that goes away says why (restart-lock-continuity part B)

**Version / slug:** `restart-lock-continuity-b`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent (new mesh command; shutdown path)`

## Summary of the change

A new signed mesh command, `machine-away { reason, expectedBackInSec?, serverStartedAt }`. It is the graceful-shutdown "leave" of the parent spec's Part D.

**Sending (shutdown handler, before `coordinator.stop()`).**
- The reason comes only from records the machine itself wrote:
  - `machine-restart`: a dispatched restart rung on this boot within 5 minutes, from the host restart ledger;
  - `server-restart`: `readLastRestartRequest()` within the last 2 minutes;
  - otherwise `stopping`.
- It goes to every peer in parallel: at most 8 in flight, within a 2 s budget (`machineMaintenance.awayAnnounceBudgetMs`, 500 to 10000 ms).

**Receiving.**
- RBAC adds a registered-peer case.
- The handler binds the record to the authenticated sender, in an in-memory `MachineAwayBook`.
- The deadline is computed on the receiver's clock.
- A duplicate from the same instance keeps the first deadline. An announcement from an older instance is ignored.

**Clearing.**
- The presence puller feeds each pull result to the book.
- The record clears when a different `serverStartedAt` answers, or when the same instance still answers 15 minutes later.
- A peer that does not report its instance clears on a success that follows a failure.
- `session-status` now carries `serverStartedAt`.

**Reading.** `classifyMachineEmptyState` reads `offline: <reason>` for a machine that announced and is not online, with overdue wording 10 minutes past the expected time. The pool rows pass that reason in.

Spec: `docs/specs/restart-lock-continuity.md` B, approved by the Chief of Staff (msg 4f877632).

## Decision-point inventory

- Which reason to send: invariant, read from the machine's own records.
- Reading a peer as `offline`: invariant, set only by a verified announcement and cleared by instance or time.
- Neither blocks anything.

## 1. Over-block

None.

## 2. Under-block

- During a whole-OS shutdown, networking may already be gone. A machine that leaves without announcing reads as it does today.
- A hand restart of the whole Mac reads `stopping`, because the server cannot tell it apart from a stop.

## 3. Level-of-abstraction fit

- The command reuses the mesh's signed RPC, RBAC and dispatcher.
- The presence puller's existing pass does the clearing.
- The pool classifier's existing reading shows the result.

## 4. Signal vs authority compliance

Display only. It never routes, places or blocks.

## 5. Interactions

- The shutdown adds about 2 s, best effort (plus a bounded local read before the budget), inside a try/catch, before the coordinator stops.
- An older peer refuses the unknown command (RBAC default arm). The sender counts that peer as not reached and logs it.
- Parent spec Part D's scheduled restart will reuse this command as its announcement.

## 6. External surfaces

- A new mesh command.
- A new optional `serverStartedAt` field in the `session-status` reply.
- Pool text: `offline: <reason>`.
- One config key read with a code default; no migration.

## 6b. Operator-surface quality

The pool reads, for example, "offline: restarting the machine, expected back by 08:20" or "offline: stopped on purpose, reason not recorded".

## 7. Multi-machine posture

Unified: every peer receives the announcement and shows it.

## 8. Rollback cost

Revert. The record is in memory only, and the new reply field is ignored by old readers.

## Conclusion

Low risk and display only. It covers item 8 of CMT-1940.

## Second-pass review (if required)

Round 1, concern raised: a refusal that resolves rather than throws was counted as reached. That covers an older peer's `claim-unauthorized`, a missing address (`no-url`), and the handler's `malformed` inside an ok envelope. Fixed: a peer counts as reached only when the transport and the handler both say ok, and every other peer is logged with its reason; a unit test covers all four cases. Minor notes, also fixed: `shutdownStep = 'machine-away-announce'` is set, so a deadline names the right step, and the ownership-nudge comment is back above its own handler. The reviewer noted that the time before the budget starts (imports, the ledger read, `sysctl`) is bounded, at worst about 12 s against the 20 s shutdown deadline; accepted.

## Evidence pointers

- `tests/unit/machine-away.test.ts`: 12 pass (adds refused peers counted as not reached). Covers:
  - the reasons;
  - parsing;
  - the receiver-clock deadline;
  - duplicates and older instances;
  - a same-instance pull that does not clear;
  - a new instance that does clear;
  - the 15-minute clear;
  - the fallback for older peers;
  - the offline wording and the overdue wording;
  - RBAC;
  - a dispatched rung counted while a reservation alone is not;
  - the budget with a hanging peer.
- Existing `MeshRpc.test.ts` and `mesh-rpc-auth-exemption.test.ts`: 31 pass.
- `tests/e2e/machine-away-wiring.test.ts`: for Local Verify.
