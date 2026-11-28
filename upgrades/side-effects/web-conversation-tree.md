# Side-Effects Review — Shared web conversation tree

**Tier:** 1
**Author:** Echo
**Second-pass reviewer:** No new authorization or mutation.

## Summary of the change

The two web entry points can draw the same server-projected owner tree once all three sections decode and the server affirms complete placement. Display preferences are stored in the browser. The existing view remains compatible with a server that lacks the sections.

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

The signed Chats and owner-unlocked Groups views retain their existing authorization paths. Tree reads have their own cursor. The grouped view waits for its first placement read before drawing flat conversation rows. Group and conversation changes remain on the existing management screens.

## 6. External surfaces

The browser reads the shared tree on an already authorized owner path. Local view preferences store stable section keys and the selected sort. Conversation text and owner credentials are kept out of those preferences.

## 6b. Operator-surface quality

The Chief of Staff row and view controls lead the list. The nested disclosures show titles and counts. Groups expand in place and no destructive action is introduced. Phone-width and desktop-width fixtures check visible structure and keyboard-operable controls.

## 6c. Delight the user

Before this round, the grouped view had two visible faults. A conversation whose project header was missing vanished from the page with no notice. A group holding one conversation collapsed into a row showing only that conversation's title, so the group's own name was gone. Now the missing-header conversation stays visible under "Not in a group yet", and the one-conversation group row carries the group's name with the folder icon, matching what a one-conversation project already did. Both pictures are the same fixture at phone width, 390 by 844, with the pinned Chief of Staff card, one project with two conversations, one one-conversation group and two ungrouped conversations.

1. Clear visual hierarchy: the pinned Chief of Staff card comes first, then bold section headings (Projects, Groups, Not in a group yet), with conversations indented under their project.
2. One obvious next action: every row is a whole-width link to open that conversation; there is no competing button.
3. Calm spacing and type: even row spacing, readable type, each section folded under its own heading.
4. No internal ids or raw formatting: titles and counts only ("Web Dashboard · 2 conversations").
5. Polish matched across surfaces: this is the web console; the phone apps draw the same server tree in their own repos, and this change makes the web match their placement of a one-conversation group.

- Before: /Users/adriana/echo-compute/echo/.instar/state/handoffs/telegram-parity/shots-3919/web-conversation-tree-before-390.png
- After: /Users/adriana/echo-compute/echo/.instar/state/handoffs/telegram-parity/shots-3919/web-conversation-tree-after-390.png

## 7. Multi-machine posture

The conversation tree is read from the same authorized server projection as the other owner surfaces and reports partial coverage. Preferences for collapse and sorting are local to the browser.

## 8. Rollback cost

Revert the web change. There is no data migration or server setting to restore.

Complete single-conversation branches become a direct row. The row uses the existing conversation link and unread badge, with project status from the existing Projects read when it is available. Incomplete branches retain their disclosure. Chromium verified that Projects and Groups fold together independently and retain those choices across reload at 390 and 1280 pixels.

## Merge of main 49dc53022 and review fixes, 2026-11-28

Main 49dc53022 was merged with merge.renames=false and merge.directoryRenames=false (merge commit db11a141b; console.css auto-merged, and the branch's 44 added lines are unchanged). A first independent review concurred with changes. Three of its findings are fixed: a conversation whose project header is missing no longer vanishes from grouped view; a one-conversation group keeps its name on its row; and the Groups view falls back to the older roots view on any tree failure instead of only on 404 and 503 (sign-in refusals were already sent to unlock earlier). Tests changed or added: the hidden-conversation case, the group-name case, and a tree 500 that falls back to roots. Left as recorded suggestions, not in this PR: a status note when the fallback is used, the chat title as a second line on a one-conversation group row, keeping loaded pages across a refresh, and sorting by the shown project title.

## Second-pass review

**Reviewer:** independent read-only sub-agent (general-purpose, fresh context), 2026-11-28 00:49 PT. Verdict: CONCUR. "I reviewed the uncommitted diff on db11a141b and the 390x844 retakes web-conversation-tree-before-390.png and web-conversation-tree-after-390.png; both fixes show as intended with no clipping, duplicates or internal ids." The first reviewer (00:30 PT, concur with changes) checked escaping (every name goes in as text), duplicate placement (one shared seen set), malformed payloads and the console.css merge, all clean.

