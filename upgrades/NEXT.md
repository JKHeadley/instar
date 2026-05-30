# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Threadline session-completion retirement now matches real SessionManager
bindings.**

The previous retirement hook listened for `sessionComplete` and reverse-looked
up conversations by bound session name. A live canary showed the real inbound
Threadline spawn path persists the SessionManager session id as `sessionUuid`,
while the visible bound name can be the short logical thread name. That meant a
completion event could legitimately demote zero threads even though the worker
had finished.

Fix: `ThreadResumeMap` now supports a side-effect-free reverse lookup by
SessionManager UUID, `ThreadlineRouter.onSessionComplete()` unions the
session-name and UUID matches, and the server passes `session.id` into the
router. The existing awaiting-reply guard still applies to both match paths.

## What to Tell Your User

Threadline active-thread cleanup now works with the real session identifiers
emitted by the server, not only mocked tmux-name bindings. Completed worker
threads retire promptly, while threads waiting for a peer reply stay active.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| SessionManager UUID completion matching | Automatic when a Threadline worker session emits `sessionComplete` |
| Name + UUID deduped completion lookup | Automatic — a thread matching both paths is demoted once |

## Evidence

- **Focused local tests:** `npm test -- tests/unit/threadline/ThreadlineRouter.test.ts tests/unit/threadline/ThreadResumeMap.test.ts` — 78/78 passed, including the real-shape UUID fallback regression.
- **Side-effects review:** `upgrades/side-effects/threadline-session-complete-retirement.md`.
