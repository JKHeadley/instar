# Side-Effects Review — locked-screen security item reaches an attention list without Telegram

**Version / slug:** `locked-security-item-no-telegram`
**Date:** `2026-11-02`
**Author:** `Echo`
**Tier:** 1 (small, reversible: a revert restores the previous behaviour exactly). Size: 5 src files changed + 1 new (about 150 lines), 3 new test files. Effort: no spec rounds (Tier 1), first commit attempt.

## Summary of the change

`AgentServer`'s `raiseSecurity` dependency for `DesktopLockedController` went only through `telegramAdapter.createAttentionItem`. With no Telegram adapter it logged a warning and returned `false`, so on an agent without Telegram the owner was never told that a Mac may still be unlocked (relock failed), that the relock record was unreadable, or that locked-screen access was turned off. The locked-Mac proof plan (topic 134088, P12 cases 12.8/12.11) needs this item to be raised within about 10 s on a test agent with no Telegram, and it is a real gap for any agent run without Telegram.

Changes:
1. New `src/core/LocalAttentionItems.ts`: a file-backed list (`state/local-attention-items.json`, 0600, atomic tmp+rename write), one row per id, a re-raise refreshes and reopens the row, bounded to 200 rows dropping the oldest closed rows first and never an open one. `raise()` returns `true` only when the row is on disk.
2. `AgentServer`: the `raiseSecurity` closure becomes a private method `raiseLockedSecurityItem`. With Telegram: unchanged. Without: stores the item locally (HIGH, category security, source agent) and calls `mobilePairing.push.onHubPost` (best effort); returns `false` with a degradation report when the write fails. The store is constructed only when there is no Telegram adapter, and passed to the route context.
3. `routes.ts`: `GET /attention`, `GET /attention/:id`, `PATCH /attention/:id` serve the local list when `ctx.telegram` is null and `ctx.localAttention` is set. Other attention routes (POST, lifecycle, clear, remote-ack) keep their 503 without Telegram.
4. `mobilePairingRoutes.ts`: the notification title lookup `GET /mobile/attention/:id` falls back to the local list.
5. CLAUDE.md template + `migrateClaudeMd` bullet (sniff `local-attention-items.json`).

## Decision-point inventory

- `DesktopLockedController` "told" decision (marks the relock record `reported`) — unchanged logic; its input (`raiseSecurity` result) is now honest on agents without Telegram (true only when stored).
- No new gate, filter or block.

## 1. Over-block

None. Nothing is refused that was accepted before. Routes that answered 503 now answer 200 only when a local list exists (no Telegram).

## 2. Under-block

- Without Telegram, `POST /attention` still answers 503: an agent cannot queue its own items there. This change is about the owner seeing security items; the agent itself writing to the list is a separate question with no current user.
- The phone push is best-effort; if APNs is not configured the item is still on the list and in the app.
- The local list is not merged into `GET /attention?scope=pool` from peers that have Telegram (a peer's pool read calls this machine's `/attention`, which now answers with the local list, so it IS visible to Telegram peers' pool view).

## 3. Level-of-abstraction fit

The attention store living inside `TelegramAdapter` is the root cause; moving it out is a large refactor. This adds the smallest store at the same route surface, so readers (`GET /attention`, the app) need no new address.

## 4. Signal vs authority compliance

Signal only: the store records and reports. No blocking authority added.

## 5. Interactions

- `DesktopLockedController.sweep` retries an unreported `relock-failed` each sweep until `raiseSecurity` returns true; now it gets true on a no-Telegram agent after the first successful write, so `mark-reported` runs and the guard's record closes as before with Telegram.
- `disable()` raises an item each time locked access is turned off; the row is reused (same id), so repeated disables refresh one row.
- Mobile push dedupe key includes a timestamp, so a re-raise can push again; push budgets (2-minute fold, daily cap) still bound it.
- No change when a Telegram adapter exists: `localAttention` is null and every route takes its old path.

## 6. External surfaces

`GET /attention` without Telegram changes from 503 to 200 with `surface: "local"`. Any client treating 503 as "no Telegram" now gets a list instead; the dashboard and the app already render an item list. CLAUDE.md gains one bullet.

## 7. Multi-machine posture

Machine-local by design: the security item concerns this Mac. Peers see it through their existing `GET /attention?scope=pool` fan-out, which calls this machine's `/attention`.

## 8. Rollback cost

Revert the PR. The leftover `state/local-attention-items.json` is inert. No migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure `n/a`. No new self-triggered loop. The added local write and phone push run once per raise from the existing DesktopLockedController sweep, which stops raising a condition once `raiseSecurity` returns true (`mark-reported`); a failed write retries at the existing 10 s sweep cadence only while the condition is open. Each push passes the MobilePush per-device budgets and folding.

## Conclusion

Closes a real gap where a security warning was dropped on agents without Telegram, with no change for agents that have Telegram. Tier 1.

## Second-pass review (if required)

Not required: no block/allow, session lifecycle, gate or sentinel logic changes; this only gives an existing report a place to land.

## Evidence pointers

- `tests/unit/local-attention-items.test.ts`
- `tests/integration/attention-local-without-telegram.test.ts`
- `tests/e2e/locked-security-item-without-telegram.test.ts`
- `tests/unit/PostUpdateMigrator-attentionWithoutTelegram.test.ts`
