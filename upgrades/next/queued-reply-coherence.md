# Queued reply coherence

## What Changed

Saved Telegram replies are retired before recovery delivery when a newer user or agent message has reached the same topic in local or pooled history. Incomplete pooled history holds the draft for later review. Automated notices and uncertain or partly delivered replies keep their existing recovery behavior. Topic-name lookup no longer sends a visible dot probe; unknown older names retain a fallback label.

## What to Tell Your User

An older saved reply will not appear after the conversation has moved on. The temporary dot used to look up a topic name is gone.

## Summary of New Capabilities

Queued reply recovery checks topic chronology across known machines before it sends.

## Evidence

The App and Baton incident timestamps, a direct recovery integration test, forward retry unit tests, and topic-name lookup tests cover the change.
