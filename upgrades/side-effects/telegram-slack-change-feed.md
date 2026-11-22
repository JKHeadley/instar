# Side-Effects Review — A change feed for Telegram and Slack chats

**Version / slug:** `telegram-slack-change-feed`
**Date:** `2026-11-22`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, lifecycle or messaging block/allow surface); an independent spec reviewer read the design and the code (round 1, findings below)`

## Summary of the change

Adds an optional `after` query parameter to `GET /telegram/topics/:topicId/messages` (`src/server/routes.ts`) and `GET /mobile/chat/slack/:conversationId/messages` (`src/server/mobileSlackRoutes.ts`), forwarded through the Slack holder hop (`src/server/mobileSlackHolderProxy.ts`). The answer keeps only rows logged at or after `after − 120 s` and carries `changeFeed: { since, lookbackMs }`; the helpers live in the new `src/server/changeFeed.ts`. The web chat (`dashboard/console/chats.js`, `chats-model.js` `newestRowTime`) sends `after` on its 5-second `newest` read once it has seen a row time from an earlier `newest` answer; the 30-second pool read stays a full read and is the safety net. One awareness entry (`src/data/awareness/chat-change-feed.md`). Spec: `docs/specs/telegram-slack-change-feed.md`.

Tier 1 (additive optional parameter; a revert fully undoes it). Size: 7 source/dashboard files, ~120 lines of code plus tests. Effort: one independent review round (it found one blocking defect, fixed before commit, with a regression test that fails on the defective ordering).

## Decision-point inventory

No decision-point surface. The parameter trims rows from an answer the caller was already allowed to read; every permission check (`deviceMayUse`, owner admission, `mayReadStored`) runs first and is untouched.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The closest analogue: a client sending `after` gets fewer rows. A row stamped more than two minutes before the newest row the client holds is not in that answer; it arrives on the next plain read (the web chat's 30-second pool read).

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Right layer. The window is applied in the route, to the finished answer, after the device join, origin join and pool merge. Review round 1 showed that applying it earlier (to the adapter's tail) was wrong: the device join re-adds app-sent messages it was not given as weaker store copies (`messageId: null`), and the pool's own-row-wins dedupe could not see an own row outside the window. Keeping it out of `TelegramAdapter` also avoids the three open PRs reshaping the Telegram log reader (#3598, #3602, #3609).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

A read-side filter on already-authorized rows. It gates nothing.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The 120-second lookback is a fixed overlap for clock ordering in a read answer; nothing irreversible depends on it, and the full read every 30 s bounds any miss.

---

## 5. Interactions

- Unread markers (`readUpTo`) and pins ride on the answer exactly as before.
- The Slack pin preview still looks up text in the unfiltered rows.
- The web chat sets scroll-back state (`nextBefore`, `oldestTs`, "Earlier messages") only on first load and scroll-back pages, never on a `newest` answer, so a small answer cannot disturb scroll-back.
- `mergeBubbles` replaces by id, so the overlap is idempotent.
- The cursor is learned only from this machine's own `newest` answers. It never comes from a pool answer (other machines' clocks) or from the shown bubbles (a placeholder carries the browser's clock).
- No interaction with the live-tail streamer or the content-version counter.

---

## 6. External surfaces

- An additive field (`changeFeed`) appears only when `after` is sent; a plain read's answer is unchanged.
- An older server ignores `after` and returns the plain newest page, which every client already handles.
- An older Slack holder ignores the forwarded `after` in the same way.
- Native apps are unaffected until they choose to send it.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This touches `dashboard/console/chats.js` and `chats-model.js`, but only the request the page sends in the background. Nothing rendered changes.

1. **Leads with the primary action?** Unchanged: the conversation view and compose box render as before. No new element.
2. **Zero raw internals as primary content?** Yes. Nothing new is shown; the cursor is never displayed.
3. **Destructive actions de-emphasized?** No destructive action added or moved.
4. **Plain language + phone width?** No visible text or layout change; the page test confirms the same bubbles render (`older`, `newest`).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read, unchanged. A Telegram pool read still merges every machine's rows, and `after` trims the merged, de-duplicated, joined result. A Slack read for another machine's conversation goes through the holder hop, which now forwards `after`. The web chat's cursor comes only from this machine's own quick read, so a peer's clock cannot hide local rows. The peer mesh verb (`topic-history-pull`) is deliberately unchanged: its pages are already bounded, and the web chat does not send `after` on pool reads.

**Status surfaces:** none added or changed.

---

## 8. Rollback cost

Revert the commit and ship a patch. No state, no migration, no config. Clients sending `after` to a reverted server get the plain newest page.

---

## Conclusion

Safe to ship as Tier 1. The one design defect the review found (filtering before the device join and pool merge) is fixed, and a test that fails on the old ordering guards it.

## Second-pass review (if required)

**Reviewer:** not required (no high-risk surface). An independent spec and code review ran before commit.
**Independent read of the artifact: concur after fix.** Round-1 findings:
1. Blocking: filter applied before the device join. Fixed.
2. Major: filter applied before the pool's own-row-wins dedupe. Fixed.
3. Minor: the cursor source was worded loosely. The spec and code now take the cursor only from `newest` answers.
4. Minor: native-app guidance. Added to the spec's Non-goals.

## Evidence pointers

- `tests/integration/telegram-change-feed.test.ts`: 6 cases.
  - A plain read is unchanged.
  - The window applies, accepting ISO or epoch-ms times.
  - A pool read is trimmed.
  - A device read gets no store copy of an out-of-window app row. This case fails when the filter is moved before the join, which was verified by temporarily restoring that ordering.
  - Bad input gets a 400.
- `tests/integration/mobile-slack-from-app.test.ts`: the Slack window and its 400 cases.
- `tests/unit/mobile-slack-holder-proxy.test.ts`: the holder hop forwards `after` and refuses an oversized one.
- `tests/unit/console-chats-model.test.ts` (`newestRowTime`) and `tests/unit/console-chats-page.test.ts`: the first quick read is plain and the next carries `after=<newest>`. Pool reads never carry it.
- Neighbouring suites: 20 integration files and 13 unit files, all green. `npm run lint:parallel` passed 55 of 55 steps, and the instruction-size budget tests pass.
