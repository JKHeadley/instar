---
title: Exact App message links
---

When a person asks for a link to a specific App message, resolve its stored event ID on the serving agent with `GET /mobile/conversations/message-link?ref=app%3A<uuid>&messageId=<event-id>&targetKind=event&reader=owner` using the agent's existing authenticated transport. The feature is off by default. A successful response has the conversation, message ID, event ID and a shareable HTTPS link. A link gives the recipient no access they do not already have.

Use `GET /mobile/chat/app/<uuid>/message-context?target=<event-id>&targetKind=event&reader=owner` to read around the exact message. Require a matching `anchorApplied` and visible row. A 409 means the serving copy cannot provide that message for the current reader. An unavailable message link must never open a nearby message.
