---
title: "iMessage: an SMS that claims to be a contact is not that contact"
slug: identity-security-piece1eb-imessage-sms
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece1eb-imessage-sms.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Signal vs. Authority; Security Fixes Keep the Experience Whole; Safeguards Default On, the User Can Override; Bounded Notification Surface"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §12 item 1 (the 2026-11-17 audit gaps) and the piece-1 rollout row 'SMS origin: deny the unsupported authority immediately'"
split-from: "identity-security-piece1e (Telegram senders); first drafted as section 6 of identity-security-piece1b round 1"
lessons-engaged: "fix-the-class-not-the-instance, a-dark-guard-is-worse-than-no-guard, safeguards-default-on-user-can-override"
review-convergence: "2026-11-18T13:55:00Z"
review-iterations: 2
review-completed-at: "2026-11-18T13:55:00Z"
review-report: "reports/identity-security-piece1eb-imessage-sms-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) round 1"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\") and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# iMessage: an SMS that claims to be a contact is not that contact

## Problem statement

The iMessage adapter reads the owner's Messages database (`NativeBackend`) and admits a row when its sender is in `authorizedContacts` (`IMessageAdapter._handleIncomingMessage`). Each row carries a `service` (`iMessage`, `SMS`, `RCS`), and nothing reads it.

- **An iMessage handle is bound to an Apple account.** An SMS or RCS sender number is not: anyone can send an SMS that shows a contact's number. So an SMS "from" an allowed contact is treated as that contact. It starts or reaches a session (sessions have tools), is acknowledged, and is written into the message log.
- **Session bootstrap repeats it.** The context it builds from the same database (`getConversationContext`) also carries SMS rows into a new session as that contact's words.
- **The history route doesn't distinguish.** `GET /imessage/chats/:chatId/history` returns rows to any bearer caller with nothing marking which ones can prove their sender.

## Proposed design

### 1. Only an iMessage row proves its sender

- A row counts as from the contact it names only when its `service` is `iMessage` (case-insensitive). SMS, RCS, an empty value and anything else are **unproven**.
- An unproven row from an authorized contact is set aside right after the contact check, before anything else reads it:
  - it is not routed, does not start or reach a session, and gets no acknowledgement;
  - it is not emitted on the event bus;
  - it is not written into the message log;
  - it does not open the contact's reply window (`lastInboundFrom`). Otherwise a spoofed text would turn a later send into a "reactive" reply past the proactive-sends-off setting;
  - its attachments are never copied into the agent's folder. The backend skips the hard link for an unproven row, because a session can read that folder.
- The owner already has every one of these texts in their own Messages app. The agent does not re-deliver the words anywhere a session can read them.

### 2. The owner is told, once a day, without the words

- One attention item per agent per day: "N text messages (SMS) claimed to come from your contacts today. Your agent didn't act on them, because a text message can't prove who sent it. They're in your Messages app."
- It lists the masked numbers they claimed, at most 10, then "and N more".
- It is raised on the first unproven row of a day and refreshed when the count grows, at most once every 10 minutes. It carries no message text.
- **When iMessage is down,** the owner's own phone may fall back to SMS, so the owner's own texts land here too. The item says so: "If one was you, send it again as an iMessage."

### 3. Session context and history read the same rule

- **`getConversationContext`** leaves unproven rows out of a session's starting context. It adds one line: "(N text messages left out: SMS can't prove who sent them.)"
- **`GET /imessage/chats/:chatId/history`** keeps every row, since it serves the owner's history, but hides the text of an unproven row. The row says "(text message not shown: it can't prove who sent it; it's in the owner's Messages app)", and `senderProven: false` is added. Sessions can call this route, so a spoofed text's words must not reach them through it.

### 4. SMS-only contacts

- **Replies today.** The agent's replies and acknowledgements already go out only as iMessage (`imessage-reply.sh`, `IMessageAdapter` ack), so a contact who can only text can't hold a conversation with the agent today either. Refusing their texts' authority breaks nothing that worked.
- **A per-number list belongs in piece 4.** Letting the owner accept specific numbers over SMS needs a write path bound to the owner's own device, because the config API refuses `messaging` changes and an iMessage contact could ask a session to add "my other number". It is not built here.
- **The owner's own fallback texts.** When iMessage is down, the owner's phone may send SMS. Those texts are set aside too. The notice says to resend as an iMessage, or to reach the agent another way (its dashboard or the owner's chat with it) while iMessage isn't working.

### 5. Ships on

This ships on for every agent: the approved umbrella's piece-1 rollout table says SMS-origin authority is denied immediately. iMessage is opt-in and per Mac, and the rule stops only rows a stranger could have sent.

## Decision points touched

- **Only `service: iMessage` proves the sender** — invariant; basis: external-constraint; evidence: SMS and RCS sender ids are set by the sending network and are spoofable, while an iMessage handle is bound to an Apple account.
- **Unproven rows from contacts reach no session, ack, event or log** — invariant; basis: irreversible-consequence; evidence: sessions have tools.
- **Context leaves unproven rows out; the history route marks them** — invariant; basis: enumerable-domain; evidence: the `service` column.
- **The owner item: daily, at most 10 numbers shown, refreshed at most every 10 minutes** — judgment-candidate; floor: bounded and never silent, with the count always exact (the cap only limits how many numbers are shown) and every text kept in the owner's Messages app; arbiter: Echo.
- **No SMS acceptance in this piece** — invariant; basis: external-constraint; evidence: an SMS sender id proves nothing, and an owner-bound write path for a per-number list doesn't exist yet (piece 4).
- **Ships on at merge** — invariant; basis: external-constraint; evidence: umbrella piece-1 rollout row 'SMS origin: deny the unsupported authority immediately'.

## Frontloaded Decisions

1. The owner's own SMS fallback texts are set aside too, and the notice says to resend as an iMessage. An SMS can't distinguish the owner from someone using the owner's number.
2. No text goes into the item, because the item is readable by sessions (`GET /needs` carries detail text).

## Multi-machine posture

Each Mac reads its own Messages database, so the rule runs where the row is read (machine-local-justification: the database is per Mac). The owner item is per machine and merges with `?scope=pool`.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| Row sender | the row's handle | the named contact sent it | `service` is `iMessage` (Apple-account bound) | empty or unknown `service`: unproven |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | The real `NativeBackend` reads a copy of a Messages database (`chat.db` schema). Rows from an authorized contact are added with `service` set to iMessage, SMS, RCS and empty, with and without an attachment. Checks: what reaches the router, ack, event bus, message log, reply window and attachments folder; the owner item; the session context; and the history route. A real SMS sent from a phone is a dated daytime check, because it needs a physical device. | Discard. |
| dev-agent-live | An agent with iMessage configured. Echo has no iMessage channel, so this rung is recorded as not available on Echo. | Revert. |
| fleet | Ships on. | Patch release. |

## Tests and evidence

- **Unit:** each service value. That covers no routing or ack or event or log for unproven rows, and normal handling for iMessage rows. Also: the owner item's count, masking, cap and refresh limit; the context filter and its count line; and the history route's flag.
- **Integration:** the history route on a mounted server with a stub backend.
- **E2E alive:** the adapter constructed through the production path, with an SMS row set aside.

## Maturation plan

- **ladder:** not applicable: no flag; it ships on per the approved umbrella's piece-1 rollout row (SMS-origin authority denied immediately)
- **test-agent-live:** the rollout row above.
- **dev-agent-live:** an iMessage-configured agent (not Echo).
- **fleet:** on at merge (umbrella rollout row).
- **graduation criterion:** green Local Verify, merged commit, unit and route evidence.
- **dark-window:** none (ships on).

## Review rulings (round 1)

- **Constitution check, 5 flags:**
  - *Know Your Principal*: there is no opt-out that trusts spoofable numbers.
  - *Security Fixes Keep the Experience Whole*: SMS-only contacts couldn't hold a conversation before, since replies go only as iMessage. The owner's fallback texts get a resend prompt, and a per-number list is piece 4.
  - *Judgment Within Floors*: the caps limit only how many numbers are shown; the count is exact and the texts stay in Messages.
  - *Maturation Path*: ships on per the umbrella's rollout row, and Echo has no iMessage channel for a development rung.
  - *Live-User-Channel Proof*: the real database reader on a real-schema copy; a real phone SMS is a dated daytime check.

- **Internal review, round 1 (4 design):**
  - The reply window is now closed to unproven rows.
  - Attachments are skipped.
  - The history route hides the text.
  - The SMS list is dropped (no owner-bound write path; SMS-only contacts get no replies anyway) and moves to piece 4.
  - The notice says "not iMessages (SMS or similar)", since RCS and unknown services are set aside too.

- **Cross-model round 1** (it reviewed the first draft):
  - **Already covered by the later changes:** the opt-out is removed, and the history route hides unproven text and attachments.
  - **Applied:** the notice names the agent's other ways in, for when iMessage itself is down.
  - **Ruled to other pieces:** the local link first (1a), members' own conversations and team routing (1f), and a piece-1 checklist (the umbrella's §12 and the claims file).
  - **Kept, with reason:**
    - *Shipping on at merge:* the umbrella Justin approved says SMS-origin authority is denied immediately, and the rule only stops rows a stranger could have sent.
    - *A real Messages account and a phone for the live proof:* a dated daytime check.
    - *One agent-wide item across Macs:* the item is per Mac, since only a Mac with Messages configured reads rows, and the pool view merges them.

## Open questions

*(none)*

## Left behind

- Group chats where an iMessage participant is not a contact. Today's `authorizedContacts` check is unchanged.
- Delivering the SMS text to the owner somewhere sessions can't read it (a phone-only surface, piece 4).
- An owner-accepted per-number SMS list, written only from the owner's own device (piece 4).
