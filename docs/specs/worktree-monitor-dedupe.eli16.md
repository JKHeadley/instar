# Worktree notices on change, and no intent extraction for automated sends — Plain-English Overview

> The one-line version: the worktree monitor now speaks only when something changed, and the topic-intent clerk stops reading the agent's automated alerts.

## The problem in one breath

After almost every job session, and on a five-minute timer, the worktree monitor posted the same two warnings about the same unmerged branches. On 29 September that was 549 of the 724 messages the agent sent. Each of those warnings was then fed to the topic-intent extractor, an LLM call that tracks what a conversation is about. About two thirds of that extractor's spend went on these automated alerts. Most of it recorded nothing, and the rest was the same "unmerged branches" fact over and over.

## What already exists

- **The worktree monitor**: checks git worktrees after each session and every five minutes, and posts a warning through the notification system.
- **Message provenance**: every message the agent sends or receives is stamped at the send seam as `user`, `agent` (a conversational reply) or `automation` (a job, monitor or system send). The stamp comes from how the message was sent, never from its text.
- **The topic-intent capture loop**: runs the extractor on each substantive message, after a cheap filter drops acks and status lines.

## What this adds

The worktree monitor remembers which branches it last warned about, per warning type, and saves that list to disk. It posts again only when the list changes: a new branch appears, or one is merged or deleted. If the same list stays open, it reminds once a day. A restart does not repeat the warning, and a failed send is not recorded as sent, so the next scan tries again.

The capture loop skips messages stamped `automation` before any LLM call. User and agent messages are extracted as before. Rows with no stamp (older data) are also still extracted.

## The safeguards

**A real change still gets through.** Any added or resolved branch changes the list and triggers a post. The daily reminder keeps a long-open branch from being forgotten.

**Nothing conversational is lost.** The skip keys on the structural stamp, not on words in the message. The rolling topic summary still covers automated messages, so the next conversational extraction sees them as context.

**Easy to see.** The last-scan report at `/hooks/worktrees/last-report` records when an unchanged finding was suppressed, and the capture metrics count skipped automated turns.

## What ships when

One PR: both changes, their tests, a short CLAUDE.md section (for new agents through the template and for existing agents through the update migration), and the release note.
