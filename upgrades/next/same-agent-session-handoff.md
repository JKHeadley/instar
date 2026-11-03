# Session handoffs stay out of the user's chat

<!-- bump: patch -->

## What Changed

A message from one session to another session of the same agent (`POST /messages/send` with the same `to.agent` and a named `to.session`) is now typed into the target session as an `[AGENT MESSAGE]` block. Before this change it was saved, left at phase `sent` and never delivered. If the target session is not running, is busy with human input or shows an unsafe foreground program, the message becomes `queued`, and the existing delivery retry loop retries it every 30 seconds for about 5 minutes. A same-agent message's reply line now points to the sender's session instead of `threadline_send`.

CLAUDE.md gains "Talking to my other sessions (never through a user topic)", added to existing agents by `migrateClaudeMd`.

## What to Tell Your User

My sessions now have a private way to hand each other work, so their coordination no longer needs to go through your chats. You'll still get real progress updates in each topic.

## Summary of New Capabilities

- Sessions of the same agent can hand each other work privately with `POST /messages/send`. The message is delivered into the target session, or queued and retried for about 5 minutes.

## Evidence

- Live incident 2026-11-03 16:12Z: a desk session's 739-character "please own a bounded … preflight experiment" request reached the operator in a user topic. The tone-gate log shows it reviewed at 15:35, 15:37, 15:57 and 16:11 for topic 130715. The desk's pane shows it was sent there with telegram-reply.sh as "throughput coordination".
- Live probe on the same server: `POST /messages/send` to another session of the same agent returned `phase: "sent"` and was still `sent` with 0 attempts later. Nothing was delivered.
- New unit tests (router: delivered / queued on dead session / queued on throw / refused for a non-owned session / 'best' untouched / server wiring; formatter reply line; CLAUDE.md template and migration) fail on the old code where applicable and pass now. Integration `/messages/send` delivers into a session and queues for a dead one. The e2e messaging lifecycle and multi-agent suites pass.
