# Messages to a session on another machine are delivered

<!-- bump: patch -->

## What Changed

Same-agent messages to a session on another of the agent's machines now reach that session. Before, they never did, for two reasons:
- since August, the sender posted to an address the other machine no longer serves;
- even before that, the receiving machine stored relayed messages and never typed them in.

**Sending.** A message waits as `relaying` while its machine's queue makes one pass over that machine's addresses. It ends:
- `received`, when the other machine confirms with a signed receipt;
- `failed` with the reason, when the other machine refuses it with a signed reason or can't be reached right now.

**Receiving.** The receiving machine checks that the message really came from this agent's own machine before storing it. It types the message into the session holding that role, and never into a session that started after the message was written. If delivery fails there, it sends a signed notice back, and the sending session is told. A machine that stops in the middle of typing a message never types it again; it reports the outcome as unknown.

**Compatibility and clean-up.**
- The old address keeps working for older senders.
- Session messages are no longer written into a folder nothing reads.
- Retries for a machine that is asleep come in a later release.

## What to Tell Your User

- **My machines can pass work to each other's sessions**: "When a session on one of my machines hands work to a session on another, it now actually arrives, and if it can't, the sender is told."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Cross-machine session messages delivered | Automatic; `GET /messages/:id` shows `relaying`, then `received` or `failed` |
| Signed relay receipt/refusal | Automatic |

## Evidence

The root cause was verified live on 2026-11-18: the M5 answered the old path with 404 and the real path with 401.

Tests:
- `tests/unit/messages-cross-machine-relay.test.ts` (10 tests): end-to-end with real Ed25519 keys and two in-process routers. Covers delivery, a remote failure notice that fails the origin envelope, the arrival checks, duplicates, freshness, one pass, unsigned answers moving on, nacks, and readings.
- The existing `message-router-cross-machine.test.ts` (23 tests) passes.
- Integration (`messages-relay-machine-route.test.ts`) and wiring (`messages-cross-machine-wiring.test.ts`) run in Local Verify.
