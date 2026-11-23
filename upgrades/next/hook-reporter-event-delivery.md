# Hook events from the default reporter now arrive under their real names

<!-- bump: patch -->

## What Changed

The built-in command hook reporter (`hook-event-reporter.js`, the default on every agent) read the event name from
`hook_event`, but Claude Code sends `hook_event_name`. Every turn-end (`Stop`), helper start and stop, task completion,
session end and pre-compaction event was stored as `Unknown`, and the reporter never put the instar session id in the
payload, so the features that listen for those events (subagent tracking, compaction Trigger 1, the context-budget
practice-fold trigger) never heard them on agents without the native reporter. Both copies of the script now read
`hook_event_name` first (the old spelling still works), validate the session id once, add `instar_session_id` and
`instar_session`, and forward the native reporter's short identifying fields, bounded in the script. No message text is
sent from the script. The `/hooks/events` route applies the native path's bounds to those fields and uses one validated
session id for storage and dispatch. Spec: `docs/specs/hook-reporter-event-delivery.md`.

## What to Tell Your User

- **Background features now see what sessions are doing**: "Some of my background checks, like noticing a stuck helper or a session about to compact its memory, were not receiving the signals they were built on. They receive them now, so those checks actually run."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Command-path hook events carry real names and the session id | Automatic after update; read them with `GET /hooks/events/:sessionId` |
