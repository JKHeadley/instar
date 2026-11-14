## What Changed
- **A Telegram photo or file is readable on the machine that runs the session.** On an agent with more than one machine, a photo stayed on the machine that polls Telegram, and a session on another machine was told to read a path that existed only there (F3 in `docs/specs/native-conversation-base.md`). A file now travels by attachment id in a structured `media` field (Telegram adapter, lifeline, app files sent into a topic, the mesh `deliverMessage`, the durable inbound queue, spawn and respawn bootstraps), and the machine serving the session builds the file line itself: a private copy when the file is here, `[file still copying: <name>]` and later one `[file now available: <path>]` line when it arrives, and after 5 minutes one line saying it has not arrived yet (the wait continues). Where native media is off, the session is told the file is stored on another machine.
- **Text a person types is never read as a file.** Every path tag form (`[image:`, `[document:`, `[video:`, `[voice:`, `[file:`) in person-supplied text becomes `[typed image:` and so on, on Telegram, the lifeline, Slack and iMessage, before it is forwarded, queued or logged. Before, anyone who could post in a conversation could make the session read any readable file on the machine.
- **Older machines stay truthful.** The text always carries one path-free sentence per file ("[The user sent a photo (attachment `<id>`, `<name>`). It is stored on another machine and cannot be opened here.]"), so a machine still on the previous release tells its session a photo was sent and which one. A message from an older poller is resolved by its own message id and its path is discarded.
- **Lifeline-forwarded files are now captured** into the media store like polled ones, so they can follow the session to another machine.
- **Topic history never holds a path**: a file shows as `[photo]`, `[file: <name>]`, `[video]` or `[voice note]` with the caption.
- **New routes.** `GET /conversation-media/path?conversationKey=telegram:<topicId>&platformMessageId=<id>` (or `&attachmentId=`), Bearer plus the session bind token, returns a readable local path or `not-on-this-machine` with the reason. `GET /conversation-media/status` shows waiting files, the observed event lag and outcome counts.
- **Storage.** The inbound queue gains a nullable `media` column and the media index gains a `pending_media_events` table, both created on open. A durable sweep (at start and every 30 seconds) reconciles waiting files, and retries a "now available" line that found no running session.

## What to Tell Your User
When you send me a photo or a file in Telegram, I can now open it even when the conversation is running on a different one of my machines; if it is still on its way I say so and pick it up when it lands. And if someone types something that looks like a file reference, I treat it as their words, not as a file to open.

## Summary of New Capabilities
- Telegram files by attachment id through every carrier, resolved on the serving machine.
- Typed path tags are inert on Telegram, Slack and iMessage.
- `GET /conversation-media/path` and `GET /conversation-media/status`.

## Evidence
- `tests/unit/inbound-media.test.ts`: each tag kind escaped, in a caption and alone, yields no file line under the previous release's injector patterns; escaping twice equals once; the fallback sentence; field parsing.
- `tests/unit/platform-media-for-session.test.ts`: event and blob here; blob late; event after the message; blob already here when the event lands; the event between the first look and the waiter insert; a restart healed by the start-up sweep; listener and sweep together give one line; the 300 s line once with the row kept and a later "now available"; no session, then one line when a session runs.
- `tests/unit/forwarded-inbound-media.test.ts`, `tests/unit/inbound-media-carriers.test.ts`: lifeline path confinement and the position-0 rule; Slack and iMessage escapes; the Telegram adapter producer; the lifeline body; the queue column migration.
- `tests/integration/conversation-media-path.test.ts`: the route by both ids, 404 for another conversation's file, 403 without the bind token; a new poller read by an older receiver, an older poller read by a new server.
- `tests/e2e/app-media-cross-machine-alive.test.ts`: two servers on the production path; the serving machine injects at once with the copying line, then exactly one "now available" after the file crosses the signed mesh; a photo then a text keep their order.
