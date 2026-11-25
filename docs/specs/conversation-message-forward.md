---
title: App Message Forwarding
slug: conversation-message-forward
author: echo
status: draft
tier: 2
---

# App Message Forwarding

The first candidate copies an explicitly selected plain-text message into another App conversation. The toggle starts off. The client explicitly confirms a destination, keeps its existing composer draft intact, and sends only identifiers. The server resolves the source text. Attachments, remote machine custody and bridged destinations need separate acceptance before support.

## Admission

Use a device-signed POST to the destination App conversation with source conversation ID, exact source event ID and request ID. Reject unknown fields, a same-conversation destination, absent or ambiguous events, and sources without eligible plain text. Mask unreadable and missing source messages alike. Require current destination send access independent of source access. Recheck both immediately before acceptance after any asynchronous work. Require one current machine with durable custody for the destination and authoritative visibility for the source.

The forward includes the permitted source text and marks it as forwarded. Resolve text using the ordinary outbound content protections and keep the server-side provenance separate from the displayed message. The forwarded text grants no permission to open the original. Accept the copy through the explicit Forward operation described below. Verify the command boundary in normal server wiring.

## Retry

Bind the actor, source conversation and event, and destination to the request before durable acceptance. Reject changed-payload reuse. Retry the same signed intent after disconnect. Before acceptance, validate current permissions and require the original again. After acceptance, replay only the recorded result to an actor still allowed to access the destination. Do not re-read or return source content to reconstruct a response. A reservation whose acceptance cannot be proved must fail closed until recovery determines its outcome. The implementation must show that concurrent retries and restart cannot dispatch twice.

## Acceptance cases

Cover hidden capability when disabled, exact selection, unreadable and removed originals, destination write revocation before persistence, simultaneous and post-restart retries, changed source and destination reuse, and copied Stop text with no Stop effect. Confirm that a destination reader without source access receives only the copied projection and cannot open the original. Run signed HTTP and production-wiring checks before handing the client a tested fixture.

## Related work

- [Message actions](conversation-message-actions.md) defines the forwarding milestone.
- [App replies and message links](conversation-replies-message-links.md) covers exact targets and signed acceptance.
- [Inbound delivery custody](inbound-delivery-sacred.md) covers durable acceptance and uncertain outcomes.

## Content and delivery boundary

The ordinary send pipeline has both an exact Stop check and a semantic classifier that can pause or terminate work. A Forward request must enter neither branch. Its signed body proves the operator chose an exact source and destination. It does not prove the operator authored the source text or asked the agent to carry out instructions in it.

For the first candidate, accept the forwarded copy as a durable destination history event. Do not enqueue it into the destination agent session, including indirectly as pending session context. This keeps imported text from inheriting the operator's command authority. Give the destination event its own identity and a presence-only forwarded marker. Keep source identities out of destination history, exact-context and preview payloads. Appending the event is the completion boundary for this slice. A later increment may introduce delivery to the agent with explicit treatment as quoted, untrusted context.

In tests, use recognizable text from the fixture source. Assert that the new event appears exactly once in destination history and never appears in source history as a new occurrence. Assert zero changes to session dispatch, pending context, and emergency or pause state. Reopen the store between copy and retry, then repeat the request and verify the same destination event ID.
