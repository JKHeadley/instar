# Side-Effects Review — Shared web conversation tree

**Tier:** 1
**Author:** Echo
**Second-pass reviewer:** No new authorization or mutation.

## Summary of the change

The two web entry points can draw the same server-projected owner tree once the full sections are present. Display preferences are stored in the browser. The existing view remains compatible with a server that lacks the sections.

## Decision-point inventory

The owner proof, visible rows, relationships, and placement come from the server. Browser presentation validates the shape, excludes duplicates, and draws server-supplied sections. There is no new write.

## 1. Over-block

The renderer refuses malformed tree nodes and unsupported section shapes. The existing view handles a missing shared projection. A supplied project reference stays out of Ungrouped even when its project header could not be loaded.

## 2. Under-block

A duplicate reference is drawn once under the first authoritative branch. The browser adds no unrelated inventory rows to the tree. The server continues to own hidden-chat visibility.

## 3. Level-of-abstraction fit

The reusable renderer owns presentation and local view preferences. The shared authenticated projection owns placement, visibility, membership and completeness.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The display follows the existing server authorization and starts no work. [Signal vs Authority](../../docs/signal-vs-authority.md)

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. A chat’s position follows a returned branch.

## 5. Interactions

The signed Chats and owner-unlocked Groups views retain their existing authorization paths. Tree reads have their own cursor. Group and conversation changes remain on the existing management screens.

## 6. External surfaces

The browser reads the shared tree on an already authorized owner path. Local view preferences store stable section keys and the selected sort. Conversation text and owner credentials are kept out of those preferences.

## 6b. Operator-surface quality

The Chief of Staff row and view controls lead the list. The nested disclosures show titles and counts. Groups expand in place and no destructive action is introduced. Phone-width and desktop-width fixtures check visible structure and keyboard-operable controls.

## 7. Multi-machine posture

The conversation tree is read from the same authorized server projection as the other owner surfaces and reports partial coverage. Preferences for collapse and sorting are local to the browser.

## 8. Rollback cost

Revert the web change. There is no data migration or server setting to restore.
