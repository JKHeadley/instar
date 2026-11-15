---
title: Work Board
description: A card for every decision, answer or sign-off the agent needs from a person, whose chat is a real conversation.
---

The **Work Board** gives a person one place to see what their agent needs from them. Each need is a **card**: what is needed and why, what done means, who carries it and who acts next. The card's chat is a real app conversation, so a comment reaches the agent's session at once. The full design is `docs/specs/work-board-asks.md`; this page describes phase 1 as it ships.

The feature is off unless `workBoard.enabled` is on. When the setting is left out it is on for a development agent and off everywhere else. With it off, every route below answers `503 work-board-disabled`.

## One home for each need

A card is for a decision, an answer or a sign-off on a piece of work. Other needs keep their own home: a standing permission is an authorization request, a credential is a secret request, a plan's approval is the plan, a true blocker is the blocker ledger, a health condition is the attention queue, a Chief of Staff project's sign-off is its binding, and a promise the agent made is a commitment.

## What the code enforces

- **Only a person approves.** A tap (approve, answer, confirm done, hold, release, try again, withdraw approval, reopen, archive, restore, remove) needs the dashboard PIN on the console or Face ID on the owner's phone. The agent's token on the tap route is refused `person-required`.
- **An approval covers exactly what was shown.** It binds to a hash of the card's material fields (title, need, done items, carrier, the outward flag, links). Any later change to those cancels it, and it never comes back, even if the field is edited back.
- **Status is derived, never typed.** No route accepts a status. The lane a card sits in follows from its records.
- **A card finishes only with evidence** for every done item. Items marked for the owner need the owner's confirm; a reopened card always does.
- **Taps that stop work are never refused.** Hold, withdraw approval, reopen, archive and remove are accepted whatever the card's state.
- **Secrets are refused at the door.** Card text passes the same credential check as outbound messages.

In phase 1 a card is carried by the agent or by the team owner, and every tap is the team owner's. Team members and guests see and discuss any card whose conversation the owner shared with them.

## The pieces

- `WorkCardStore` (`src/core/WorkCardStore.ts`): the `work-card-record` replicated kind (store key `workBoard`). Records are immutable; the card, its material hash, approval, status and pickups are a pure fold over them, the same on every machine.
- `WorkBoardService` (`src/core/WorkBoardService.ts`): the in-memory index every read is served from, and the write rules: who may write what, the owner-set limits, the daily ceiling on agent-written cards, and the named refusals.
- `WorkBoardPickupController` (`src/core/WorkBoardPickupController.ts`): hands an approved card to its conversation's session. It writes a durable intent before delivering, checks the card again after the wait, and records how the delivery ended. Waiting for a free session costs nothing and never parks; three failed attempts park the card for the owner; a crash between intent and delivery produces a recovery brief, and a card that sends something outside the team is parked for the owner first.
- `WorkBoardRuntime` (`src/core/WorkBoardRuntime.ts`): joins the parts: the card's conversation, the server-written `Work board:` lines, the shared-ledger note per hand-over, and the two multi-machine reads (`behind`, and whether a previous owner's stream has been caught up).

## Routes

| Route | Who | What |
|---|---|---|
| `GET /work-board` | agent, console | The lanes (Waiting on you, With the agent, Waiting on others, Done, Archived), pending pickups, `behind`. |
| `GET /work-board/cards/:id` | agent, console, a scoped session on its own card | One card. |
| `POST /work-board/cards` | agent; the owner with the PIN | Create a card. |
| `POST /work-board/cards/:id/records` | agent; the owner with the PIN for an edit | `edited`, `waiting-on`, `evidence`, `claimed-done`. |
| `POST /work-board/cards/:id/tap` | the owner, with the PIN | Every tap. |
| `POST /work-board/settings` | the owner, with the PIN | Limits and the approval policy. |
| `GET /work-board/graduation`, `POST /work-board/graduation/pass` | agent | The pilot's measurement and its day-7 and day-14 records. |
| `GET /mobile/work-board` | a paired phone | The cards that phone's person may see. |
| `POST /mobile/work-board/cards/:id/tap` | the owner's phone, Face ID | Every tap. |

## Approval policy

The team owner chooses one of two policies on the Work page:

- **Every agent card** (the default): the agent waits for the owner's OK on every card it writes.
- **Outward only**: the agent starts internal cards at once; only cards that send something outside the team or spend money wait. Under this policy the agent's own outward flag is the only thing that asks for approval.

## Limits stated plainly

- The console PIN proves knowledge of the PIN on that machine, not a person at the keyboard. Each tap records which path proved it.
- Removing a card hides its text from every read. The bytes stay in the journal until compaction ships, and an earlier backup still holds them.
- The board does not make a session's external actions happen exactly once. It makes an uncertain hand-over visible and keeps a person in front of anything outward.
- Phase 1 has no work leases. A card with no record for `quietAfterHours` moves to the owner's lane with Try again.
