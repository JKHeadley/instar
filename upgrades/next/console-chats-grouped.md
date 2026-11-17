# Dashboard conversation list grouped by effort, with a Grouped | All toggle

<!-- bump: patch -->

## What Changed

The dashboard's Conversations list (Work, Conversations) is now grouped by the conversation hierarchy. The Chief of Staff conversation sits at the top; each top-level effort shows as one row with its name, how many conversations it holds, their unread total and the newest time, and opens inline to show its conversations. Conversations not placed under an effort are listed under "Not grouped yet", with a "Review suggestions" link to the existing suggestions page. A "Grouped | All" toggle at the top switches to the full flat list at any time, and the browser remembers the choice. Pinned conversations keep their own section at the top. When the hierarchy is not available (switched off, or not readable from this browser), the list is exactly the flat list it was before and the toggle is hidden.

## What to Tell Your User

- **A tidier conversation list**: "Your conversation list in the dashboard is now grouped: the Chief of Staff on top, then one row per effort that you can open, then anything not grouped yet. If you want everything in one long list, tap All at the top; the dashboard remembers which one you picked."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversations list grouped by effort, Chief of Staff on top | Automatic on the dashboard's Conversations list |
| Switch between the grouped list and the full flat list | Tap Grouped or All at the top of the list |

## Evidence

Tests: `tests/unit/console-chats-model.test.ts` (top-level effort index, nested efforts roll up, malformed hierarchy reads as none, grouping with count and unread, remembered view) and `tests/unit/console-chats-page.test.ts` (the shipped page in jsdom: signed hierarchy read, Chief of Staff first, collapsed effort row, Not grouped yet with the suggestions link, inline expand, All remembered, and 403/404/503 falling back to today's flat list with no toggle).
