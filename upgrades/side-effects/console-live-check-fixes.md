# Side-Effects Review — five console defects from the 2026-11-14 live check

**Version / slug:** `console-live-check-fixes`
**Date:** `2026-11-14`
**Author:** `Echo (helper session)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, read-only console view changes (about 12 files, ~400 lines including tests; one commit attempt planned, no spec rounds). A live check of Echo's console found five defects; each is fixed in the pure view-models with unit tests:
1. Home "What needs you" (`home-model.js` `combineNeeds`): rows with the same words collapse into one row that says how many ("4 of these"); the general "sign-in repair is waiting" queue notice is dropped when the named Accounts sign-in rows are listed; the count and headline use the collapsed list; the card no longer lists the headline item again when the headline links to it (`needsCardList`, used by `console.js` `paintCard`); the corner tag says which part did not answer ("A machine did not answer") instead of "partial" (`partialWords`, `coverageWords`).
2. The Mac "Remote Desktop needs its Mac permission again" notice now links to `#/capacity/machines?m=<id>&fix=desktop-permission` (`needAction`); the Machines page reads open notices and shows, above the machine list, a card per affected Mac naming the machine, the permission (Screen Recording and Accessibility) and the one fix, with a button to the remote desktop page (`machines-model.js` `desktopPermissionFixes`, `machines.js`).
3. Work page: tile rows share one height on two- and three-column layouts (`console.css` `grid-auto-rows: 1fr`); the conversation-graph tile is named "Efforts" so it is not a second "Conversations" (`conversations.js`). The Work board tile's 0x0 / 404 was rechecked on 1.3.1784: `/work-board` answers 200 and the tile shows, so no code change was needed there.
4. Promise list rows turn reference ids into words (`display-identity.js` `plainReferenceText`, used by `promises-model.js` `toRow` and `home-model.js` `buildPromised`); conversation names come from `/telegram/topics?scope=pool`. The details sheet keeps the full text.
5. The Accounts header counts accounts the same way the rows do (`accounts-model.js` `accountCounts`): "N of M ready", "K need you to sign in" (linking to the sign-in section), and the rest as "not ready yet, nothing for you to do". The old "14/14 accounts usable" fact is gone.

## Decision-point inventory

No decision point that gates, blocks, filters or constrains agent behaviour. The only "decision" is which rows a view shows and how they are worded; nothing is sent, stored or refused.

- `combineNeeds` row list — modify — display grouping of rows and their count; no row disappears without its words still being shown (a merged row keeps its first link and says how many it stands for).

---

## 1. Over-block

No block/allow surface — over-block not applicable. Display note: two genuinely different needs that share exactly the same title collapse into one row; it says "N of these" and links to the same page section, where each is listed separately.

## 2. Under-block

No block/allow surface — under-block not applicable. Display note: near-duplicates with different wording (the M5 notice titled "Mac Lan" while the machine is called "Mac M5 Pro") are not merged; that naming mismatch comes from the server's notice and is outside this change.

## 3. Level-of-abstraction fit

Right layer: all logic lives in the pure view-models the pages already use (`home-model`, `accounts-model`, `promises-model`, `machines-model`, `display-identity`); renderers only call them. Dedupe sits in `combineNeeds` because that is where the queue, surfaced sources and promises meet (it cannot live in `needs-model.js` without an import cycle through `development-model.js` → `home-model.js`).

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Pure presentation of data the server already serves.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Text matching (same words, id patterns) only shapes display.

## 5. Interactions

- Home headline and card share one list, so the headline count ("N more things need you") and "See all N" agree after collapsing.
- The existing `refs` and pull-request de-duplication in `combineNeeds` run first, unchanged.
- `paintCard` hides the needs card when only the headline item exists and it is a link (unchanged rule).
- The Machines page adds one read (`/attention?scope=pool&status=OPEN`, 8 s budget) in parallel with its existing reads; a failed read shows nothing extra unless the page was opened from the notice link, where it says it could not check.
- The Promises page adds one read (`/telegram/topics?scope=pool`, 8 s) for conversation names; a failed read only means unnamed conversations read "a conversation".

## 6. External surfaces

Only the operator console (desktop and the phone app's embedded pages). No API, notice, message or stored state changes. Other agents see the same console code after update.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: the Mac permission card is the first thing under the Machines heading when opened from the notice, with the fix in one sentence and the button to retry; Home leads with the headline and lists only the other items.
2. **Zero raw internals as primary content?** Yes: promise rows lose fb-/CMT-/ACT-/thread/topic/machine ids; the "partial" tag became plain words; ids remain only in promise details. The helper path appears only in the "if it is not in the list" line, where it is the thing to add.
3. **Destructive actions de-emphasized?** No destructive action is added.
4. **Plain language + phone width?** Checked at 1280x728 and 390x844 against Echo's live data through a local copy of the console; no horizontal scroll; tile heights equal per row on desktop, natural on phone (single column).

## 7. Multi-machine posture

Proxied-on-read: every new read is the existing pool-wide read (`/attention?scope=pool`, `/telegram/topics?scope=pool`, `/subscription-pool?scope=pool`), so the Mac permission card appears for any machine's notice from whichever machine serves the console, and links use machine ids that survive machine boundaries (`/dashboard/desktop.html?machineId=…`, hash routes). No notices emitted, no durable state, no status surface changed.

## 8. Rollback cost

Pure static console code. Revert the commit and ship a patch; no persistent state, nothing to migrate.

## Conclusion

Clear to ship as a Tier 1 change. The review moved the dedupe into `home-model.js` (to avoid an import cycle) and kept the headline item in the card when the headline is not a link, so its detail stays reachable.

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle or messaging decision is touched.

## Evidence pointers

- Unit tests: `tests/unit/console-live-check-fixes.test.ts`, plus the existing console model tests.
- Before/after screenshots of Echo's live data (scratchpad, not committed).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
