# Dashboard conversations: the message box stays on screen on a phone — Plain-English Overview

> The one-line version: small fixes to the dashboard Conversations page that #2966 added. They were found while proving it live in a real browser, including in a real Telegram test group.

## What was wrong

1. **On a phone-size screen, a long conversation pushed the message box off the screen.** The list of messages grew to fit all of its messages, so you had to scroll past the whole conversation to reach the box you type in, and it sat behind the bottom tab bar. Short conversations looked fine, which is why the first live check passed.
2. **A conversation opened from a link showed the title "Conversation".** When the page was reloaded, or opened straight from a link to one conversation, the header kept that placeholder instead of the conversation's real title, because the title was only read once, before the list had arrived.

3. **A message sent into a Telegram topic stayed at "sending".** A Telegram send answers "delivered" in a different field than an app send, so the page never saw it finish. The message showed twice, once as "sending" and once as delivered, and stayed that way.
4. **With no Telegram owner, a send into Telegram said "sending" forever.** The agent refused it ("no Telegram owner to speak as"), but the page kept retrying without saying why. The setup answer also claimed sending to Telegram was possible.

## What changes

1. At phone width the open conversation now fits between the top bar and the bottom tab bar. The messages scroll inside it, and the message box always stays on the first screen, however long the conversation is. The desktop layout already worked this way.
2. When the conversation list arrives, the header picks up the real title.
3. The page reads a Telegram or Slack send's answer correctly. Once the agent holds a message this browser signed, the "sending" copy goes away right away.
4. A refusal that names its reason is shown as "not delivered" with that reason, and is not retried. The page is only told that it can send to Telegram when the agent has a Telegram owner to speak as, and when it cannot, the note on the topic says the real reason.

## What stays the same

Everything else. One server line changed: what the status answer says about Telegram sending. No new routes, no stored data. Revert the commits to undo the fixes.

## What you need to decide

Nothing. These are fixes to a page that has already shipped, found by the live proof the brief requires before "done".
