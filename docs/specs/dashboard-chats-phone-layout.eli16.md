# Dashboard conversations: the message box stays on screen on a phone — Plain-English Overview

> The one-line version: two small fixes to the dashboard Conversations page that #2966 added. They were found while proving it live in a real browser.

## What was wrong

1. **On a phone-size screen, a long conversation pushed the message box off the screen.** The list of messages grew to fit all of its messages, so you had to scroll past the whole conversation to reach the box you type in, and it sat behind the bottom tab bar. Short conversations looked fine, which is why the first live check passed.
2. **A conversation opened from a link showed the title "Conversation".** When the page was reloaded, or opened straight from a link to one conversation, the header kept that placeholder instead of the conversation's real title, because the title was only read once, before the list had arrived.

## What changes

1. At phone width the open conversation now fits between the top bar and the bottom tab bar. The messages scroll inside it, and the message box always stays on the first screen, however long the conversation is. The desktop layout already worked this way.
2. When the conversation list arrives, the header picks up the real title.

## What stays the same

Everything else. No server change, no new routes, no stored data. Revert the commit to undo both fixes.

## What you need to decide

Nothing. These are fixes to a page that has already shipped, found by the live proof the brief requires before "done".
