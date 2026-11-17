# Dashboard conversation list in groups, with projects marked (ELI16)

## What this changes

The dashboard has a Conversations list: every conversation with the agent, newest first, from the app, Telegram and Slack. With many conversations running at once, that list got long and hard to scan. Instar already keeps a map of how conversations belong together: a group (a piece of work, like "the Windows app") holds the conversations that work on it, and the Chief of Staff conversation sits above all of them. That map was only drawn on a separate page. The list the owner actually uses stayed one long flat list.

Now the list itself is grouped. The Chief of Staff conversation is always at the top. Under a "Groups" heading, each top-level group is a single row showing its name, how many conversations are inside, how many unread messages they have together, and when the newest one was active. Tap that row and its conversations open right there, slightly indented; tap again to fold them away. Conversations that nobody has placed in a group yet appear at the bottom under "Not in a group yet", next to a "Review suggestions" link that opens the existing page where the agent's placement suggestions can be accepted or rejected.

## Groups that are projects

Some groups are linked to a project the Chief of Staff tracks; others are plain groups. You can tell them apart at a glance. A project group has a small flag and a status chip: Moving, Stuck, Needs you, Done, Drifting or Paused (the same words the iPhone and Android apps use). When the status is not known, no chip is shown rather than a guess. Open a project group and an "Open project" link takes you to that project on the Work page, already unfolded. A plain group has a folder and its count, and never says "project". A group counts as a project when any conversation inside it, starting with its main conversation, is the conversation a tracked project belongs to. If the project list cannot be read, every group simply looks plain.

## The Grouped | All toggle

At the top of the list there are two buttons: Grouped and All. Grouped is the tidy view described above. All is the full flat list, exactly as it looked before. You can switch at any time, and the browser remembers which one you picked, so the next visit opens the same way. If the browser blocks saving that choice, the page still works; it just starts in Grouped next time.

## Words on the page

The page says "group" for the general unit and "project" only for a group linked to a tracked project. It never says "effort", which is only the internal name of the record. A group with no name reads "Untitled group".

## What stays the same

Pinned conversations keep their own section at the very top in both views. Opening a conversation, sending, renaming and everything inside a conversation are unchanged. If the conversation you have open is inside a group, that group stays unfolded so its row never disappears. If the group map is switched off, not ready, or this browser is not allowed to read it, the list is exactly the flat list it was before and the toggle is hidden, so nothing breaks for anyone.

## Safeguards

The grouping only rearranges rows the page already had; nothing is hidden for good, and All always shows everything. Which group a conversation belongs to, and which project a group is, come from the server's own records, never guessed from a title. Names are shown as plain text, never as web page code, so a name containing something like an image tag just shows as text. The page reads the group map at most once a minute, uses the same sign-in the list already uses, and never asks for the PIN just to group the list.

## What you need to decide

Nothing. This is the change the owner asked for on 2026-11-17 (grouping, the toggle, the group and project wording, and the project marks), it is display-only, and undoing it is a single revert with nothing stored on the server to clean up.
