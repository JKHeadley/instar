---
title: "One verified request authorizes one exact Threadline send"
slug: direct-threadline-send-consent
author: Echo
status: draft
tier: 2
---

# One verified request authorizes one exact Threadline send

CMT-2279. Draft for implementation review. The November 23 incident asked for a standing grant even though the owner had directly requested one delivery. The fix should cover one concrete delivery to a currently paired recipient.

The server resolves an authenticated owner-origin message from an existing durable source record. A copied quote, peer message, forwarded message, or an agent summary cannot stand for the owner. Resolve the requested paired recipient to its accepted immutable identity, and bind the exact normalized message and attachment digests, sending agent, owner, source message, destination thread or recipient, and expiry. If the wording cannot unambiguously authorize the concrete payload, allow the current approval flow to present it. An interpretation can narrow the request and must not establish new authority.

Consume once at the Threadline send boundary under a unique logical send ID. Use the existing delivery receipt to reconcile ambiguous transport outcomes. A retry with the same binding may return the existing receipt and cannot produce a second delivery. A changed recipient, material payload change, disabled pairing, unknown owner, or unrelated send returns to the ordinary gate. A hard denial or existing outgoing content restriction still applies. The resulting receipt identifies the direct verified request as the approval source and grants no later send.

First proof uses two disposable paired agents and an authenticated synthetic owner request. Verify exact-in-scope delivery, duplicate retry, changed payload or recipient, revoked pairing, unknown send outcome, and a quoted or agent-relayed request. Keep production behavior off until the send admission owns the one-use claim and the destination receipt path is verified.

## Admission and execution

The existing operations evaluation distinguishes an explicit refusal from an ask. Evaluate the explicit refusal and the current holder before considering direct authorization. The existing `/operations/evaluate` route takes a caller-supplied `userRequest`; that input is contextual text and cannot supply owner provenance. Resolve the owner message server-side from its durable origin and session context. The initial pilot uses the current holder and its own verified outbound operation only.

Keep the one-use claim separate from the advisory gate response. The effect boundary is the typed submit path that enters the existing Threadline send funnel, including its receiver pin, policy checks and outbound trace. A dry decision or an abandoned evaluation never spends the claim. The final send checks the exact operation binding and durably reserves a stable delivery ID before any transmission. Loss of the receipt does not authorize a second transmission. Recovery reads from the existing transport receipt when verifiable and returns unresolved otherwise.

## Multi-machine posture

Bind the claim to the verified accepted sender generation and a current serving writer. Route a readback to that authority and permit successor recovery only when the same durable claim and exact delivery receipt are available. A remote request cannot reconstruct the claim from a model summary or a generic tool decision. No older caller gains new authority. This pilot is dark until the exact direct receipt and mixed-version refusal are tested.

## Decision points touched

- Verified owner message, paired receiver and exact payload — invariant, based on existing accepted identity and durable origin records.
- Semantic ambiguity — judgment within an existing authenticated request. If a meaning cannot be safely narrowed to this send, keep the ordinary confirmation.
- Durable one-use effect — invariant, based on the shared send reservation and exact transport receipt.

The dormant SQLite reservation uses the canonical owner message reference as the uniqueness key within the agent and owner. Changing the epoch or proposing a new delivery ID cannot spend that same message again. Only a newly committed reservation permits a transport attempt. An exact retry can consult the original transport receipt after expiry. Before mounting, use a crash-durable database owned by the current serving writer, and require successor access to the same reservation history.
