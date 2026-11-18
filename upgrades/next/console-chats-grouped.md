# Dashboard conversation list in groups, with projects marked, and a Grouped | All toggle

<!-- bump: patch -->

## What Changed

The dashboard's Conversations list (Work, Conversations) is now grouped by the conversation hierarchy. The Chief of Staff conversation sits at the top; under a "Groups" heading each top-level group shows as one row with its name, how many conversations it holds, their unread total and the newest time, and opens inline to show its conversations. A group linked to a project the Chief of Staff tracks shows a flag and a status chip (Moving, Stuck, Needs you, Done, Drifting, Paused; no chip when unknown) and, when open, an "Open project" link to that project on the Work page; a plain group shows a folder and its count. Conversations not placed in a group are listed under "Not in a group yet", with a "Review suggestions" link to the existing suggestions page. A "Grouped | All" toggle at the top switches to the full flat list at any time, and the browser remembers the choice. Pinned conversations keep their own section at the top. When the hierarchy is not available (switched off, or not readable from this browser), the list is exactly the flat list it was before and the toggle is hidden; when the projects cannot be read, every group looks plain.

## What to Tell Your User

- **A tidier conversation list**: "Your conversation list in the dashboard is now grouped: the Chief of Staff on top, then one row per group that you can open, then anything not in a group yet. Groups that belong to a project have a little flag and show how the project is doing, like Moving or Needs you, with a link straight to the project. If you want everything in one long list, tap All at the top; the dashboard remembers which one you picked."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversations list grouped, Chief of Staff on top | Automatic on the dashboard's Conversations list |
| Project groups marked with a flag and status chip, with an Open project link | Automatic; open the group to see the link |
| Switch between the grouped list and the full flat list | Tap Grouped or All at the top of the list |

## Evidence

Tests: `tests/unit/console-chats-model.test.ts` (top-level group index, nested groups roll up, members front door first, the shared status-chip mapping, project matching by any conversation under a group, failed projects read leaves groups plain, malformed hierarchy reads as none, grouping with count and unread, remembered view), `tests/unit/console-chats-page.test.ts` (the shipped page in jsdom: signed hierarchy read, Chief of Staff first, Groups heading, plain group row with folder and no "project" wording, project group row with flag, chip, aria-label and Open project link, failed projects read, All remembered, and 403/404/503 falling back to today's flat list with no toggle) and `tests/unit/console-project-apps-model.test.ts` (Open project opens that project's row on the Work page).
