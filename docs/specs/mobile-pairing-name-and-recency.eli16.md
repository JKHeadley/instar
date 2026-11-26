# Pairing link names the agent; app sorts conversations by recency — Plain-English Overview

> The one-line version: the pairing screen on your phone says which agent you are adding before you tap anything, and the app's conversation list shows the most recent conversation first, like Telegram.

## The problem in one breath

Justin's first real pairing (2026-10-31) showed only the agent's web address on the confirm screen, not its name, and the app's conversation list was in alphabetical order, so old system notices sat at the top and the live conversations were buried.

## What already exists

- The pairing link carries the agent's address and a one-time code, all in the part of the link that never reaches a server.
- The agent already keeps, for every conversation, when its last message was, and can list conversations newest first.
- A paired phone may make only a fixed list of read requests.

## What this changes

- The pairing link also carries the agent's own name, cleaned and limited to 40 characters. The app shows it on the confirm screen ("Pair with Echo"). It is for display only: the address and the private code still decide everything.
- A paired phone may also read the conversation recency list, so the app can sort newest first.

## Safeguards

- The name in the link is never trusted for anything but display; a link with a strange name still pairs only with the address it names, and only after the private code.
- The new phone permission is one read-only list of conversation ids, names and last-activity times, the same kind of data the phone can already read.

## What you need to decide

Nothing.
