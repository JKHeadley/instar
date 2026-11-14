# Side effects: dashboard Conversations approval message + top-level sidebar entry

## What changed
1. `TelegramAdapter.sendOwnerDMWithButton` sends inside `verifiedReplyEnvelope('verified-mobile-approval')`.
   Its only caller is the mobile pairing service's `ownerDM` (AgentServer): the code plus Approve/Decline
   for a new phone or a new browser, and the "approved with Face ID" record.
2. Dashboard console: a top-level "Conversations" sidebar/bottom-bar entry under Home, shown only while
   the Work tile's own probe (`/mobile/browser-devices/status`) answers 200. The phone bottom bar's grid
   takes 5 or 6 entries (auto columns instead of a fixed 5).

## Why
Live on Echo, 2026-11-08 20:07: "Set up this browser" answered "I could not send you the approval
message in Telegram". Server log: `sendOwnerDMWithButton failed: Notification recorded in the quiet feed`.
With quiet-by-default enforcing, the unlabelled owner message was held as a routine notification, so the
setup was cancelled. The same path sends phone pairing codes, which were held the same way.
Justin, same evening: "It should show directly in the sidebar menu on the top level."

## Review
1. Over-block: none added. The change lets through messages that were wrongly held.
2. Under-block: routine output stays held; the new test asserts a later unlabelled topic send is still recorded.
3. Level of abstraction: the label sits at the one owner-DM-with-buttons funnel, inside the file the funnel lint
   allows to mint reply envelopes; the same label already covers the post-approval confirmation (line ~1119).
4. Signal vs authority: no new decision point. The selectivity gate keeps its authority; this names the message correctly.
5. Interactions: the owner-DM send does not touch any topic's waiting state (test asserts `latestInbound` unchanged).
   Spam risk: these messages are only sent when someone opens a pairing link the owner minted or sets up a browser
   after unlocking the dashboard with the PIN; both are already rate-limited by the pairing service.
6. External surfaces: the owner now receives pairing/browser approval messages in Telegram again.
   Dashboard: one more navigation entry where Conversations is on; none where it is off.
## 6b. Operator-surface quality
- (1) Primary action first: the entry is the way in to the Conversations page itself, placed right under Home.
- (2) No raw internals: the entry is the word "Conversations" with the same chat icon as the Work tile.
- (3) Destructive actions: none added.
- (4) Plain language at phone width: checked at 390x844 (six bottom-bar entries fit on one row, labels whole)
  and 1280x728 (sidebar entry under Home, highlighted on its own page).

7. Multi-machine: unchanged. Approval is still sent only by the machine holding the Telegram lease.
8. Rollback: revert the commit; no state, config or migration.
