---
title: App Message Reactions
slug: conversation-message-reactions
author: echo
status: draft
tier: 2
parent-principle: "Operator-Surface Quality"
eli16-overview: docs/specs/conversation-message-reactions.eli16.md
---

# App Message Reactions

The first increment adds one optional reaction per signed person on one exact held App message. It starts off under `mobilePairing.native.reactions.enabled`. It adds no transcript text, unread activity, session wake or agent dispatch. Other platforms and inbound reaction import are follow-ons.

## Signed contract

A live App conversation row may advertise `messageActions.reactions: { emoji: string[] }` only while the feature, signed sender, local custody and current conversation write access permit the action. A client hides the command until it has the current capability and a settled server event ID. Pin and Reply authorization are independent.

Use `PUT /mobile/chat/app/:key/reactions` with precisely `{eventId,emoji,requestId,expectedRevision}`. `eventId` belongs to the selected occurrence. `emoji` is a literal value from the advertised palette or null to clear. Keep the first palette to 👍 ❤️ 😂 😮 😢 🎉, with those exact Unicode strings. The palette is a UI and compatibility choice. The server never normalizes a different emoji into an accepted value. The client sends desired state rather than a toggle, captures pairing and target at click, and preserves the draft, attachments and scroll.

Resolve the original signed person with the existing mobile admission helper. Require current send authority and read authority on the actual exact event. Use the existing namespaced reader identity to coalesce two devices of the same person. Do not accept an actor ID, target message body, public message ID or conversation override. Unknown and forbidden conversations share a 404. A missing, unreadable, denied or ambiguous target receives the same 409 `reaction-target-unavailable` body. No stored row or actor data is returned on refusal.

The response returns `{eventId, own:{emoji,revision}}` for the original actor. No actor list is included in the first projection. Reads return the caller's confirmed desired value on visible exact message rows only. The initial revision is 0. Clear keeps its incremented revision with a null value. Slot mutation compares the client's `expectedRevision` with the held revision. A stale compare returns 409 `reaction-revision-conflict` and the current own value, subject to current target access. The client can refresh and submit a new intent with a new request ID. After a successful revision comparison, a matching desired value is a no-op. Persist the terminal result and bind its request ID in one request-store write at the held revision. Do not create an entered reservation or append a fact for a no-op. This covers both repeating an emoji and clearing an initially empty slot. A client applies an own projection only if its captured pairing and actor still match, and its revision is at least the highest applied revision for that person and event. An acknowledgment can settle a request without replacing newer state.

## Durable state and custody

Use separate append-only reaction facts related to the exact message event, reduced by the actor, message and authoritative slot revision. Never rewrite the message. Reuse App conversation replication. Require current serving lease and immutable creation-machine custody at admission and before any durable effect, so the new holder of a moved conversation cannot create another operation with the same local-only request ID. Reject ambiguous or absent creation identity; no implicit re-routing. A future cross-machine transfer needs explicit operation custody.

Bind the request ID to the captured actor, destination, exact event, desired emoji and expected revision with the existing request lifecycle. Same intent returns its recorded outcome after current ACL without re-applying. Reuse for another payload returns 409 `payload-conflict`. On the one admitting machine, compare the revision, reserve the request and durably append the fact in one non-yielding single-writer section for that actor and event. The request identity is scoped across all events and operations on that admitting machine, using the request store’s atomic request ID and payload binding rather than a slot-local ID record. The request reserve is durable before the append and the append commits before the slot can accept another operation. Distinct request IDs cannot both advance one slot from the same prior revision. On restart, resolve an entered request against its exact derived fact before reporting success. An absent fact is not proof of a successful change. An incomplete or unreadable slot index cannot accept a fresh mutation. Derive the stored fact identity from the original request. A durable append followed by an interrupted acknowledgment recovers against that exact fact before deciding the retry. If the effect cannot be proved, return outcome-unknown and preserve the prior accepted identity. Verify older clients ignore the new optional projection.

## Telegram boundary

The Telegram Bot API changes the bot's reaction, with up to one assigned reaction per message. It may redirect an album item to a different item. Therefore a personal App reaction cannot be mirrored as though it were that person's Telegram reaction, and an album item cannot claim exact-target mirroring. A later bridge may offer a separately named bot-authored reaction only with verified physical chat and message provenance, known non-album eligibility, current holder authority and a provider acknowledgment. App storage and provider outcomes remain independent. No Telegram reaction call or provider mutation is included in this increment.

Source: https://core.telegram.org/bots/api#setmessagereaction

## Acceptance

Cover authenticated add, replace, clear, same-request replay, changed-payload conflict, two devices of one actor, different actors, stale revision, old exact target beyond the visible page, target denial, sender revocation, disabled configuration, owner move and restart after append. Race different desired values at revision 0 across two devices of the same actor. Require exactly one revision-1 fact, one success and one conflict with the winning value. Then verify that an older add acknowledgment after a newer clear cannot restore the emoji. Drop the response from a no-op clear at revision 0, add an emoji, and retry the clear. It must still acknowledge revision 0 without changing the revision-1 value. Race a reused request ID across two different events and require exactly one fact, one success and one payload conflict. Confirm an update cannot add transcript activity, expose restricted content, wake a conversation, or dispatch an agent. Cover substantive production wiring before release and test the real native controls before enabling.
