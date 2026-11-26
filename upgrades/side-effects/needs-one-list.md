# Side-Effects Review — Needs you: a Chief of Staff wait is one item that opens its card

**Version / slug:** `needs-one-list`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, read-model only. Justin approved (topic 134088, 2026-11-18 18:00 PST, CMT-1983) merging the "waiting on you" project lines into the one Needs-you list so each thing appears once. `linkCoveredRows` in `dashboard/console/needs-model.js` (run by the console's Home and by the server's `GET /needs` / `GET /mobile/needs` through `surfacedNeeds`) now turns a row covered by a server-owned card, on a key in the server-only `cos:` namespace, into that card. The row keeps its key and source, takes the card's title and sub, and its `action` opens the card. The source's own href moves to an additive `alsoOpens`, and `card.label` reads "Opens its card on the work board". This applies whatever the card's status, so a Confirm-done wait card no longer shows as a second row next to its project. Every other covering card behaves exactly as before: it links the row, which keeps its words and action, and an agent session's card keeps its own row. `src/server/needsRoutes.ts` passes `alsoOpens` through `toItem`, with the same href rule as an action. `dashboard/console/needs-strip.js` (plus one CSS rule) draws `alsoOpens` as a sibling link. The awareness entry `src/data/awareness/needs-you-list.md` gains one sentence. Size: 5 runtime/console files plus tests, about 80 lines. Effort: no spec rounds (it amends the converged work-board-cards-appear §3 within the owner's approval), one build pass.

## Decision-point inventory

- `linkCoveredRows` (Needs-you de-duplication) — modify — the Chief of Staff's own wait card now replaces its row's words and button instead of only linking it. It is a list-shaping step. It approves, hides and blocks nothing: the card holds the same ask, and the source's page stays one tap away.
- No gate, sentinel, approval or authorization path is added or changed. A card's Approve and Confirm done still go through the work board's own routes.

---

## 1. Over-block

No block/allow surface. Over-block is not applicable. No row disappears: the server-owned card's row was already dropped when it covered a present row, and that is still the case.

## 2. Under-block

No block/allow surface. One known remaining duplicate: an agent session's card that covers another row (for example a plan) still shows as two rows, the linked row and the card's own row. That is deliberate. Folding them would let an agent's card take over another source's button. Live Echo has no such pair today. A project whose card falls outside the shown slice (past `softOpenCards`) keeps its chat line, and the board's "N more cards" row is still counted as one. Both are as before.

## 3. Level-of-abstraction fit

Right layer. The rule lives in the one shared pure model that both the console and the server use, so every client (dashboard, iPhone, Mac, Android) gets the same list from `GET /needs`, and no client needs its own join. iOS already derives `cardId` from an action href `#/work/board?card=…` (`NeedsData.swift`), and Android from `card.id` or the href. So the main change reaches both apps without an app release.

## 4. Signal vs authority compliance

Compliant. Needs you is a signal surface. The change only decides which words and which link a row shows. The takeover is limited to `cos:` covers, which `WorkBoardService` reserves for the in-process server writer (`SERVER_COVERABLE_PREFIXES`, `serverOwnedBlocks`). An agent session therefore cannot use it to redirect the owner's tap away from the page where a need is authorized. Both texts involved are server-composed (`ChiefOfStaffLoop` project title, `composeWaitCard`).

## 4b. Judgment-point check

No static heuristic at a competing-signals decision point. The namespace check is a structural ownership fact, not a judgment.

## 5. Interactions

- The grace path: `surfacedNeeds` caches each source's pre-link rows, and `linkCoveredRows` returns new rows without mutating them (tested), so a replayed row is re-linked on each read.
- Source attribution in `createNeedsComposer` maps by row key. The key is unchanged, so the item stays `source: chief-of-staff`, and the count and `complete` are unchanged.
- PR #3380 (Needs-list paging) also edits `needsRoutes.ts` and `needs-strip.js`. The hunks are disjoint (`toItem` / `NeedItem` here, paging there), so the merge is mechanical.
- `ChiefOfStaffWaitCards` is untouched: no card text is rewritten, so no claim or approval is voided.

## 6. External surfaces

`GET /needs` and `GET /mobile/needs`: for covered Chief of Staff rows, `title`, `why` and `action.href` change (the action now opens the card), `card.label` changes, and an optional `alsoOpens` is added. `schemaVersion` stays 1: the fields keep their meaning (where the row opens), and the new field is optional. An app that ignores `card` and `alsoOpens` now opens the card, which is the intended fix. iPhone and Mac: `alsoOpens` is not shown until their next build, but the card stays reachable, and its text says to answer in the project conversation. The agent's own answers to "what needs me?" follow the awareness sentence.

## 6b. Operator-surface quality

1. **Leads with the primary action:** yes. The row is the card, and tapping it opens the checklist and the buttons. The project-conversation link sits under it as a quiet secondary link.
2. **Zero raw internals:** yes. The title is the card's plain title ("Instar App looks done and needs your OK"), and the label is fixed plain words. No ids are shown.
3. **Destructive actions de-emphasized:** there are no destructive actions on this surface.
4. **Plain language + phone width:** the secondary link is a 13 px inline link under the row's text, with a left indent matching the text column. It wraps and adds no horizontal scroll.

## 7. Multi-machine posture

Replicated, through the inputs: the Chief of Staff records (chief-of-staff-record journal) and the cards (work-card-record journal) both replicate, and every machine builds the same list from them with the same pure model. A machine on an older build shows today's behaviour (a line that opens the chat, with a `card` note) until it updates, and nothing breaks there. There are no user-facing notices and no new durable state. The generated hrefs are console hashes, which are relative and valid on any machine. No `/status`, `/health`, `/capabilities` or `/channels` answer changes.

## 8. Rollback cost

Pure code change: revert and ship a patch. There is no persistent state and no migration. After a revert, the rows go back to opening the chat with a `card` note.

## Conclusion

This is clear to ship as Tier 1. The review kept the takeover narrow: server-owned cards covering server-only `cos:` keys. Every agent-written card keeps the second-pass rule of the original spec, which is that it can never change another source's words or button.

## Second-pass review (if required)

Not required by the high-risk list (no messaging block/allow, no session lifecycle, no gate). An independent reviewer read the diff anyway because it amends a second-pass-reviewed rule. The result is appended below.

## Evidence pointers

- `tests/unit/work-board-cards-appear.test.ts`, `tests/unit/needs-read.test.ts` (52 tests passing).
- Related suites passing unchanged: `console-chief-of-staff-needs`, `console-needs-first-screen`, `console-front-doors`, `cos-owner-pause`, `dashboard-cache-headers` (200 tests).
- Live before-state (Echo, 2026-11-18): `GET /needs` showed 7 `chief-of-staff` items opening `#/work/chats?c=telegram:N`, each with a `card` note, and 7 matching server-owned cards in the board's waiting-on-you lane.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: not applicable. This is an owner-approved behaviour change to a read model, and it adds no self-triggered controller.

### Second-pass result

**Reviewer:** independent general-purpose reviewer subagent (read the diff, WorkBoardService covers validation, workBoardViews, ProjectAppCustomSource).
**Independent read of the artifact: concur, with two findings, both resolved in this change.**

- The takeover cannot be triggered by any agent-written card: `cos:` covers are refused for every writer except the server (`WorkBoardService.ts` covers validation, `serverOwnedBlocks`), and project-app version cards edit as a plain agent. Count, dedupe and source attribution hold, the `alsoOpens` href rule is sound, and the strip's sibling link sits inside the focus-preserving refresh guard.
- Finding: the amended spec text was not updated. Resolved by adding the amendment to `docs/specs/work-board-cards-appear.md` §3 and decision 4, plus its ELI16.
- Finding: a malformed conversation key falls back to the chats list, and that would have been kept as "Open the project conversation". Resolved: `alsoOpens` is kept only for a `#/work/chats?c=` link, with a test.
- Noted: the console Home card does not draw `alsoOpens`, only the strip does. That is acceptable, because the card links on to the project.
