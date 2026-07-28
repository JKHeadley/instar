# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Threadline now retires completed worker threads promptly when their backing
session finishes.**

Previously, a Threadline conversation bound to a worker session could remain in
the active-thread set until the stale-retirement backstop cleaned it up, even
after `SessionManager` had already emitted `sessionComplete` for the backing
session. That made completed conversations look live longer than they were.

Fix: the server now forwards `sessionComplete` into `ThreadlineRouter`, the
resume map can reverse-lookup live conversations by `boundSessionName`, and the
router demotes completed non-awaiting conversations through the existing
`onSessionEnd` lifecycle path. Conversations still waiting on a remote reply stay
untouched, and the reverse lookup is side-effect-free so a completion event for
one session cannot archive unrelated stale threads.

## What to Tell Your User

Threadline conversations will now leave the active set as soon as their worker
session actually completes, instead of waiting for the old stale cleanup window.
This makes active-thread state match reality sooner while preserving
conversations that are still waiting for a peer response.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Prompt Threadline retirement on session completion | Automatic when a bound worker session emits `sessionComplete` |
| Awaiting-reply preservation | Automatic — conversations waiting for the peer are not demoted by worker completion |

## Evidence

- **Focused local tests:** `npm test -- tests/unit/threadline/ThreadlineRouter.test.ts tests/unit/threadline/ThreadResumeMap.test.ts` — 77/77 passed after rebasing onto `v1.3.118`.
- **Full PR matrix before main refresh:** docs, repo invariants, type, all 8 unit shards on node 20/22, build, integration, e2e, worktree trailer verify, and Vercel passed on PR #568 before the branch was refreshed onto `v1.3.118`.
- **Side-effects review:** `upgrades/side-effects/threadline-session-complete-retirement.md`.
