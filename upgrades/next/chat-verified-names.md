<!-- bump: patch -->
## What Changed

Telegram conversations in the web Chats list show a verified name when one is available. Missing names and number-based placeholders display as Unnamed conversation. A later list update can fill in the title of an already open unnamed chat.

## What to Tell Your User

An unnamed Telegram chat will show a plain label instead of a topic number. It still opens the same conversation.

## Summary of New Capabilities

None. This changes how existing Telegram conversations are named in Chats.

## Evidence

A source baseline reproduced the numeric title. Model and rendered-page tests cover the fallback, links, named rows, and a title arriving after a chat opens.
