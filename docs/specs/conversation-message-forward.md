---
title: App Message Forwarding
slug: conversation-message-forward
author: echo
status: approved
approved: true
approved-by: echo under standing build approval and Chief of Staff handoff be52c553 for default-off App server scope
parent-principle: Operator-Surface Quality
tier: 2
review-convergence: "2026-11-25T13:43:02.098Z"
review-iterations: 6
review-completed-at: "2026-11-25T13:43:02.098Z"
review-report: "docs/specs/reports/conversation-message-forward-convergence.md"
cross-model-review: "cross-model-review: codex-cli:gpt-6.2-astra"
---

# App Message Forwarding

The first candidate copies an explicitly selected plain-text message into another App conversation. The toggle starts off. The client explicitly confirms a destination, keeps its existing composer draft intact, and sends only identifiers. The server resolves the source text. Attachments, remote machine custody and bridged destinations need separate acceptance before support.

## Admission

Use a device-signed POST to the destination App conversation with source conversation ID, exact source event ID and request ID. Reject unknown fields, a same-conversation destination, absent or ambiguous events, and sources without eligible plain text. Mask unreadable and missing source messages alike. Require current destination send access independent of source access. Recheck both immediately before acceptance after any asynchronous work. Require one current machine with durable custody for the destination and authoritative visibility for the source.

The forward includes the permitted source text and marks it as forwarded. Apply configured inbound credential masking, then strip authority tokens. A blank result is unavailable. Keep the server-side provenance separate from the displayed message. The forwarded text grants no permission to open the original. Accept the copy through the explicit Forward operation described below. Verify the command boundary in normal server wiring.

## Retry

Bind the actor, source conversation and event, and destination to the request before durable acceptance. Reject changed-payload reuse. Retry the same signed intent after disconnect. Before acceptance, validate current permissions and require the original again. After acceptance, replay only the recorded result to an actor whose signed request still passes destination authorization. Do not re-read or return source content to reconstruct a response. A reservation whose acceptance cannot be proved must fail closed until recovery determines its outcome. The implementation must show that concurrent retries and restart cannot dispatch twice.

## Acceptance cases

Cover hidden capability when disabled, exact selection, unreadable and removed originals, destination write revocation before persistence, simultaneous and post-restart retries, changed source and destination reuse, and copied Stop text with no Stop effect. Confirm that a destination reader without source access receives only the copied projection and cannot open the original. Run signed HTTP and production-wiring checks before handing the client a tested fixture.

## Related work

- [Message actions](conversation-message-actions.md) defines the forwarding milestone.
- [App replies and message links](conversation-replies-message-links.md) covers exact targets and signed acceptance.
- [Inbound delivery custody](inbound-delivery-sacred.md) covers durable acceptance and uncertain outcomes.

## Content and delivery boundary

The ordinary send pipeline has both an exact Stop check and a semantic classifier that can pause or terminate work. A Forward request must enter neither branch. Its signed body proves the operator chose an exact source and destination. It does not prove the operator authored the source text or asked the agent to carry out instructions in it.

For the first candidate, accept the forwarded copy as a durable destination history event. Do not enqueue it into the destination agent session, including indirectly as pending session context, through the next session bootstrap, or through context-budget reconciliation. This keeps imported text from inheriting the operator's command authority. Give the destination event its own identity and a presence-only forwarded marker. Keep source identities out of destination history, exact-context and preview payloads. Appending the event is the completion boundary for this slice. A later increment may introduce delivery to the agent with explicit treatment as quoted, untrusted context.

In tests, use recognizable text from the fixture source. Assert that the new event appears exactly once in destination history and never appears in source history as a new occurrence. Assert zero changes to session dispatch, pending context, and emergency or pause state. Reopen the request ledger between copy and retry, then repeat the request and verify the same destination event ID. After forwarding, send an ordinary message in the destination and inspect its actual bootstrap context. The copied text must be absent and earlier ordinary history must still fit. An explicit Reply to a forwarded copy can attach that target to client history. Agent dispatch contains only the new text, and the copy stays out of bootstrap context. Check both live context-budget writes and reconciliation from the persisted history projection.

## Frontloaded decisions

The device signs the destination path and a body containing exactly `custodianMachineId`, `sourceConversationKey`, `sourceEventId` and `requestId`. Receipt success returns only the destination event and message IDs. The retry key is scoped to the authenticated person and immutable destination custodian under a distinct operation namespace. The client keeps a retry on its original paired machine, named by the signed custodian field and preserves the complete original intent. The request digest binds that person and both conversations plus the exact source event. A reserved intent may be settled after restart only when its exact durable destination event independently proves that the copy was accepted. Unknown acceptance returns an explicit unknown result. It never results in a second append. A reservation with no matching event remains unknown for the request lifetime. Absence in the index alone cannot prove a failed append. Each transport attempt is freshly signed over the identical path and body.

## Decision points touched

| Decision | Classification | Authority |
| --- | --- | --- |
| Actor and exact target admission | invariant | Device authentication, current People policy, unique authoritative event and live conversation; identifiers carry no authority. basis: irreversible-consequence; evidence: an unauthorized copy discloses source text to destination readers. |
| Destination write and replay | invariant | A new write requires current read and send permission for the live destination. Current destination read permission admits a metadata-only replay. basis: irreversible-consequence; evidence: acceptance permanently adds content to another conversation. |
| Write custody | invariant | Both conversations must be authored by this machine and still be served here before a write. The active serving lease and durable creation facts supply independent checks. basis: external-constraint; evidence: AppConversationService serves and the per-machine request ledger define the exclusive writer. |
| Content projection | invariant | Plain text only, using the existing credential-redaction policy. A Forward never calls the Stop handler, semantic classifier, dispatcher or provider adapters. basis: enumerable-domain; evidence: the first slice has one eligible event projection and no command or provider path. |
| Recovery | invariant | The request ledger and exact persisted destination event jointly prove acceptance. Read or index failure yields an unknown outcome once an entered reservation is known. basis: irreversible-consequence; evidence: guessing whether acceptance occurred can create a duplicate destination history row. |

## Multi-machine posture

Accepted destination history uses the App conversation journal and existing merged read path. In the first dark slice, a write requires the immutable creation custodian and current serving ownership of both conversations on the same machine. This restriction makes request recovery single-writer and prevents stale source replicas from authorizing copies. A move carries the accepted history through replication. The dedicated forward-copy wire kind keeps copies distinct during replication. Before enabling, confirm rejection on the older decoder and support on every participating reader. It cannot authorize a replacement machine to reacquire an in-flight reservation. The default-off switch disables the entire route, including receipt replay. Re-enable on the original custodian to recover an earlier receipt.

## Maturation plan

- **test-agent-live:** Explicitly enable on an isolated test agent and run signed phone, retry, read denial, command isolation and peer compatibility checks.
- **dev-agent-live:** Enable on the development agent only after complete candidate verification and an actual native menu acceptance run.
- **fleet:** Remain default off until release review verifies the compatible-reader floor and native evidence across supported clients.
- **graduation criterion:** Prove exact new and older sources, a destination-only reader, retry custody through restart, and absence of copied text in the next session. Check the prior decoder rejects the dedicated wire event and continues processing normal events.
- **dark-window:** Review this project card within 14 days of merge. Record the failed criterion and the next review date if the feature is still dark.
- **ladder:** mobilePairing.native
