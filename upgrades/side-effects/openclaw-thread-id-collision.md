# Side-Effects Review — thread ids stop depending on the clock for uniqueness

**Slug:** `openclaw-thread-id-collision`
**Date:** 2026-08-23
**Risk floor:** 2 (correctness fix in a cross-agent isolation path; no external surface)

## Summary of the change

`OpenClawBridge` minted thread ids as `openclaw-${roomId}-${Date.now().toString(36)}`. Two different agents resolving a thread in the same room within one millisecond got the same id. A `randomBytes(8)` suffix is added; the timestamp remains for readability only.

## Decision-point inventory

One: where uniqueness comes from. Previously the clock. Now entropy. No branch, threshold or policy is introduced.

## 1. Over-block

None possible. The change cannot cause a refusal — it only widens the id space.

## 2. Under-block

The relevant question is whether uniqueness can still fail. `randomBytes(8)` is 64 bits; a collision requires the same room, the same millisecond AND a 1-in-2^64 draw. This is no longer a timing property.

## 3. Level-of-abstraction fit

Correct level. The id is minted in exactly two places, both in `resolveThread`, and both now call one helper — so the property has a single home rather than two copies that can drift.

## 4. Signal vs authority compliance

Signal only. The id names a thread; it grants nothing and is not consulted for a decision.

## 4b. Judgment-point check

None. No judgment is made from this value.

## 5. Interactions

- **`ContextThreadMap`** keeps a reverse index `threadId → contextId`. Colliding ids were what let two agents collapse onto one thread, so this is the consumer the fix protects. Its keying (contextId alone, agent identity as a binding check) is a separate question, named under Known Limits and NOT changed here.
- **Existing threads** keep their ids; the map is not rewritten. Old ids remain valid and resolvable.
- **Length** grows by 17 characters. No downstream store bounds the id.

## 6. External surfaces

None. No route, no message, no notification.

## 6b. Operator-surface quality

Invisible to the operator, except that the intermittent CI failure stops.

## 7. Multi-machine posture

`unified`. Ids are minted per-process and were never coordinated across machines; adding entropy makes a cross-machine collision strictly less likely rather than more.

## 8. Rollback cost

One line. Reverting restores a race that gets more likely as the code gets faster, which is why it should not be reverted quietly.

## Conclusion

Ship.

## Phase-5 second pass

**Not required, and not run** — none of the Phase-5 triggers apply: no block/allow decision, no session lifecycle, no compaction, no coherence gate, trust level, sentinel, guard, gate or watchdog. Saying so explicitly because the section below is a review finding of my own and must not be mistaken for an independent reviewer's concurrence.

## The finding that outlives the fix

The defect was not undiscovered. A unit test named "different agents get different threads for same room" existed and PASSED, because a `setTimeout(2)` had been inserted mid-test with the comment *"Small wait to ensure different Date.now() for threadId generation"*. Someone met the collision, understood it precisely enough to describe its cause in one line, and spent that understanding on making the test go green.

The test then actively concealed the defect: anyone auditing "is agent isolation tested?" found a green test with the right name. Only the e2e — which had no sleep and no such comment — could still fail, and it did, intermittently, which reads as flake rather than defect.

**The class:** a sleep inserted to make a test pass is a defect report written in the wrong file. This is not searched for anywhere in this repo, and I am not claiming otherwise.

## Evidence pointers

- e2e failure, run 32674712573: `expected 'openclaw-room-a-mt6h30po' not to be 'openclaw-room-a-mt6h30po'` at `tests/e2e/threadline/ThreadlineFullStack.test.ts:1032`.
- `tests/unit/threadline/OpenClawBridge.test.ts` 89/89 with the fix.
- Negative control run: with the entropy removed, exactly 2 of 89 fail — the de-slept original and the new frozen-clock regression. The tests bite.

## Class-Closure Declaration (display-only mirror)

The class is "an identifier whose uniqueness rests on wall-clock resolution." Closed for `OpenClawBridge`. NOT closed generally: other id-minting sites in this repo have not been enumerated, and the sibling class named in the second-pass review — a test made green with a sleep — is not swept for at all. Named, not claimed.
