# Side-Effects Review — Cross-Machine Seamlessness: Telegram adapter contract impl

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §Channel Seamlessness Contract (converged, approved)

## What changed
- `src/messaging/TelegramAdapter.ts` — implements the Channel Seamlessness
  Contract (the reference adapter):
  - `dedupeKey(rawEvent)` → `telegram:<update_id>` (with a fallback to a
    normalized Message's metadata.update_id).
  - `getIngressPosition()` → `{ platform:'telegram', cursor:lastUpdateId, ... }`.
  - `stopConsuming()` → halts the poll loop, persists the offset, returns the
    DURABLE position (the saved offset, not the in-memory cursor).
  - `resumeConsuming(position)` → restores the offset (never lowers it below
    what we already know, so no replay) and restarts polling; rejects a
    wrong-platform position.

## Over-block / under-block
- All four methods are additive (the interface declares them optional). No
  existing TelegramAdapter behavior changes — start/stop/send/onMessage are
  untouched. `resumeConsuming` uses `Math.max(lastUpdateId, cursor)` so it can
  only advance the offset, never rewind into a replay.

## Signal vs authority / interactions
- These are pure adapter capabilities (where-am-I / stop / resume / identify);
  they carry no authority. The seamless handoff path (a follow-on) calls them;
  on their own they have no runtime effect until invoked.
- `stopConsuming` reuses the existing `saveOffset()` (atomic-rename), so the
  durable position is consistent with the normal poll-offset persistence.

## Rollback cost
- Minimal — removing the four methods reverts to the prior adapter exactly.

## Tests
- `tests/unit/telegram-seamless-contract.test.ts` (6): all four methods present,
  dedupeKey stability/distinctness + metadata fallback, ingress-position shape,
  stop→durable-position→resume round-trip (no replay), wrong-platform rejection.
