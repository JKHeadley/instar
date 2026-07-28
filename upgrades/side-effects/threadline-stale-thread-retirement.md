# Side-effects review - Threadline stale thread retirement

## 1. Over-block / under-block

Over-block risk is that an ongoing but quiet Threadline conversation could be archived after 24 hours. The mitigation is that archival is non-destructive: history, metadata, remote agent identity, and thread id stay in the conversation store, and a later peer reply can reactivate the same thread. Pinned conversations are excluded entirely.

Under-block risk is that stale conversations younger than 24 hours still count as active until the threshold passes. That is intentional because a shorter threshold could retire normal overnight collaborations too aggressively. The active metric was also tightened so idle conversations stop inflating active counts immediately.

## 2. Level-of-abstraction fit

The retirement primitive lives in `ConversationStore`, which owns persisted Threadline conversation state. `ThreadResumeMap` invokes it before active-set reads because that class is the compatibility view used by Threadline surfaces. The MCP status metric is corrected at the presentation layer by counting only active states.

## 3. Signal vs authority compliance

The change does not add a brittle blocking detector. The store applies a deterministic lifecycle rule to local persisted state, and it archives rather than deletes. The active-thread metric is a signal to operators and agents; it no longer treats idle records as active authority.

## 4. Interactions with adjacent systems

Threadline resume remains intact because archived conversations are not deleted. Relay reply handling can still find the thread by id and update it. Pinned conversations remain available for long-running relationships. Existing resolved and archived conversations are unaffected.

## 5. Rollback cost

Low. Reverting the store method, resume-map call sites, and metric filter restores prior behavior. Already-archived stale conversations remain preserved on disk and can be reactivated by inbound messages or manually inspected.

## 6. Backwards compatibility / drift surface

The store schema does not change. The only behavior change is automatic state transition to `archived` for inactive, non-pinned conversations. The 24-hour threshold is centralized as a named default so future tuning has one obvious place.

## 7. Authorization / trust posture

No external calls, credentials, or user-visible messaging paths are added. The change only mutates local Threadline conversation state through the existing `ConversationStore` mutation path.

## Outcome

Ship. The fix addresses the observed active-thread accumulation without destroying conversation history or changing network protocols.
