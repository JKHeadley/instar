# Side-Effects Review — Pin conversations to the top of the list

**Version / slug:** `conversation-list-pins`
**Date:** `2026-11-14`
**Author:** `Echo (builder)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, additive. A person can pin whole conversations to the top of their conversation list (operator request,
Justin 2026-11-14, topic 134088). New store `src/core/ConversationListPins.ts` (immutable pin/unpin rows, latest per
person × conversation wins) with boot wiring `src/core/ConversationListPinsWiring.ts`; a new replicated kind
`conversation-list-pin` (store `listPins`) registered in `src/commands/server.ts`, `src/core/CoherenceJournal.ts`
(retention never deletes), the reconciler allowlist, the state-coherence registry and the backup list; a new route
`POST /mobile/conversations/pins` and `pinnedRefs` / `pinnedRows` on the first page of `GET /mobile/conversations`
(`src/server/mobileConversationRoutes.ts`); the device rule, browser route and team tier for the new path
(`src/server/mobilePairingRoutes.ts`); the store passed through `src/server/AgentServer.ts`; the dashboard's
"Pinned" group and Pin/Unpin buttons (`dashboard/console/chats.js`, `chats-model.js`, `console.css`); agent
awareness (`PostUpdateMigrator.ts` line + migration, `CapabilityIndex.ts`). Off switch
`mobilePairing.native.listPins.enabled` (absent = on, read live). Size: about 20 files, roughly 900 lines with tests.
Effort: one design pass, no spec review rounds (Tier 1), commit attempts recorded in the PR.

## Decision-point inventory

- `POST /mobile/conversations/pins` access check — add — reuses the existing shared conversation check
  (`deviceMayUse` for a device, `pairing.mayUse` for a Bearer-named person). No new judgment, same 404 as a missing
  conversation.
- Device route allowlist — modify (one rule added) — the new path is a device route with its own bucket, open to
  browser devices and to team phones at the guest tier.
- `GET /mobile/conversations` — pass-through — two added fields; rows and paging are unchanged.

## 1. Over-block

A Telegram topic or Slack conversation is pinnable when the person may see it, without checking that it exists on
some machine (a topic may live on a peer). An app conversation must exist here (they replicate everywhere). A team
member may pin only what is shared with them; Slack stays owner-only as everywhere else. The 50 cap is per person;
an unpin is never refused by the cap. No legitimate input identified that is refused.

## 2. Under-block

Two machines could each accept a 50th pin at the same moment, so the union may briefly hold 51; the list just shows
them and the next pin is refused. A pinned ref whose conversation was deleted stays in `pinnedRefs` (no row) until
the person unpins it; that is visible and harmless. A Telegram topic pinned but held only on a dark peer has no row
until that peer answers.

## 3. Level-of-abstraction fit

Same layer and identity as unread markers (per-person state on the conversation routes), same replicated-row shape
as recommended services. The list route already finds the Chief of Staff pinned row the same way; the new lookup
follows it. No new layer.

## 4. Signal vs authority compliance

No new blocking authority. The only refusals are the existing access check, the input shape, and a fixed cap; none is
a brittle detector making a judgment. Compliant with docs/signal-vs-authority.md.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point; the cap is a fixed floor on a personal list, not a heuristic.

## 5. Interactions

- Read markers and unread fields: pinned rows get the same unread fields as list rows; nothing about counting changes.
- Chief of Staff `pinned` field: untouched; the dashboard keeps its ordering for the rest of the list.
- Pinned messages (`native.pins`): separate store, separate switch, separate routes. The new path
  `/mobile/conversations/pins` does not collide with `/mobile/chat/.../pins`.
- Rate buckets: the new route has its own device bucket (`list-pins`) and an in-route 30/min bucket, so it never
  draws on the send or read allowance.

## 6. External surfaces

New route and two new list fields; older apps ignore unknown fields. The iPhone app does not yet render pins; the
dashboard does. No outbound messages, no third-party calls.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. Primary action obvious: the "Pinned" group leads the list; each row has one small Pin/Unpin button beside it.
2. No hidden state: pinned rows show the same title, preview, time and unread badge as other rows.
3. Destructive actions de-emphasized: Unpin is a quiet button and only reorders the list; nothing is deleted.
4. Plain language + phone width: labels are "Pin", "Unpin", "Pinned", "All conversations"; a refusal says
   "You already have 50 pinned conversations. Unpin one first."; the button sits in a flex row beside the
   conversation link, so it never forces horizontal scroll at 390 px.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated** through the `conversation-list-pin` coherence-journal kind (store `listPins`), advertised wherever
native app conversations are on. Rows are immutable and keyed by eventId, the fold is order-independent, so every
machine converges on the same pins. Durable state does not strand: the journal never deletes these rows
(`rotateKeep: 0`), a later-joining machine receives them, and a refused emit is re-sent at the next boot from the
state file. The pool list (`?scope=pool`) finds pinned rows on answering peers. No user-facing notices, no URLs.
Status surfaces: none new or changed.

## 8. Rollback cost

Pure code revert. The state file `state/conversation-list-pins.json` and journal rows are inert without the code and
can be left. Or switch off with `mobilePairing.native.listPins.enabled: false` (read live, no restart). No user
visible regression beyond pins disappearing.

## Conclusion

Additive, reversible, replicated per person, no new authority. Ship at Tier 1.

## Second-pass review (if required)

Not required: no messaging block/allow, session lifecycle, gate, sentinel or watchdog is touched.

## Evidence pointers

- `tests/unit/conversation-list-pins.test.ts` — fold, order, cap, idempotency, validation, landing, outbox re-send, wiring.
- `tests/integration/conversation-list-pins.test.ts` — the HTTP contract through the production auth middleware.
- `tests/e2e/conversation-list-pins-alive.test.ts` — a production-booted AgentServer: a phone pins, the owner's browser sees it.
- `tests/unit/console-chats-model.test.ts` — the dashboard view model.
