# Side-Effects Review — a Chief of Staff note a person can read

**Version / slug:** `chief-of-staff-note-readable`
**Date:** `2026-11-12`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow, lifecycle, or gate decision changes; display and link wording only)`

## ELI16

The Chief of Staff sends the owner a daily note about the projects it watches. On 2026-11-12 the owner got one that listed four projects, and every line looked the same: the project's goal cut off in the middle of a word, then the same sentence, "every automatic check passes. Confirm it's done?", four times. Below it sat four buttons that all said "Confirm done", so nothing told him which button belonged to which project. It did not say what had been checked, or what he was actually being asked to judge. The link to "see more" pointed at the agent's own machine (localhost), which a phone cannot open. The footer named the machine by a raw id ("Machine m_b7f06b").

Now the note opens with one plain headline ("4 projects look finished and need your OK"). Each project gets a small block: a short name that is never cut mid-word, a line saying how many automatic checks passed, the exact thing the owner still has to judge (quoted from the project's own done list), and a link to that project which opens on a phone. Blocks are numbered, and each button carries the same number plus the project's name ("Done: 2 · Get Monroe AI ready for…"), one per row, so a button matches its block even when the name has to be shortened. The dashboard's Chief of Staff card uses the same short names (it used to cut goals at 80 characters mid-word) and each project row opens that project's own conversation. If there is no public link yet, the note simply carries no link instead of a broken one. The footer uses the machine's nickname or its own name, and the raw id only when the machine has no name at all.

Nothing about who can tap, when the note is sent, or how a project is closed changes. A tap still re-checks every automatic check before anything closes.

## Summary of the change

Tier 1 (small, reversible by revert). Files: `src/core/ChiefOfStaffLoop.ts` (note layout: `ConfirmBlock`, `cutAtWord`, `shortProjectTitle`, `confirmButtonLabel`, grouped rendering in `composeNote`, `label()` moved to a method that prefers a real title, button order follows the note, `statusUrl` may be null, new optional deps `projectUrl` and `projectTitle`), `src/commands/server.ts` (wires `statusUrl`/`projectUrl` to the existing `operatorLinkOrigin()` public tunnel resolver and the console page `#/work/chats[?c=<key>]`, and `projectTitle` to the initiative title or the Telegram topic name), `src/messaging/TelegramAdapter.ts` (`sendOwnerDMWithButton` lays out three or more buttons one per row; a pair keeps its single row), `src/messaging/telegram-origin/OriginPresentation.ts` + `TelegramOriginBoot.ts` (`publicMachineName` fallback chain: nickname, registry name, identity name, then the raw id), `docs/specs/chief-of-staff-topic.md` §3 (the link target and the layout are now written down). Follow-up on the same branch: blocks are numbered and each Done button reads "Done: <n> · <name>" (labels set at send time from the block order; callback data unchanged); `projectsSummary()` (served by `GET /chief-of-staff`) gains a `title` field (the same short name the note uses); `dashboard/console/needs-model.js` uses that title, falls back to a JS copy of the same word-boundary rule (a parity test keeps the two equal), and each project row links to `#/work/chats?c=<key>`. Tests: `tests/unit/chief-of-staff-note-layout.test.ts` (new), `tests/unit/console-chief-of-staff-needs.test.ts` (two new cases), `tests/unit/ChiefOfStaffLoop.test.ts` (updated assertion + four send-path cases). Effort: one build pass, no spec review rounds (Tier 1), one commit attempt expected.

## Decision-point inventory

- Owner tap handling (`ownerTap`, `cos:confirm-done:<key>` / `cos:unpark:<key>` ids) — pass-through. Ids are byte-for-byte unchanged; only the button text changes.
- One-reader rule in `sendToCos` (DM vs forum) — pass-through, untouched.
- Derived needs (`derivedNeeds`) — pass-through; same items derived, now carrying a `confirm` block.
- Note dedupe in `maybeSendNote` — pass-through (keys on the action id, unchanged).

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable. One display limit: a project whose goal has no "Name:" lead and whose initiative and topic have no name gets the first 60 characters of its goal cut at a word; that is readable but can still be long.

## 3. Level-of-abstraction fit

The layout lives in `composeNote`, the one pure renderer every note path already uses, so the transient (this tick) and derived (from the folds) items render the same. Links reuse the existing `createOperatorLinkOriginResolver` (the same resolver the sign-in reminders use) instead of a new tunnel lookup. The machine-name fix is in the one place the Telegram footer's machine name is chosen (`TelegramOriginBoot`), so every footer benefits, not only the Chief of Staff.

## 4. Signal vs authority compliance

No decision logic added. The loop still holds no new authority; the tap path still re-checks every deterministic item before a close. The link check (`https://` only) is a presentation filter: a non-public link is omitted, never sent.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The title rule (lead before ": ", " — ", or a first sentence end) is a display heuristic with a safe fallback (word-boundary cut).

## 5. Interactions

- **Shadowing:** none; the localhost-link outbound rule would have refused or flagged the old localhost link, which no longer appears.
- **Double-fire:** none; one note per cadence as before.
- **Races:** `projectTitle` reads the initiative tracker and the topic name at note time; both are read-only and wrapped in `safe()`, falling back to the goal.
- **Feedback loops:** none.
- `sendOwnerDMWithButton` is shared with mobile pairing and browser setup (Approve / Decline, two buttons): those keep their single row because only three or more buttons switch to one per row.

## 6. External surfaces

- Telegram: the note's text and button labels change; callback data is unchanged. Footers on every agent message now show a machine name where a nickname was missing (for example the hostname instead of "Machine m_b7f06b").
- `GET /chief-of-staff` gains a `title` per project (additive; existing readers ignore it).
- Operator surface: the dashboard Chief of Staff need rows show the short name and link to the project's own conversation instead of the conversations list.
- Operator surface: the note's links now open the console's Chief of Staff page on a phone (public tunnel). With no tunnel, no link is sent. No new operator actions.
- No persistent state changes; note records still hash the item text (the text changed, so the hashes do too, which only matters for the "itemKeys" metadata).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes: the headline states what is needed and the count; each block ends with its link, and the buttons follow in the same order.
2. **Zero raw internals as primary content?** Yes: no conversation keys, no machine ids (except when a machine has no name at all), no localhost link.
3. **Destructive actions de-emphasized?** There are no destructive actions here; "Done" is the constructive action and each one names its project.
4. **Plain language + phone width?** Yes: short lines, titles cut at a word, numbered blocks with matching numbered buttons one per row. The dashboard card's project rows now read "<short name> is waiting on you" with a word-boundary name and open that project directly.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN for the note composer (it runs on the Chief of Staff lease holder only, as before). URLs: built from the lease holder's public tunnel origin at send time, so they open from anywhere; a machine with no public link sends none. The machine name in footers is each machine's own name, which is what a footer is meant to show. No durable state added.

## 8. Rollback cost

Revert the commit. No migration, no stored state to repair; the next note renders the old layout.

## Conclusion

Display-only change to the note, its buttons, its links and the footer machine name; the tap, close and routing rules are untouched. Safe to ship.

## Second-pass review (if required)

Not required: no change to block/allow, session lifecycle, or any gate.

## Evidence pointers

- `tests/unit/chief-of-staff-note-layout.test.ts` — 19 tests: word-boundary cuts, titles, button labels, grouped blocks, no-link fallback, footer machine names.
- `tests/unit/console-chief-of-staff-needs.test.ts` — 6 tests, including word-boundary names, the server title winning, per-project links, and JS/TS rule parity.
- Live Telegram proof: the built loop composed the four-project note and the real `TelegramAdapter.sendOfferList` posted it into the marked test group "Instar test - unread and dashboard" with @instar_pr2760_livetest_bot (message 76); the Bot API's returned text and four one-per-row buttons ("Done: 1 · Emily Ghosh's affiliate…" through "Done: 4 · Keep Paul's requests and AI…") match the tests.
- `tests/unit/ChiefOfStaffLoop.test.ts` — 53 tests including the four-project send path (headline, per-project blocks, quoted judgment items, phone links, button labels and ids within 64 bytes), the no-tunnel case, a real title, and the cap.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
