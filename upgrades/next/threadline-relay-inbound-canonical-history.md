# Relay conversation history includes incoming messages

<!-- bump: patch -->

## What Changed

Already-authorized messages received through the Threadline relay socket are recorded through the canonical conversation-history recorder before routing. Acknowledgements and probes remain excluded. Recording does not grant trust, block delivery, or claim that a session read the message. Missing sender timestamps are labelled as receive times.

Long messages now have a resolvable backing body when their history entry exceeds the inline limit, instead of a reference to an absent record.

## What to Tell Your User

New incoming Threadline messages appear alongside your agent's replies in conversation history. Long messages can be opened in full. This fixes recording for new traffic; it does not recover older missing history automatically or prove that a message was read.

## Summary of New Capabilities

- Complete incoming-message recording for authorized relay conversations.
- Full text for newly recorded messages above the inline history limit.

## Evidence

Observed before: Luna 1.3.1725 held eight incoming messages in its inbox while the canonical thread held eleven messages, all outgoing. On the candidate, the real-relay lifecycle test serves newly received text over HTTP, including long-body backing and close-only cleanup. All four feature lifecycle cases passed; complete-suite verification remains a required PR merge gate.

- `tests/unit/threadline/relayIngressHistory.test.ts`
- `tests/unit/threadline/ack-stage-wiring.test.ts`
- `tests/integration/threadline/relay-ingress-canonical-history.test.ts`
- `tests/integration/threadline/canonical-history-wiring.test.ts`
- `tests/e2e/threadline/relay-ingress-canonical-history-alive.test.ts`
