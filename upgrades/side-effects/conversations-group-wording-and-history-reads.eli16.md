# Conversations says "group", and old messages load again (plain overview)

## What this is

The Conversations page in the dashboard sorts your chats with the agent into bundles of related work. The code calls a bundle an "effort". On 17 November the owner decided the word people see should be "group". This change swaps the word everywhere a person reads it: the page title "Your groups", the "Suggested groups" page, the "Create group" and "Rename group" buttons, the name box, the "Open group" link, the empty-page line ("No groups yet. Your conversations are in All."), and the smaller notices. The agent's own instructions also change, so when it talks to you it says "group" too. Nothing underneath changes: the internal names, the web addresses and the stored data keep the old word, so nothing has to be converted.

## The second fix

When you open a conversation on that page, it shows the conversation's original messages under it. On the Studio this mostly failed with "The original history could not be loaded." The cause: before showing the messages, the server asked "have I proven in the last minute that I may make changes?" That proof is redone in the background, it is wiped while it is being redone, and on a busy machine the redo takes long enough that the answer was "no" most of the time (25 of 30 tries in a three-minute test). But showing messages is not making a change. The server now asks the same question it already asks before it shows the page itself: "may I show this person private things right now?" If the page could show you the conversation, it can now show its messages.

## Safeguards

- You still have to be the signed-in owner, and that is checked before and after the messages are fetched.
- The conversation still has to be one the page is allowed to show you.
- While the agent is moving its records between computers, the "may I show private things" check says no, and the messages are held back, exactly like the page.
- The messages shown are the same ones the agent already reads for itself from Telegram, Slack or the app.

## What is still open

The line "Syncing with another machine. Some original history is unavailable." can still appear. It comes from a different place: the agent's two computers not fully agreeing on what each has recorded. That needs a deeper fix in how the computers talk to each other and is reported separately; it is not part of this change.

## What to decide

Nothing beyond normal review: this is small and a revert undoes it completely.
