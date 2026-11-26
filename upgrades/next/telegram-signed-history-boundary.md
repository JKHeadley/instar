<!-- bump: patch -->

## What Changed

Older Telegram history pages on signed devices now apply the same time
boundary to messages recovered from the App store.

## What to Tell Your User

Scrolling back in a Telegram conversation keeps showing older messages
even when a recent App message has rotated out of the Telegram log.

## Summary of New Capabilities

None. This repairs the existing history paging behavior.

When another machine has more messages to return, the server also keeps
recovered rows from advancing the scroll past those messages.
