# Dashboard conversation list grouped by effort (ELI16)

## What this changes

The dashboard has a Conversations list: every conversation with the agent, newest first, from the app, Telegram and Slack. With many conversations running at once, that list got long and hard to scan. Instar already keeps a map of how conversations belong together: an "effort" (a piece of work, like "the Windows app") holds the conversations that work on it, and the Chief of Staff conversation sits above all of them. That map was only drawn on a separate page. The list the owner actually uses stayed one long flat list.

Now the list itself is grouped. The Chief of Staff conversation is always at the top. Under it, each top-level effort is a single row showing its name, how many conversations are inside, how many unread messages they have together, and when the newest one was active. Tap that row and its conversations open right there, slightly indented; tap again to fold them away. Conversations that nobody has placed under an effort yet appear at the bottom under "Not grouped yet", next to a "Review suggestions" link that opens the existing page where the agent's placement suggestions can be accepted or rejected.

## The Grouped | All toggle

At the top of the list there are two buttons: Grouped and All. Grouped is the tidy view described above. All is the full flat list, exactly as it looked before. You can switch at any time, and the browser remembers which one you picked, so the next visit opens the same way. If the browser blocks saving that choice, the page still works; it just starts in Grouped next time.

## What stays the same

Pinned conversations keep their own section at the very top in both views. Opening a conversation, sending, renaming and everything inside a conversation are unchanged. If the conversation you have open is inside an effort, that effort stays unfolded so its row never disappears. If the effort map is switched off, not ready, or this browser is not allowed to read it, the list is exactly the flat list it was before and the toggle is hidden, so nothing breaks for anyone.

## Safeguards

The grouping only rearranges rows the page already had; nothing is hidden for good, and All always shows everything. Which effort a conversation belongs to comes from the server's own records, never guessed from a title. Names of efforts and conversations are shown as plain text, never as web page code, so a name containing something like an image tag just shows as text. The page reads the effort map at most once a minute, uses the same sign-in the list already uses, and never asks for the PIN just to group the list.

## What you need to decide

Nothing. This is the change the owner asked for on 2026-11-17, it is display-only, and undoing it is a single revert with nothing stored on the server to clean up.
