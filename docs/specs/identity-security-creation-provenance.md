---
title: "Each owner request counts for what it asked: a new conversation records why it exists, and a change to it carries the owner's request for that change"
slug: identity-security-creation-provenance
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-creation-provenance.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Verify the State, Not Its Symbol; Bounded Blast Radius"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §6 (who is speaking) and §12 item 1 (quick fixes); bug fb-ac3d2e79-2a4 (Justin, topic 130715, 2026-11-18 13:36 PST)"
lessons-engaged: "verify-the-state-not-its-symbol, fix-the-class-not-the-instance, blockers-not-falling-means-cut"
review-convergence: "2026-11-19T05:45:00Z"
review-iterations: 5
review-completed-at: "2026-11-19T05:45:00Z"
review-report: "reports/identity-security-creation-provenance-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) rounds 1 to 5"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST), section 6 (who is speaking) and section 12 item 1 (quick fixes); the bug is Justin's own report fb-ac3d2e79-2a4 (topic 130715, 2026-11-18 13:36 PST), taken into this plan in topic 10000002852. No constitution change."
---

# Each owner request counts for what it asked

## Problem statement

Justin, 2026-11-18 13:36 PST (topic 130715): "We should have strong mechanisms for tracking where actions and approvals come from, and there should be no question that the session was started with my approval."

What happened:
- At 13:00 he approved a separate conversation in topic 130715.
- The agent created topic 145097 and a session in it.
- At 13:14 he asked for the new topic to be pinned to a model. The request was refused with `no-bound-operator` (`topicProfileWriteSurface.ts:737`).

A topic learns its operator only from the first message typed in it (`TopicOperatorStore.setAuthenticatedOperator`, minted by the Telegram ingress). A topic the agent creates has no operator and no record of why it exists, until the owner types there.

Two separate requests were involved, and each needs to count on its own:
- the request to **create** the conversation (13:00);
- the request to **change** it (13:14).

Four review rounds settled the shape (earlier drafts kept in the build folder as `creation-provenance-v2-design.md` and `-v4-design.md`):
- letting the creation request stand in for the change is wrong;
- quoting the owner's words into a conversation others might see is wrong;
- a model's yes must not be what grants authority (the umbrella's no-model-gate lesson);
- a message found in the log is weaker evidence than a live, authenticated one, because the log also takes rows over HTTP.

## Proposed design

### 1. A change to another conversation is confirmed by the owner where they are

This uses the existing §10.1 propose lane, which is already reviewed:
- the agent composes an exact change;
- the server renders it in plain words and posts it;
- the owner's own "yes", recognized by the Telegram ingress from an authenticated, non-forwarded message newer than the proposal, applies exactly that change.

Today the proposal is posted in, and confirmed in, the destination conversation itself. So in the reported case the owner would still have had to type in the new conversation.

**The new field.** `POST /topic-profile/:B/propose` accepts `confirmIn: A`, the conversation where the owner asked.
- **The proposal goes to A:** "For the conversation "<B's name>": <the server's rendering of the change>".
- **The confirmation slot is armed in A,** carrying B as its target.
- **The owner's "yes" in A** applies exactly the armed change to B, with the owner as the principal (`crossTopicConfirm`).
- **The audit** names A (`authorizedBy: owner-confirmed-in:<A>`).
- **The yes can only answer the proposal.** A is a busy conversation, so any message the agent sends into A after the proposal disarms it. The owner's next "yes" could be answering that message instead, so the agent proposes again if it still wants the change. The proposal names the other conversation ("Proposed change for the conversation "<B>" (not this one):"), with quotes and line breaks stripped from the name, and says so when it replaces an earlier proposal.
- **Fields.** A cross-conversation yes may change the engine (framework), model, model tier, thinking mode and effort. HTTP and the write surface share `CROSS_TOPIC_FIELDS`; escalation override and message-origin display still require confirmation in that conversation itself (400 otherwise). The owner-framework-confirmation repair was authorized by Chief07621898 and clarified by7f93807c: retain the existing exact-change echo and typed yes, without adding an inline button.

No model decides authority and no logged message is cited. The authority is the owner's live yes to the exact change they were shown.

**Where a yes may reach** (`crossTopicEligible`). This is checked when the proposal is armed and again when the yes arrives, so a change in between stops the write:
1. **The confirmer is the owner.** A's verified operator (when arming) and the confirming sender (when the yes arrives) are the agent's configured owner, the Telegram `ownerUserId` the 1e sender-authority work established (`source-not-owner`). When the signed owner record exists (piece 2), its owner channel replaces this.
2. **A is the owner's own conversation.** It is not shared with team members in the team record, and an unreadable record counts as shared (`source-shared`). The proposal names B and the change inside A, so everyone who can read A must be entitled to see that.
3. **B is a known Telegram conversation,** with the operator store readable (`destination-unknown`).
4. **B is unbound, or verified-bound to that same owner.** A binding to anyone else, or an unverified or imported candidate binding, refuses (`destination-bound`).
5. **B is not confined to a team member.** The team record answers "confined" (`destination-confined`) or can't be read (`destination-unknown`); only a definite "not confined" passes.

A refusal at arm time is a 422, and nothing is armed. When the owner asked in A and it is B that can't be reached, the owner is also told in A, in plain words ("I can't change the conversation "<B>" from here: …"), because a refusal stays a refusal for the person who asked, not only for the agent. The notice is sent at most once per (A, B, reason) every 10 minutes. A refusal when the yes arrives is answered in A in plain words ("I didn't make that change: … You can say yes in that conversation instead."), and nothing is written.

**The switch.** `confirmIn` ships behind the umbrella's per-piece switch, `security.crossTopicConfirm.enabled`, on the development-agent gate: live on a development agent, dark on the fleet until graduation (registered in `devGatedFeatures.ts`). The switch is re-read when the yes arrives, so turning it off between the proposal and the yes stops the write.

**Delivery.** An armed exact-change proposal uses the registered in-process `profile-confirmation` producer and the existing bounded `owner-decision` category, so Quiet by Default delivers it in its addressed conversation. A failed or quiet delivery disarms the unseen slot. Without `confirmIn`, the proposal remains in its own conversation with the same confirmation rules. The ordinary write route is unchanged too: an agent-token write to an unbound topic is still refused.

### 2. A new conversation records which message the agent linked it to

`POST /telegram/topics` accepts an optional `onBehalfOf: { topicId, messageId }`, a message the agent links as the reason it created the conversation. It is identity-checked (`checkCitation`):
- the source topic's verified operator is the configured owner;
- the message is found by id in that topic's log, within 24 hours and a 16 MB read budget;
- it is not forwarded, is human-authored, is not relayed, and is not from a team phone or the app.

A failed check creates nothing (422).

`state/topic-creation-provenance.json` keeps one row per newly created topic:
- **the source:** `linked-message` (topic, message id, the source operator's id, time) with `authorship: 'unverified'`, or `source-unknown`;
- **the session the caller named,** marked `sessionAsserted` (the caller says it, nothing verifies it);
- **the time.**

**The wording claims no approval and no authorship:** the row says the agent linked this message, marked unverified, never that the owner wrote it or approved the conversation or a session in it. Proving the owner approved starting a conversation would need a live owner decision bound to that creation (the same propose-and-yes shape), which is piece 5's receipts work. A later reuse of the same topic is appended as an event, and the original row is kept. Rows are machine-local and kept: the agent doesn't delete Telegram topics, so the file grows with the number of conversations.

**What it grants: nothing.** It is never posted into a conversation, so no quote reaches any audience. `GET /topic-creation-provenance/:topicId`, on the agent token, returns ids and times only.

### 3. Telling the agent

An awareness entry says:
- when the owner asks in one conversation for a change to another, propose it with `confirmIn` set to the conversation they are in, then let them answer yes;
- when creating a conversation the owner asked for, link the asking message as `onBehalfOf`.

## Known limits

- **Proposing depends on the agent.** If the agent writes instead of proposing, it gets today's refusal. Nothing is approved falsely. Capturing operations automatically at the owner's turn belongs with piece 5 (receipts on every action).
- **A linked message is the agent's claim, checked for identity only.** The log also accepts rows over HTTP, so a linked message is evidence of who wrote it, not proof of intent. That's why it grants nothing.
- **Machine-local.** The confirmation slot lives on the machine that serves the owner's conversation, as the propose lane's does today, and the creation record lives where it was written. Replicating creation facts belongs with piece 5.
- **Which sends disarm a waiting proposal.** Text and file messages through the adapter's topic sends do. A few button-message sends, and any send made from another machine, don't reach the slot. A yes after one of those still has to be newer than the proposal (the lane's ordering rule), and the owner sees the proposal's own words.
- **Where the write runs.** The cross-conversation write runs on the machine serving the owner's conversation, the same machine today's propose lane writes from. Routing topic-profile writes to the machine that holds B's conversation is a change to the whole topic-profile surface. It is not made here.

## Floors

- **The yes must answer the latest proposal,** within its time limit (the propose lane's existing rules: newer than the echo, not forwarded, 5 minutes).
- **24 hours and 16 MB** for a linked message lookup: a conservative default. Running out of budget is its own refusal.

## Decision points touched

- **A change confirmed in another conversation:** the owner's live yes in A to the server-rendered change, B eligible when the proposal is armed and when the yes arrives. invariant; basis: irreversible-consequence (who may change a conversation); evidence: fb-ac3d2e79-2a4 and four review rounds (no model as authority; log rows forgeable).
- **The creation record:** a link only, grants nothing, never posted. invariant; basis: external-constraint (audiences); evidence: the Astra reviews of v2 to v4.

## Multi-machine posture

As stated under Known limits. Peers see no new authority, and their operator rows are unchanged.

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | On a throwaway with the Telegram shim: the owner asks in topic A for a new conversation, and the agent creates B linking that message; the record says so. The owner asks in A for a model on B. The agent proposes with `confirmIn: A`, the proposal appears in A, and the owner's "yes" in A sets B's model before anyone types in B. Refused: a yes from a team member, a forwarded yes, a yes after B was bound to someone else, B confined to a member, and a stale yes. Device approval and owner buttons in B still need the owner's first message there. | revert |
| dev-agent-live | On Echo with the release, before Justin is told: I drive it myself through the real Telegram surface (my Telegram browser profile in a test conversation of Echo's group). A proposal in one conversation, the yes there, the change applied in another. Then the refusals (a conversation run by someone else, a stale yes). Only then is the next real request of Justin's served this way. | the switch off |
| fleet | The gate's fleet default flips through its own reviewed change, after graduation. | the switch off |

## Tests and evidence

- **Unit:**
  - `crossTopicEligible`: each of the five checks both ways;
  - the switch: refused when dark, registered in the dev-gate wiring test;
  - the confirmation slot carrying its target;
  - the write surface allowing an operator write to an unbound topic only with `crossTopicConfirm`, and auditing it;
  - `checkCitation` both ways, including the log refusals;
  - the creation record: `source-unknown`, reuse appended, the asserted session.
- **Integration:** through the real router, `propose` with `confirmIn`:
  - posts the proposal to A and arms A with target B;
  - is refused for a non-owner A, a B bound to someone else, and a candidate binding on B, with the owner told in A when B is the problem;
  - is refused (503) while the switch is dark.
- **E2E lifecycle:** the record route answers, and `confirmIn` is refused by name through the production wiring.

## Maturation plan

- **ladder:** security.crossTopicConfirm
- **stages:** test-agent-live → dev-agent-live → fleet, on the development-agent gate `security.crossTopicConfirm.enabled` (umbrella §10's per-piece switch). Each step is recorded in the build folder with its date and outcome.
- **test-agent-live:** the throwaway proof above.
- **dev-agent-live:** my own real-Telegram proof on Echo, then Justin's first real use, with no defect found by him.
- **fleet:** the gate's fleet default flips through its own reviewed change, after graduation.
- **graduation criterion:** both stages pass with no operator-found defect, and every refused cross-conversation yes in the dev window is explained in the build folder.
- **dark-window:** `confirmIn` is dark on the fleet until graduation. The creation record ships on for everyone, because it grants nothing and changes no behaviour.

## Open questions

None.
