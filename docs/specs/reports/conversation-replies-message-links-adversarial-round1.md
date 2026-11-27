# Adversarial Review — Round 1

Reviewed the draft spec, its round-one conformance report, and the existing App event codec, durable event deduplication, request recovery and message-link builders. No implementation or tests changed. Conformance signals were considered independently.

## Findings

### PRECISION — Specify duplicate-ID quote evidence custody and conflict outcomes

The compatibility section requires both old-codec arrival orders, but does not prescribe what happens when a stripped base message arrives first and a complete signed v3 copy arrives later, or when two copies carry conflicting quote/proof metadata. `AppConversationsReplicatedStore.ts` currently has a closed field list without reply metadata. `AppConversationStore.ts:705` returns immediately for an existing `(canonicalKey,eventId)`, so later complete evidence is discarded before it can influence projection. Rebuild repeats the first surviving representation.

Concrete case: machine A commits reply R to source S; an old relay strips quote metadata; B receives that copy first, then receives A's intact v3 event with the same ID. Testing only that the base message survives would leave the meaningful second arrival unspecified. Conversely, allowing arbitrary replacement would let a conflicting copy change R's source or downgrade a failed proof into apparent compatibility loss.

Resolution: explicitly choose and test the bounded policy. If supporting additive recovery, retain authenticated quote evidence before ordinary duplicate suppression, bind it to the unchanged base/destination, preserve it through restart/rebuild, and fail unavailable on conflicting evidence. If this increment deliberately retains first-copy loss instead, state that full later evidence is ignored and that quote readiness is unavailable on that replica. In either policy, a later stripped copy must not erase an already-held valid relation, and a conflicting fully preserved v3 copy must not gain a downgrade escape. This does not require origin-offline recovery or a new global receipt protocol.

### PRECISION — Preserve existing uncertain-delivery recovery boundaries

The text says recovery “replays the exact reserved reference and message ID,” while existing `AppConversationService.ts:1014` deliberately does not resend stranded sends: absent local messages become `not-delivered`; appended pending sends become `unknown`. A provider may have accepted a message immediately before process failure, so replaying the provider send to satisfy the new wording could duplicate it.

Resolution: distinguish immutable-reference recovery from delivery replay. Define the reservation-before-append, append-before-dispatch and provider-accepted-before-request-finish cases. Reuse the same normalized reference and ID only where the existing delivery protocol already permits continuation; retain `unknown` where acceptance cannot be established, and never resolve a different original or automatically repeat an uncertain external effect. Tests should include quoted text and media at these crash boundaries and a cached retry after caller revocation/reassignment. The current-actor check must not turn an uncertain historical send into a new authorized send by another person.

## Other Boundaries

No additional material findings in the declared same-conversation input, source visibility/proof redaction, exact provider identity, separate mirror outcome, or exact-link access contract. The conformance concern about initial bounded history should be resolved with the existing exact-ID lookup where available (`AppConversationStore.getMessageEvent`), rather than treating one page's absence as definitive nonexistence. The declared lack of origin-offline recovery is a limitation, not authority to invent metadata. No native release or complete-card claim is warranted by this increment alone.
