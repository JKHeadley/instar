## What Changed

Added the durable spine of agent-to-agent delivery robustness (A2A-DURABLE-DELIVERY-SPEC.md, issue #939, CMT-1143) — PR1 of "communications never just die out."

A new SQLite component, A2ADeliveryTracker (per-agent, mirrors the MessageProcessingLedger substrate), records every outbound agent-to-agent message's delivery lifecycle (awaiting-ack → acked → escalated/failed) plus a per-peer inbound-liveness clock. It is wired recording-only (it never gates a send) into both relay-send paths and BOTH inbound accept points: the cross-machine relay-ingest in server.ts (where the peer's real fingerprint is in scope) and the same-machine relay-agent route. A reply on a thread is treated as an implicit processed-ack, keyed on threadId so it is robust to the local-name vs relay-fingerprint identity asymmetry (the bug a multi-agent convergence review caught before merge: the ack had been keyed by the wrong identifier and would never have fired in production despite green tests). Two read-only routes expose peer health: GET /threadline/peers/health and GET /threadline/peers/:fp/health. AgentServer self-constructs the tracker from stateDir so the routes are alive on every entry path.

Redelivery, the explicit ack control-message, and the escalation sentinel are PR2. <!-- tracked: #939 -->

## Evidence

The convergence-caught wiring bug: outbound rows were keyed by the peer's fingerprint, but the inbound accept point keyed the implicit-ack by the sender's display name (local transport) and was wired only on the same-machine path — so the ack never fired for the real cross-machine case despite a green test suite. Reproduced and pinned by a new round-trip wiring-integrity test (tests/integration/a2a-delivery-wiring.test.ts): before the fix, an inbound reply on a thread left the pre-recorded outbound message at awaiting-ack; after the fix (ack keyed on threadId + the cross-machine relay-ingest path wired with the real fingerprint), the same round-trip flips it to acked. 31 tests across all three tiers; tsc clean; pre-commit lints clean.

## What to Tell Your User

You now have a durable way to know whether your messages to another agent actually got through. Every message you send to another agent is tracked until it is confirmed, and a reply counts as that confirmation — so a message can no longer silently vanish with everyone assuming it was delivered. You can ask whether your channel to a specific agent is alive, and the answer comes from a real record instead of a guess: when you last reached them, when they last confirmed, and whether anything is stuck waiting. Automatic retries and an alert when an agent goes dark are coming in the next piece. This is internal plumbing — nothing for you to turn on.

## Summary of New Capabilities

- Durable per-peer delivery tracking for agent-to-agent messages (sent, confirmed, stuck, escalated).
- A reply on a conversation thread automatically confirms the prior message — works with any peer, no upgrade needed.
- A read-only peer-health view answering "is my channel to this agent alive?" — last sent, last confirmed, last heard-from, how many are pending, and a stale flag.
- Recording-only: it cannot block or alter a message; if it failed, sending is unchanged.
