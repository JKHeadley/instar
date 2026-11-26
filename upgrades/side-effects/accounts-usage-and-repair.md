# Separate account usage from sign-in repair

The Accounts renderer projects usage from existing quota windows and repair status from exact account and machine records. Changes to sorting and grouping affect usage only. Routine gaps, stopped repairs and disabled sign-ins remain status rows. An explicit owner-only condition can still offer the established guarded sign-in path. The account details sheet keeps deliberate management controls and machine names.

The server adds a list of machines that returned an account inventory, including an empty one. A failed peer does not enter the list. This is a read-only signal that helps the browser distinguish a missing slot from unknown coverage. It schedules no work and grants no authority. No device policy, credentials, config or storage change.

Rollback is a revert of the follow-up. Older client and server versions remain compatible with the additive machine list.

## 6b. Operator-surface quality

- Known usage and reset times lead the ordinary page. Group and sort controls act on usage only.
- Sign-in repair is one named section with one summary per affected machine. Expanding the summary shows its affected accounts. Machines with confirmed sign-ins for every account share one summary. Unchecked sign-ins stay in the machine’s status. Routine repair rows have no Ask or sign-in action. A real owner-only sign-in still leads when present.
- Names and plain status copy are displayed. There are no raw machine or account identifiers on the page.
- Chromium tests exercise 390 and 1280 pixels in both themes, including overflow and the grouping controls' minimum hit area.
