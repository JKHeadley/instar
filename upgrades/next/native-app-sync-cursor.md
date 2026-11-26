<!-- bump: patch -->

## What Changed

App conversation history cursors now bind to the conversation as well as
the serving machine. A cursor from another conversation or an older
unscoped cursor restarts the read.

## What to Tell Your User

Switching App chats can no longer cause the server to skip early messages
because it received the previous chat's saved position.

## Summary of New Capabilities

None. The existing incremental history response still uses an opaque cursor.
