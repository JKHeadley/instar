---
change_type: fix
---

## What Changed

`src/threadline/OpenClawBridge.ts` mints thread ids with real entropy instead of a bare millisecond timestamp. The id was `openclaw-${roomId}-${Date.now().toString(36)}` — no agent component and no randomness — so two DIFFERENT agents resolving a thread in the SAME room within one millisecond received an identical threadId, and `ContextThreadMap`'s reverse index then collapsed both agents onto one thread. Isolation between two agents' conversations in a shared room is precisely what the threadId exists to provide.

The timestamp is kept for readability and rough ordering; uniqueness now comes from `randomBytes(8)`, never from the clock.

## Evidence

Caught as an intermittent failure of `tests/e2e/threadline/ThreadlineFullStack.test.ts` Scenario 8 on 2026-08-23: `expected 'openclaw-room-a-mt6h30po' not to be 'openclaw-room-a-mt6h30po'`. Both agents, one id.

The defect was already known and worked around rather than fixed. `tests/unit/threadline/OpenClawBridge.test.ts` carried a test named "different agents get different threads for same room" that passed only because of a `setTimeout(2)` inserted mid-test with the comment *"Small wait to ensure different Date.now() for threadId generation"*. The sleep bought the millisecond the id could not supply, so the assertion passed for a reason unrelated to the property it claims to check. The sleep is removed; that test now fails without the fix.

Two new frozen-clock regressions pin both sides of the boundary: two agents in one room at the same millisecond must get DIFFERENT threads, and the same agent re-entering must keep ONE thread (entropy must not leak into the reuse path and shatter continuity). Verified by reverting the fix: 2 of 89 fail, and only those 2. With the fix, 89/89.

## Known Limits

`ContextThreadMap` keys mappings by contextId alone, with agent identity as a binding CHECK rather than part of the key. In a room shared by several agents the last writer's mapping is the one stored, so an earlier agent's lookup returns null and it mints a fresh thread. That is a separate design question about the map's key, not an id-uniqueness defect, and it is not addressed here.

## What to Tell Your User

If two of your agents talk in the same shared room, each keeps its own conversation thread — reliably now, rather than almost always. Previously the thread name was built from the room name and the clock alone, so two agents arriving in the same millisecond could be handed the same thread and their conversations would merge. Threads created before this change keep their existing names and are unaffected.

## Summary of New Capabilities

No new capability. An existing guarantee — one thread per agent per room — now actually holds instead of holding whenever the two agents happened to be more than a millisecond apart.
