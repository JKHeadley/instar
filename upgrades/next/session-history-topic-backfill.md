## What Changed

- A session's History on the dashboard now continues past the start of the current session into the conversation's earlier messages, back as far as the message log goes. The topic-messages route accepts a `before` time to page backwards.

## What to Tell Your User

Scroll up in a session's History and it keeps going into the earlier part of the conversation, not just the current session.

## Evidence

- History for a topic that began on Oct 20 stopped on Oct 31, where its current session started. Unit and integration tests cover the backwards paging (including very large log files and characters split across read chunks) and the route's new `before` parameter; the dashboard keeps only strictly older messages, so an older server cannot cause repeats.

## Summary of New Capabilities

- `GET /telegram/topics/:id/messages?before=<ISO or epoch ms>` returns messages older than that time.
