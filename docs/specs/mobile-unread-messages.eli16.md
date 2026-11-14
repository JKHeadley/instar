# Unread messages in the Instar app — plain overview

## What this is

Justin asked for the Instar iPhone app to know which messages he hasn't read yet, the way Telegram does: a number on each conversation in the list, a total on the Chat tab and on the app icon, an "Unread messages" line where he left off, and a button that jumps to the bottom and says how many new messages are waiting.

To do that, the agent's server has to remember, for each person and each conversation, how far that person has read. This spec is that server part, plus the rules the app follows so the two halves agree.

## What already exists

The app already lists app, Telegram and Slack conversations together, and it can read each one's messages. The agent can already send a phone notification when it replies in an app conversation. What's missing is any record of what has been read: the server doesn't know, so the app can't show a count.

## What's new

- **A read marker.** For each person and conversation, the server keeps "read up to this message". All of the owner's phones share one marker, so reading on one phone clears the count on the others, and reinstalling the app loses nothing. Each team member has their own.
- **It only moves forward.** If two phones or two of the agent's machines report at the same time, the furthest point wins, so they always end up agreeing.
- **Unread counts on the list**, counted on the server from the messages after the marker, not counting your own messages.
- **Your own reply counts as reading.** Telegram and Slack don't let the agent see what you've read in their own apps. But if you reply there, everything before your reply is treated as read. The app says this plainly on Telegram and Slack conversations.
- **A route for the phone to say "I've read up to here"** as messages scroll into view, sent in small batches.
- **The app icon badge**: the agent's reply notifications now carry the total unread number.

## Safeguards in plain terms

- A phone can only mark or see counts for conversations its person is already allowed to see. The existing access check is reused, not a new one.
- The first time this appears, nothing shows as unread. Otherwise every old conversation would suddenly show "99+" on every phone at once.
- Counting never reads more than one page of messages per conversation, so the list stays fast. Above that, it says "99+".
- It works across all of the agent's machines: the marker is copied to each machine like the app conversations already are.
- No new notifications for Telegram or Slack messages, since those apps already notify you. Their counts still show in the app.
- An older agent without this feature keeps working: the app keeps the marker on the phone instead.

## What you need to decide

Nothing new. The choices were made with the coordinator: no Slack sign-in for Justin's own account for now, the marker is copied between machines, and the first view after the update starts at zero unread.
