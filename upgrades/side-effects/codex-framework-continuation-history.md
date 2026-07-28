# Side-Effects Review — Codex framework-switch continuation

**Date:** 2026-07-16  
**Author:** instar-codey  
**Second-pass reviewer:** pending Echo PR review

## Summary

The existing continuation context was correct, but interactive readiness recognized only Claude's
prompt. Codex therefore waited through the primary and extended readiness timeouts before the
best-effort injection, while the bridge could already route a new user message to that context-free
session. The fix recognizes Codex's prompt and makes framework handoffs await the durable bootstrap
injection before returning. A handoff with no new user message now explicitly loads context silently,
which also removes the trigger for the observed unsolicited scope narration.

## Interaction review

- Normal cold spawns keep their asynchronous durable pending-inject behavior; only framework handoffs
  opt into the await.
- The pending-inject record is still written before readiness and cleared only after injection.
- Claude readiness remains unchanged; generic shell prompts are still excluded.
- No endpoint, schema, authority, timer, or history source changes.

## Rollback

Code-only revert. Pending-inject records remain compatible and require no repair.
