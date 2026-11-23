---
title: Explain Verified Replies Without A Duplicate Follow-Up
tier: 1
eli16-overview: docs/specs/profile-reply-context-followup.eli16.md
approved: true
approved-by: Echo under project approval 147024 and Chief assignment b30e0d07; narrow communication data and delivery-receipt repair, no consent authority change
---

# Problem And Evidence

DF-0010 and feedback fb-13ee6ade-536 retain a controlled demo finding. Actual user-role message364 was a native reply to question363. Its text was “1) yes”, so the existing exact-yes protocol applied nothing. The agent read the complete server-provided context at05:04:59Z, including the explicit fact that the person replied to an existing question. It sent registered reminder366, then falsely said in367 that the answer was not a direct reply and repeated the approval instructions. The transcript observation is preserved privately without exporting raw handles or credentials. A missing read is not the established cause; the consumer failed to ground its follow-up in the facts it had received.

# Scope And Contract

Keep the existing authenticated owner, native receipt, exact text, current consequence, deadline, placement and application checks unchanged. Do not add a semantic consent judge or a general outbound suppression gate.

The existing verified reply-context producer will expose explicit structured native-reply facts before the long question data, including the actual inbound and replied-to message IDs and whether the original text is the exact existing yes form. Those are diagnostic facts, not a grant. Unknown, forwarded, unauthorized, stale or unmatched context still supplies no verified-question information. An exact wording fact alone never certifies application.

After an existing question or reminder API has obtained a positive platform delivery result and run its receipt-registration callback, its additive response will expose the actual message receipt, whether that receipt remains registered to the request, and that this operation applied no settings. Only a confirmed, still-registered question may be presented to the agent as the completed user-facing response. If registration is no longer current, the result must say to check status rather than claim a live approval request. Transport uncertainty supplies no positive delivery receipt or completed-response claim.

The runtime context and Telegram awareness will explain this operation-specific workflow: read the verified facts before composing; use conversational judgment to select the registered reminder when appropriate; its confirmed registered delivery fulfills this turn's relay requirement, so do not send another approval question, reminder or invented failure explanation. This is an evidence-bearing operation contract, not a filter on other agent messages or later progress updates.

No new input fields, permissions, persistent intent, retry loop, timer, owner-turn allowance or configuration flag are introduced. Existing question and reminder request bodies remain compatible. The new fields are additive output data built only from server-owned records and actual delivery results.

# Verification

Add meaningful unit regressions for an identified non-exact answer, the exact wording boundary and unknown/forwarded/wrong-owner/stale contexts. Exercise actual HTTP success, unknown delivery and lost-registration response facts. Extend the production-composition lifecycle wiring check so the incoming text reaches the verified context producer. Repeat the controlled Telegram case and inspect actual native reply IDs and all visible follow-ups; a static string assertion alone does not prove the agent's behavior. Preserve failed attempts and report any remaining extra or false explanation honestly. Complete verification and safe merge use the normal throughput queue; no full suites are run manually.

# Reversibility And Limits

This is a reversible communication-data repair. It does not change an apply decision or durable profile data. Rollback removes the new facts/receipt fields and awareness, returning to the existing protocol. A model may still ignore supplied facts, so a clean live exercise is required before claiming the observed defect is repaired. Any need for a general reply-completion controller or outbound guard is a separate design decision, not silently added to this slice.
