# Side-Effects Review — iMessage: an SMS that claims to be a contact is not that contact

**Version / slug:** `identity-security-piece1eb-imessage-sms`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. Spec `docs/specs/identity-security-piece1eb-imessage-sms.md` (converged in 2 rounds).

- **The rule.** `smsProvenance.ts`: only a Messages row whose `service` is iMessage proves its sender. SMS, RCS, empty and unknown services are unproven.
- **The adapter.** `IMessageAdapter._handleIncomingMessage` sets an unproven row from an authorized contact aside right after the contact check:
  - no route, session, ack, event or log;
  - no reply window, so a spoofed text can't turn a later send into a "reactive" reply;
  - a daily owner count, raised then refreshed at most every 10 minutes with one trailing refresh, showing masked numbers and never the text.
- **The backend.** `NativeBackend`:
  - copies attachments into the agent's folder only for iMessage rows;
  - leaves unproven rows out of a session's starting context, with a count line;
  - hides an unproven row's text on the history route and adds `senderProven`.
- **The server.** It wires the owner count as one updating attention item, or the notice path when there is no Telegram.
- **Test fixtures.** The fixtures that build incoming rows by hand now carry `service: 'iMessage'`, as real rows do.

## Decision-point inventory

- `IMessageAdapter._handleIncomingMessage`: modify. An unproven row is set aside.
- `NativeBackend._poll` attachments: modify. Only iMessage rows are copied.
- `NativeBackend.getConversationContext` and `getChatHistory`: modify. Unproven rows are left out or have their text hidden.

---

## 1. Over-block

Every non-iMessage text from a contact is set aside. That includes:
- **SMS-only contacts.** They already got no replies, because replies go only as iMessage.
- **The owner's own SMS fallback texts during an iMessage outage.** The notice says to resend, or to use another way in.

A row with no `service` at all is unproven. Real Messages rows always carry one.

## 2. Under-block

- **Platform proof only.** An iMessage row proves only its Apple-account handle, not who is typing. That is unchanged.
- **Group chats.** They keep today's per-row contact check.

## 3. Level-of-abstraction fit

One pure rule is used at the three readers (live rows, context, history) and at the attachment copy.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface for callers.
- [x] Yes — a deterministic evaluator over an enumerable domain: the `service` column of a Messages row. `signal-vs-authority.md` permits a deterministic gate over an enumerable domain. Nothing here judges free text.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

These are bounded display rules:
- 10 masked numbers shown, then "and N more";
- a refresh at most every 10 minutes, plus one trailing refresh;
- the owner's local day.

The count is always exact.

## 5. Interactions

- **Outbound safety.** `lastInboundFrom` (the reactive window) is never set by an unproven row.
- **The attention item.** It is upserted, so its count grows. It is marked `needsUser`, so the default hub filter posts it instead of holding it as automated status (second pass).
- **The notice category.** Without Telegram, it uses the existing `sender-rejection` category, which the hub admits.

## 6. Rollback

Revert the change. There is no flag; it ships on per the approved umbrella's piece-1 rollout row.

## 7. Evidence

- **Unit:** `tests/unit/identity-piece1eb-imessage-sms.test.ts`, which runs the real `NativeBackend` on a chat.db-schema database, plus the iMessage adapter, backend, session-injection and user-channel suites.
- **Fixtures updated:** the e2e and unit fixtures.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** a one-shot, user-driven action, not a self-triggered loop. The owner count answers inbound rows: it is raised once a day and refreshed at most every 10 minutes, with one trailing refresh.
