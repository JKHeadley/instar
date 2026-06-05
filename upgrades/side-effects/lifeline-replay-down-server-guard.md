# Side-Effects Review — Lifeline replay drop budget: down-server exemption

**Version / slug:** `lifeline-replay-down-server-guard`
**Date:** `2026-06-05`
**Author:** `instar-echo`

## Summary

In `TelegramLifeline.replayQueue()`, the failure branch's strike increment becomes healthy-gated: `msg.replayFailures = this.supervisor.healthy ? failures + 1 : failures`. A forward that fails while the supervisor reports the server DOWN re-queues the message with its strike count untouched. The drop decision itself (3 strikes → record + degradation report + sender notice) is unchanged.

## Decision-point inventory

- Replay strike increment — modified — gated on `this.supervisor.healthy` (the same flag the loop's own stop-replaying branch already consults three lines below; no new state).
- Drop decision, versionSkewActive exemption, dropped-message notification, queue ordering — untouched.

## Direction of failure

- Old failure: systemic down-server failures burned the poison-message budget; head-of-queue messages dropped in ~90s of a multi-minute restart window (39 live records on codey).
- New behavior: down-window failures are free; messages wait out the outage. Strikes only accrue against a healthy server.
- Conservative failure direction: messages are KEPT longer. A genuinely poisonous message still accumulates strikes the moment the server is healthy (its delivery failure against a healthy server is precisely the poison signal) and is dropped with the existing loud path.

## Side-effects checklist

1. **Over-keep (message retained that should drop):** a poison message during an outage survives the outage — correct: it then fails 3x against the HEALTHY server and drops via the existing path. Worst case it delays its own drop by the outage length.
2. **Under-keep:** none introduced — no path drops earlier than before.
3. **Stale-healthy edge:** the supervisor may not yet have noticed a fresh crash, so the first failure after a crash can still increment. Acceptable: the budget is 3 and the guard's job is stopping the systematic burn across a known-down window; the loop's own `!supervisor.healthy` break uses the same flag with the same staleness, keeping the two behaviors consistent.
4. **Queue growth:** an extended outage retains messages it previously shredded. Bounded by the queue's existing capacity controls; the alternative (dropping user messages) is the bug.
5. **Level-of-abstraction fit:** policy stays inside `replayQueue()` next to the drop decision and the sibling versionSkewActive exemption — one drop policy, one place. No new flags, fields, or config.
6. **Signal vs authority:** no LLM; the drop path's loud notification chain is preserved verbatim.
7. **Rollback cost:** revert the one-line gate (plus comment + tests). No state migration; dropped-messages.json shape unchanged.

## Scope not taken

- No change to MAX_REPLAY_FAILURES (3 remains right for the poison case).
- No fix for the separate `telegram-forward sentinel pause` limbo (held-not-dropped message on an idle session; ledger issue 38edd8f0, distinct mechanism on the SERVER side — this fix is the LIFELINE side).
- No retroactive redelivery of already-dropped messages (the ledger + sender notices already cover them).
- SlackLifeline has its own replay path — audit as a follow-up, not blind-patched here.

## Rollback

Revert the commit. Behavior returns to unconditional strike increments.
