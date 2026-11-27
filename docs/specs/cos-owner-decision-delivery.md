---
title: "Owner decisions are delivered: Quiet by Default must not hold a button only the owner can answer"
slug: cos-owner-decision-delivery
author: echo
parent-principle: "Signal vs. Authority"
eli16-overview: docs/specs/cos-owner-decision-delivery.eli16.md
origin: "fb-38393403-8e0; found in the live check of PR 3247 on 1.3.1860, 2026-11-16 22:14 PST"
tier: 1
approved: true
approved-by: echo-chief-of-staff (maintainer, not constitution text)
approved-at: "2026-11-17T06:25:00Z"
approval-source: "agent message f09e5a62-4668-4471-9a18-7f9bbd3e2993 from session echo-chief-of-staff, 2026-11-16 22:25 PST: 'Approved, build it tonight via /instar-dev: protected in-process owner-decision category, never settable from request metadata, always delivered (like pairing-outcome)'"
---

# Owner decisions are delivered

## 1. Problem

Quiet by Default (`NotificationSelectivityGate`) records every automated Telegram send that carries no deliverable category in the quiet feed instead of sending it. `TelegramAdapter.sendOfferList` sends through `apiCall('sendMessage')` with no envelope, so the gate reads it as `uncategorized` and answers `quiet-default`. The send then returns `null`.

Every unstamped `sendOfferList` caller is a message whose buttons only the owner can answer:

- the Chief of Staff note with Unpark / Confirm-done buttons (`note-with-buttons-failed`),
- the Chief of Staff owner-pause ask (PR 3247), which answered `503 send-failed`,
- the machine-maintenance enrolment offer (PR 3273).

On Echo, 40 such sends to the Chief of Staff topic were recorded quiet between 2026-11-16T20:06Z and 06:14Z. The owner never saw them, so none of those decisions could be made.

Quiet by Default exists for reports: job and agent output, chosen per job (operator decision 2026-11-06). A button only the owner can answer is a decision, not a report.

## 2. Design

1. A new notification category `owner-decision` ("Decisions only you can make"), registered in `notificationCategories` and in `PROTECTED_DELIVERY_CATEGORIES`. It is therefore never operator-configurable and never redirected to a push destination, the same as `pairing-outcome`.
2. `NotificationSelectivityGate.decide` delivers `owner-decision` (reason `owner-decision`), with a budget of 10 per topic per 10 minutes. Past the budget it records (`owner-decision-budget`), so a looping sender cannot flood the owner.
3. The only producer is `TelegramAdapter.sendOfferList`, which stamps `OWNER_DECISION_ENVELOPE` in-process, and only when the caller has not stamped an envelope of its own. Recommended services stamps its own envelope and keeps its current behaviour.
4. No request or route can set the category. Route envelopes come from `categoryForProducer`, whose map has no `owner-decision` entry. The push-preference route refuses protected categories.
5. The owner's private-chat path (`sendOwnerDMWithButton`) is unchanged. It already sends under `verifiedReplyEnvelope('verified-mobile-approval')`, which the gate delivers.
6. Owner-pause source floor: a marker whose date is not the cited message's UTC date (the date `findSources` writes) is refused with `date-mismatch`. A row with no readable timestamp keeps the earlier behaviour.

## 3. Decision points touched

| Decision point | Before | After |
|---|---|---|
| Quiet by Default on an unstamped offer list | record (quiet-default) | deliver (owner-decision), budget 10 per topic per 10 min |
| Owner-pause ask source floor | marker date not compared | wrong date refused (`date-mismatch`) |

Both are exact-fact checks with no judgment. The gate keeps all of its authority over reports.

## 4. Rollback

Revert the commit. Offer lists go back to being recorded quiet. There is no state, migration or record to undo.

## Maturation plan

Ladder: not applicable: a delivery rule inside the existing Quiet by Default gate, no new switch.

## Standards-Conformance Gate (POST /spec/conformance-check, 2026-11-17T06:30Z, 100 standards, not degraded)

- **Judgment Within Floors: possible violation.** The 10-per-topic-per-10-minutes budget could hold back a legitimate eleventh request. Answer: the budget is a deterministic floor against a looping sender, not a judgment. Past it, the message is recorded in the quiet feed, which the owner can see on the dashboard; it is not dropped. The bound sits well above every real producer: the Chief of Staff caps itself at 3 immediate messages a day, the enrolment offer is sent once, and a pause ask replaces the project's earlier ask. Accepted.
- **Parent-principle fit: weak.** The date check and the budget are exact-fact, hard-invariant checks (does the marker date equal the logged message date; how many offers this topic got in 10 minutes). Signal vs. Authority allows those to block. No heuristic or judgment holds authority here. The change also removes an authority, since the gate no longer quiets owner decisions. Accepted.
