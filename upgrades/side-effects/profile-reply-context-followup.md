# Side-Effects Review — Explain Verified Replies

## Summary of the change

Tier 1 reversible communication-data repair under Chief assignment b30e0d07. The change adds explicit diagnostic facts to existing verified question context and returns an actual delivered-message receipt after the existing question APIs have confirmed delivery and active registration. It adds no consent, mutation, suppression, retry or timing authority. The earlier bad explanation is preserved as DF-0010 and feedback fb-13ee6ade-536. The independent narrow plan and final source/artifact reviews found zero material findings. The final review independently passed six context cases and two HTTP negatives; it does not certify live agent behavior.

## Decision-point inventory

The existing owner, native receipt, audience, placement, deadline and consequence checks still select whether context can be disclosed. An additional string-type check refuses ungrounded wording facts. Exact wording is reported diagnostically and is compared with the existing protocol in tests; it does not apply anything. Existing active-delivery checks still decide whether an API success can claim that a question is registered. No application or owner-turn decision changes.

## 1. Over-block

An internal caller without the actual text now gets no verified question context instead of incomplete facts. All production callers supply the actual incoming text, and lifecycle tests cover that wiring. No ordinary message, later progress update, model choice or setting is filtered. The operation-specific relay guidance does not end unrelated work.

## 2. Under-block

A model can still ignore supplied facts. Explicit data and a positive receipt improve grounding but do not certify the agent's behavior; a real Telegram exercise remains necessary. A wording fact never proves application. A successful question response describes this operation, not the global state if another answer runs concurrently.

## 3. Level-of-abstraction fit

Native reply facts are produced at the existing verified context boundary. Delivery facts are produced in the actual send handlers after their current receipt checks. The conversational agent chooses whether a reminder is helpful. No generic reply controller, global output filter or new client body annotation is introduced.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md. These fields are server-owned signals. The literal wording comparison is a diagnostic of the retained exact-yes form; it grants no authority. The existing request manager remains the consent authority. Context instructions explain an already delivered operation rather than deciding that another unrelated message may not be sent.

## 4b. Judgment points

Conversational judgment remains responsible for interpreting the person's intent and answering ordinary questions. It must ground factual explanations in the verified native binding and inspect the actual operation result. Neither a text-supplied fact nor the new success fields are accepted as consent input.

## 5. Interaction with existing systems

The success fields appear only after requireTelegramDelivery and the existing active receipt check. Quiet, unknown and inactive delivery paths retain their current errors and have no completed-reply claim. Request IDs, old receipts, deadlines, delivery budgets, owner-turn reservation, profile writes, runtime fences, transfer and native lifecycle controls are unchanged. Existing callers can ignore the additive output fields.

## 6. UX self-check

The observed defect was a false extra explanation after a correctly identified but non-exact answer. The facts now distinguish those two concepts explicitly, and the operation tells the agent when the readable reminder has already been delivered. No additional user step, jargon in the reminder, confirmation rule or new approval is introduced. Static tests alone cannot establish a clean user experience; the failed original message and the new live result must both remain recorded.

## 7. Multi-machine posture

The context remains machine-local and bound to the current pending request, verified sender and native receipt. The new fields are output data, not replicated permission or durable intent. Cross-machine selection, restart restoration and App/Slack consent are unchanged and not certified here.

## 8. Rollback cost

Revert the metadata, context text and awareness entry through the normal release process. No new stored data or setting requires migration and no applied change is reversed. Earlier clients remain compatible because no request body field or existing success field was removed.

## Migration and agent awareness

A new src/data/awareness/profile-reply-context-followup.md uses the existing awareness registry, which reaches new and updated agents without editing custom identity files. Runtime per-message context reaches existing sessions after the server update. No configuration default, hook, persistent state or permission migration is added.

## Observability and verification

The returned questionDelivery.messageId is the same actual receipt recorded by the existing proposal-delivered audit event. No separate completion claim is created on failure. Meaningful unit reds (three missing-fact cases, then one malformed native-ID case) and the HTTP red (three failures with 45 passes) were retained before their repairs. Final focused results are 42 unit, 48 HTTP and 18 lifecycle cases, plus a clean production typecheck. These are separate overlapping files, not a full-suite result. The actual live follow-up remains required before release. Complete verification uses the normal throughput queue, never a manually run full suite.

## Class-Closure Declaration (display-only mirror)

```json
{"defectClass":"unbounded-self-action","closure":"n/a","reason":"This repair exposes existing verified reply and delivery facts. It creates no autonomous approval, send, retry, timer, mutation or suppression loop. Existing one-shot question delivery remains behind its current owner, receipt and budget controls."}
```
