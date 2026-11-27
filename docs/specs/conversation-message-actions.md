---
title: Message Actions In App Conversations
slug: conversation-message-actions
author: echo
status: draft
approved: false
tier: 2
parent-principle: "Operator-Surface Quality"
card: wc_4d8dd0e0144b636e
eli16-overview: docs/specs/conversation-message-actions.eli16.md
---

# Message Actions In App Conversations

An App conversation should offer Reply, Reactions, Forward, Delete and Copy Message Link alongside the actions the client already supports. Every action acts on the selected message occurrence. Each increment starts off and is enabled only after its own acceptance checks.

## Milestones

1. **Exact message and permanent link.** Bring the prepared App-link draft and its review evidence forward first. Resolve a signed, opaque App conversation and message identity against stored history under current message-level access. An exact deep link opens older messages without a sequential scan, leaves drafts intact and does not advance read position for unseen messages. The URL carries neither authority nor message text. Keep the link stable across holder changes where the existing authenticated routing can locate the relevant replica. Report unavailable when it cannot.
2. **Reply.** Build on the existing quoted-reply prototype and the stable message identity. Store the target identity with the reply. Render or deliver quote text only when the reader or destination still has permission to see it. Give the client a capability and retry outcome that distinguish a preserved quote, an explicitly requested unquoted send and a refusal. A retry cannot send a second reply.
3. **Reactions.** Represent one currently authorized person's desired reaction state for the exact message. The first client and server agreement must define supported emoji, whether more than one is allowed, and the update and clear contract. Use authenticated identity, existing replicated ordering and an idempotent operation identity. A reaction does not become conversation text or trigger an agent response.
4. **Forward.** Require a deliberate destination and independently check source-message read permission plus current destination send permission immediately before persistence. Copy only the permitted projection and keep provenance. Establish attachment custody before presenting the forward as complete. The recipient must not gain access to a source link or quote it was never authorized to read. Reuse durable send acceptance for retries.
5. **Delete.** Define who may remove an individual occurrence and what happens to quoted metadata, exact hyperlinks and attachment references. Use the existing conversation owner and message author rules with an explicit action rather than inferring authority from a visible menu. Settle local deletion durably before reporting completion. Deletion on a bridge must report the actual remote outcome and preserve pending custody after ambiguous provider acknowledgement.

## Telegram bridge

A bridge operation must resolve the exact originating or mirrored Telegram occurrence through an existing verified mapping. Topic IDs alone cannot identify a message. Every mutation is separately admitted against the current holder and the platform's authority for that action. Use the existing bridge delivery journal and idempotency policy for outbound mutations. Report local and Telegram outcomes separately when they diverge. An absent mapping, unavailable bridge or unknown remote acknowledgement cannot redirect the action to another message, silently replay it, send substitute text or imply global deletion. The provider capability and missing-permission cases must be grounded before each increment is approved.

## Client coordination and acceptance

The Apple app owns its native context menu and presentation. For each increment agree the signed route, request shape, additive capability marker, expected retryable and terminal responses, and what the client displays on old servers before integration. Keep current Copy Text, Select, Pin and card behavior available. On Mac, open the menu without network work and capture the paired server, conversation and settled message identity only on selection. Preserve composer, attachments, focus and scroll on link resolution. Test exact lookup, inaccessible and deleted targets, signed owner and permitted non-owner cases, revocation across awaits, retry, concurrent updates, and the normal AgentServer boot path. Throughput owns full verification. Activation requires the real client journey and, where applicable, an authorized Telegram bridge test.

## Related work

- [App message links](conversation-message-links.md) defines the initial exact lookup and current access boundary.
- [Inbound delivery custody](inbound-delivery-sacred.md) defines durable acceptance and uncertain delivery outcomes for sends.
- The branch's quoted-reply design and foundation reports record the existing compatibility, ordering and recovery evidence.

## Current disposition

Milestone order and contracts are a draft. No action route, platform mutation, client promise or activation is approved by this checkpoint.
