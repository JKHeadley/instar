# Side-Effects Review — A sender is never left guessing

**Version / slug:** `a2a-required-acknowledgment`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent; 1 blocking and 5 minor concerns raised, all fixed; see the end of this file`

## Summary of the change

Tier 2. About 46 files and 2,000 added source lines, plus tests; 6 of 6 spec rounds. When a peer's message reaches a server but no session has it, the server now sends a typed receipt saying so; a loss or restart sends a second one. The session that gets the message acknowledges with a one-line summary through a new `threadline_ack` tool. A session that stays silent gets one reminder if it is interactive, and the sender is told after 15 minutes. New code is in `src/threadline/requiredAck.ts`, `requiredAckStore.ts` and `requiredAckService.ts`, wired through `src/commands/server.ts`, `routes.ts`, `InboundMessageGate.ts`, `ThreadlineBootstrap.ts`, `ThreadlineRouter.ts`, `TopicLinkageHandler.ts`, `SpawnRequestManager.ts`, `MeshRpc.ts` and `client/ThreadlineClient.ts`. It reverses the recorded ACT-091 decision against a queued receipt, for the reasons in the spec.

## Decision-point inventory

- `InboundMessageGate` kinded-ack pass — add — a kinded ack passes before the trust-operation and rate-budget steps. An unkinded encrypted ack stays behind them, as today.
- Ack stage branch — modify — a kinded ack is consumed and honoured only for rows sent to that fingerprint; `held` never records delivery.
- Capability gate on sending a kinded ack — add — only to a peer whose latest chat carried the stamp.
- Unknown-sender undecodable body — modify — logged, counted and dropped, instead of routed as placeholder chat.
- `SpawnRequestManager` early re-arm — modify — a session-limit latch can re-arm before the cooldown when a slot is free, with brakes. Admission is unchanged.
- Watch timers — add — signal-only reminder and sender notice.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

One real case. A chat message from a sender whose keys we don't have used to reach a session as "[undecryptable relay message]". It is now dropped. That placeholder held nothing a session could read, and it could only prompt a session to ask for a resend. The sender's ledger stays unacknowledged and the drop is logged, but a sender on an older build gets no signal beyond that. Accepted, because routing it is what lets a lost-keys receipt start a session.

A kinded ack with a reference to a row we don't hold has no effect. After a relay-holder move, that can include a real `read`. Health reports `unknown`. Accepted in the convergence report.

## 2. Under-block

**What failure modes does this still miss?**

- An agent that acknowledges and then goes quiet.
- A poor or generic summary passes; the reader judges it.
- A message reaching a topic session on another machine is not watched, and a `resume-pending` message gets `waiting` with no watch if it later wakes (fb-73966275-120).
- A daemon-relay agent advertises support but sends no receipts (fb-73966275-120).
- A delayed receipt from an older attempt can cross a sender's resend of the same id.
- A held message still waits behind a full limit. Overflow is fb-50b25fac-7d0, and the topic mirror still looks read, fb-fc8bc3ae-4e5.
- The existing spawn-prompt exposure of a peer-chosen message id is not changed by this work (fb-505812ad-911).

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Receipts belong at the relay handler, the only place that knows the routing outcome. Correlation belongs on the tracker's database. The close sits in the routes because both MCP transports arrive there. Nothing smarter exists to feed: the warrants-reply gate decides whether to answer, not whether a sender has been told.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface on content. Its checks are identity and capability checks that only remove an effect from a receipt, and the requirement is enforced by telling the sender. The undecodable drop is a hard invariant: a body nobody can read has no meaning to judge.

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point?**

No. Every point in the inventory is `invariant` in the spec, with reasons.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- Auto-ack: "Composing response..." is unchanged and does not close a watch.
- Inbound-id ledger: kinded acks are exempt from admission, so a duplicate cannot flip a row by thread.
- Collaboration re-drive: its nudges use another path and do not close watches.
- Drain give-up: the HIGH Attention item is unchanged, except an early re-arm does not reopen it within an episode.
- Unknown-sender trust and downgrade refusal: run after the new decode check.
- The session limit: admission untouched, so the fork-bomb and capacity brakes stand.

No double-firing identified: each row gets one reminder and one notice, and pending rows retry with backoff and expire after an hour.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

Yes. The wire gains `ackKinds` on chat and `ack` on ack messages, frozen by the spec; old decoders ignore both. A new MCP tool, a new route (`POST /threadline/ack`), a new mesh verb, new peer-health fields and a default-on config block. A receipt carries a reason, but for a peer without a trust profile `busy` replaces the capacity reasons. A summary is encrypted when the trigger was. The relay can still see that an ack exists, as it can today.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface touched: no dashboard, no new notice, no Telegram text.

## 7. Multi-machine posture (Cross-Machine Coherence)

**When this agent runs on MORE THAN ONE machine, what is this feature's posture?**

Receipts are sent by the machine holding the relay connection. Ledger fields, capabilities and watch rows are written where the send or hand-off happened and are proxied-on-read through the merged `?scope=pool` peer-health read. `threadline_ack` on a standby forwards over `a2a-relay-forward-ack`. No user-facing notices, so no one-voice question; no durable state strands on a topic transfer beyond a watch, which then sends its notice; no generated URLs.

## 8. Rollback cost

Revert and release. Tables and columns are additive and harmless when unused. `threadline.requiredAck.enabled: false` stops sending, watching and the instruction without a release. After a rollback, a peer on the new build can send a `held` that the old build records as a delivery ack, until the old build's next message clears its capability row. Limited and self-clearing.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action`: closure `guard`, enforced by the ratchet at `tests/unit/self-action-convergence.test.ts`. Pending receipts retry with doubling backoff to 10 minutes and expire after an hour, so a send that always fails settles at about 11 attempts; registered as `required-ack-pending-retry`. The watch timers fire at most one reminder and one notice per row.

## Second-pass review

Reviewer read the spec and the real code, not the tests.

Concerns raised and fixed:
1. Blocking: an encrypted kinded ack to a peer that lost our keys decoded as placeholder chat and could start a session. Fixed by dropping undecodable bodies.
2. Receipts could fall back to plaintext after a restart and be silently lost. Fixed: every kind refuses to downgrade when the trigger was encrypted.
3. An undecodable message could delete a capability row. Covered by fix 1.
4. A resend could lower the encryption rule. Fixed in `prepareWatch`.
5. The gate pass was wider than needed. Fixed: only kinded acks pass.
6. Two unguarded database throws. Fixed.

The reviewer re-read all six fixes against the code and confirmed they hold, then found three false statements in this file and the spec, since corrected. Those final document corrections were not re-reviewed.

## Live proof so far

Real relay, throwaway agents, this build:
- Passed: at a full limit the sender's health shows `lastHeld {state: queued, reason: session-limit}` with the row not acked; no session started on either side; an encrypted kinded ack through the real gate; `unknown/restart`; `unacknowledged` once a session ended.
- Not run: the `read` path through a real session, because a throwaway has no login and must not borrow one, and D7's early re-arm, because a live limit raise does not apply (`fb-41158fdb-302`). Both are covered by unit and integration tests only, and `read` must be proved between Echo and Scout after release.

Found in that run:
- A thread-matched delivery ack flipped an older held row instead of the row that reached a session. Fixed by preferring rows with no held state, with a test. This small change came after the second-pass review and has not been re-reviewed.
- Filed as fb-d110c68f-227: a receipt lost with asymmetric pairing keys, and receipts counting toward the relay's new-agent budget.
