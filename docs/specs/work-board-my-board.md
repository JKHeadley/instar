---
title: "Work Board: My board, each card once under its most pressing reason"
slug: work-board-my-board
author: echo
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: docs/specs/work-board-my-board.eli16.md
origin: "Plan doc 'Work Board: Luna's cards and ours, side by side' (17 Nov 2026), item 4 'My board order and colours'. Justin, Telegram topic 134088, 2026-11-17 22:35 PT: 'Please move forward with all of this'. Promise CMT-1942."
amends:
  - "docs/specs/work-front-doors.md (§6 'My board ordering: each item once, under its most pressing reason'; this addendum fixes the reasons, their precedence and the read shape)"
depends-on: "PR #3404 (Work Board slices 1-3: turn, started/startedAt, closeout, lanes)"
lessons-engaged:
  - "Signal vs. Authority (the grouping is a read-only view; it gates, blocks and decides nothing)"
  - "Cross-Machine Coherence (derived on every read from the replicated card fold; nothing new is stored)"
  - "Privacy through counts (a member's sections are built only from cards the existing viewer filter lets them see)"
review-convergence: "2026-11-18T18:02:39.485Z"
review-iterations: 2
review-completed-at: "2026-11-18T18:02:39.485Z"
review-report: "docs/specs/reports/work-board-my-board-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
approved: true
approved-by: Justin
approved-at: "2026-11-18T18:04:00Z"
approval-source: "Standing rule (only constitution changes need Justin) plus Justin, Telegram topic 134088, 2026-11-17 22:35 PT: 'Please move forward with all of this', answering the Work Board plan whose item 4 is My board. Checked: no constitution file (docs/STANDARDS-REGISTRY.md) and no CODEOWNERS path is touched."
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Work Board: My board

## 1. What this is

Luna's board (sagemind-admin `CARDS.md` §"My board", `public/cards.js` `attention(card, person)`) gives each person a board that shows only the cards that need them, each card once, under its most pressing reason, and in every list untouched cards first, then started ones, with a tag saying whose turn it is. The approved front-doors spec (§6) adopts "My board ordering: each item once, under its most pressing reason" without fixing the reasons. This addendum fixes them for Instar's Work Board and the read shape clients draw.

What already exists (PR #3404): every card read carries `turn` (`you`/`agent`/`others`/`nobody`, the whose-turn tag), `started` / `startedAt`, and the board's lanes list untouched cards first. What is missing: the grouping by reason, and a card-id tie-break on the waiting lane's cut. That is all this adds (the implementation accompanies this addendum in the same PR).

## 2. The read

`GET /work-board` and `GET /mobile/work-board` (one serializer, `boardJson`) gain one field:

```
myBoard: { sections: [ { reason, words, cardIds: string[], notStarted: number, more?: number } ] }
```

- `sections` always lists all five reasons in this fixed order; a client hides a section whose `cardIds` is empty and has no `more`.
- `reason` and `words`:
  - `approval`: "Waiting for your approval"
  - `reply`: "Waiting for your reply"
  - `own`: "Your cards"
  - `added`: "Cards you were added to"
  - `held`: "Held for later" (Luna's fifth section, kept last as on her board)
- `cardIds` name cards carried in the same read's lanes; a client draws each from there. Within a section: untouched cards (`started: false`) first, then started ones; each group newest activity first (`newestRecordAt` descending; ties by card id, so the order is deterministic).
- `notStarted` counts the untouched cards listed.
- The waiting lane's soft cut keeps the oldest cards, with the card id breaking ties (added here), so every machine cuts the same cards for the same fold. The cut itself is the existing flood protection from `work-board-asks.md`, not new; My board only names it per section.
- `more` counts cards with this reason that the existing soft budget cut from the "Waiting on you" lane. A section never names a card id the read does not carry. Which cards survive the cut is decided oldest first (unchanged); the section order is display only. A client shows `more` as text ("and N more"), as the lane does today; it is not a dead end: the Needs-you list reads the board in full (`boardFor` with `full: true`), so every cut card is listed there with its own card page. The cut and its number are the approved `softOpenCards` judgment-candidate of `work-board-asks.md` (default 30, a person can change it), unchanged here. For any viewer the sections' `more` add up to the lane's `more`, since every card in that lane gets a reason.

Nothing is stored; the field is derived on every read from the card fold the board already reads. A client that does not know the field ignores it; a client reading an older agent finds no `myBoard` and keeps drawing lanes.

## 3. The reason for one card (`myBoardReason`)

A card on the "Done" or "Archived" lane has no reason. Otherwise, in this precedence (each card gets exactly one):

1. **held**: the card's status is `held` (status precedence already puts a hold above approval, as Luna's `attention` checks a hold first). Luna shows a held card only to people on it; here the owner sees every held card and a member every held card shared with them, since sharing is how a person is on a card.
2. **approval**: the viewer is the owner (or the agent reading on the owner's behalf) and the status is `needs-approval` or `claims-done` (the owner's sign-off on a done claim). Only the owner approves in this phase, so a member never gets this reason.
3. **reply**: the status is `waiting-on-person` and the open question is addressed to the viewer. On a solo agent with no team record, the owner's read carries no `personKey`; `setWaitingOn` refuses a person-addressed question there, so the branch that treats such a question as his reply is defensive only. In phase 1 a card's carrier and a question's addressee are only ever the agent or the owner, so a member's "reply" and "own" sections stay empty until member actions arrive (stage 3).
4. **own**: for the owner, any other card in the owner's "Waiting on you" lane and only those (a card he carries, which is always in that lane while open, a card the agent could not pick up, a quiet card, a card that could not be read, a capacity wait that surfaced, a question put to someone else on his board, which cannot occur in phase 1 since no question is yet addressed to a member); for a member, a card whose carrier is that member.
5. **added**: a member's visible open card. A member sees only cards whose conversation was shared with them (the board's existing viewer filter); sharing a card's own conversation is how a person is added to a card in Instar.

The owner has no "added" section: he sees every card, and a card that is moving with the agent or waiting on someone else does not need him, so it stays only in the lanes (Luna's Tasks tab equivalent).

The agent bearer reads as the owner (`personKey` = the owner), so its `myBoard` is the owner's. A scoped session token cannot read the board at all (unchanged).

## 4. Clients

- iPhone and Mac: the Work tab's card area draws `myBoard` sections first (header with words and count, each card with its whose-turn colour and a "Not started" tag when untouched; empty sections hidden), then the rest of the board's lanes ("With the agent", "Waiting on others", "Done" folded) for cards not on My board, and "Archived" as today. Every card in the reader's "Waiting on you" lane has a reason (for any viewer), so a client drawing My board does not draw that lane or its `more` again; the sections' `more` add up to the lane's. A member's open cards are all on My board, so below it they see only Done and Archived. No `myBoard` (an older agent): today's lanes, unchanged.
- Dashboard and Android draw the same field from the same read; they are dispatched separately by Echo.

## 5. Side effects and multi-machine posture

- Read-only: no record, no route, no tap, no notification. Each card once is guaranteed by construction (one reason per card).
- Multi-machine: derived per read from the replicated card fold plus the two per-read inputs the lanes already use: the reading machine's clock (a card goes `quiet` after a set time) and its in-memory capacity-wait state (`svc.capacityWait`, which can surface a card in the owner's lane). The same fold, clock and capacity-wait state give the same sections; the sections always follow that machine's lanes, so they can differ between machines exactly where the lanes already do.
- Privacy: a member's sections are built only from cards already in their filtered read; `more` counts only cards cut from that same viewer's lane, so nothing they cannot see is counted.
- Fixed limits: none added. The existing soft budget (`softOpenCards`, a judgment-candidate of `work-board-asks.md`) is reused, not changed; My board only reports what it cut (`more`).
- Rollback: revert the commit; clients fall back to lanes when the field is absent.

## 6. Tests

Unit (`tests/unit/work-board-my-board.test.ts`): each reason on the owner's board, done and moving cards absent, each card once, fixed section order and words, approval outranks own, a hold outranks approval (status precedence), the agent's read equals the owner's, a solo agent's owner with no personKey gets person-addressed questions as replies, member added / reply / no approval, untouched-first then newest order, soft cut counted as `more` and never named. Integration (owner phone and a member's phone) and the e2e alive test assert the field on the real route.

## Maturation plan

- **test-agent-live:** a throwaway agent with the board on: an agent card, a question, an owner-carried card and a held card each appear once under their section on the real `GET /mobile/work-board`, drawn by the iPhone and Mac apps; a member phone with one shared card sees it under "Cards you were added to" and nothing else.
- **dev-agent-live:** Echo, where the Work Board is on by the dev gate: Justin's iPhone and Mac Work tab open on My board for a week.
- **fleet:** follows the Work Board itself (dark on the fleet by the dev gate); the field adds no switch of its own.
- **graduation criterion:** over the week on Echo, every card waiting on Justin appears on My board exactly once (checked against the lanes in the same reads), and zero owner-found defects on first use.
- **dark-window:** at most 14 days dark on the fleet after the board graduates.
- **ladder:** workBoard.asks

## Decision points touched

- myBoardReason (which section a card is listed under) — invariant; basis: enumerable-domain; evidence: the reason is a pure function of the card's derived status (12 values), its open question's addressee, its carrier and the viewer's lane, all already decided elsewhere; it gates, blocks and routes nothing, and every card stays in the lanes whatever it returns.
- Section order and in-section order — invariant; basis: enumerable-domain; evidence: five fixed reasons; started is a boolean; ties broken by newest activity then card id, so every machine produces the same order for the same fold.


## Multi-machine posture

Proxied-on-read from replicated state: `myBoard` is derived on every board read from the replicated work-card fold (the `workBoard` replicated store) and the same per-read inputs the lanes use (the reader's clock for `quiet`, the machine's capacity-wait state). Nothing machine-local is introduced and nothing is stored; where two machines' lanes differ today, their sections differ the same way.

## Frontloaded Decisions

1. Five sections, not four: Luna's current `CARDS.md` and `attention()` include "Held for later"; kept for parity, listed last.
2. The owner has no "Cards you were added to" section; cards moving with the agent or waiting on others are not on his My board and stay in the lanes.
3. For the owner, every remaining "Waiting on you" card that is not an approval or his reply sits under "Your cards" (he is answerable for every card in phase 1).
4. A done claim needing the owner's confirmation counts as an approval.
5. Server sends all five sections; clients hide empty ones.
6. The server returns ids, not duplicated card bodies, to keep the read size flat; ids always resolve inside the same read.
7. "Cards you were added to" is every open card shared with a member, including cards moving with the agent: phase 1 has no per-card people list, and a shared card is the closest equivalent of Luna's added person.

## Open questions

*(none)*
