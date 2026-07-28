# Side-Effects Review — Slack thread→session mapping

**Version / slug:** `slack-thread-session`
**Date:** 2026-06-09
**Author:** Instar Agent (echo)
**Second-pass reviewer:** not required — deterministic session ROUTING (no LLM, no block/allow gate); covered by my own review + 84 tests. (Touches session-spawn lifecycle, so the routing-correctness + regression risks are reviewed in §5.)

## Summary of the change

Phase 2, piece 3. Makes a Slack **thread a continuous conversation = its own agent session** (mirroring the Telegram topic→session model, which keys on topic). Implemented as a **routing-key abstraction**: `resolveRoutingKey(channelId, threadTs, ownTs)` returns `channelId` by default and `channelId:thread_ts` only when the channel is opted in AND the message is a reply *inside* a thread. The channel registry + 24h resume map are keyed on this routing key; raw `channelId` + `thread_ts` are retained for all Slack API calls + replies. **Opt-in, default OFF** (`SlackConfig.threadSessions`) — with no config, every routing key equals the channel id, so behavior is byte-for-byte today's (one channel = one session). 13 files; mirrors the existing channel→session machinery rather than a parallel path.

## Decision-point inventory

- Session-routing key (`server.ts` onMessage + recovery) — **modify (additive)** — registry lookup / resume / register now key on `resolveRoutingKey(...)`; default `=== channelId` (no change).
- `SessionManager.spawnInteractiveSession` — **add** — optional `slackThreadTs` → `INSTAR_SLACK_THREAD_TS` env (propagated through resume-failed fallback).
- `slack-reply.sh` — **modify (back-compat)** — optional 2nd positional `thread_ts` (regex-gated so a normal message word is never mistaken for a thread id) + a feature marker for migration-parity refresh.

---

## 1. Over-block / 2. Under-block

N/A — this is session routing, not a block/allow gate. No message is blocked or allowed by it; it only decides WHICH session a message lands in.

## 3. Level-of-abstraction fit

Correct. It reuses the existing channel→session registry + resume-map machinery, swapping the key from `channelId` to a `resolveRoutingKey` that defaults to `channelId`. No parallel routing path; mirrors Telegram topic→session.

## 4. Signal vs authority compliance

N/A in the gate sense — no new authority, no brittle decision. The routing key is a pure deterministic function of `(channelId, threadTs, ownTs, config)`. No LLM, no fail-open surface.

## 5. Interactions (the real risks for a routing change)

- **Cross-talk / key collision (the #1 risk):** prevented. Two distinct threads → distinct `thread_ts` → distinct keys (`C:ts1` ≠ `C:ts2`) → distinct sessions; the same thread → the same key → resume. `parseRoutingKey` splits on the FIRST `:` and Slack channel ids never contain `:` (always `C…`/`D…`/`G…`), so the round-trip is unambiguous. A thread ROOT (`thread_ts === ts`, no replies yet) routes to the channel session — avoids a degenerate per-root session. Covered by the `two-threads-distinct` / `same-thread-same-key` / `thread-root` tests.
- **No regression (default OFF):** with no `threadSessions` config, `isThreadRoutingEnabled` is false → routing key always `=== channelId` → existing single-session installs are byte-for-byte unchanged. No migration needed for the routing itself.
- **API/reply correctness:** the raw `channelId` + `thread_ts` are always recovered (via `parseRoutingKey`) for Slack API calls + replies + history + system-channel checks, so a routing key is never mistaken for a channel id when talking to Slack. `sendToChannel`/`isSystemChannel` are routing-key-tolerant for standby/PresenceProxy paths.
- **Recovery path:** the context-exhaustion recovery resolves the key back to the raw channel for history/reply while registering/resuming on the key — consistent with the live path.
- **Stall tracking** stays channel-keyed (coarser, not broken) for thread sessions — a deliberate scope boundary, not a regression.

## 6. External surfaces

- **Other agents / install base:** none — dark/opt-in (default off → today's behavior).
- **External systems (Slack):** no NEW Slack Web API calls; the same send/history calls, now resolving the raw channel from the routing key.
- **Migration parity:** the `slack-reply.sh` template change (optional `thread_ts` arg) ships with a `PostUpdateMigrator` feature-marker refresh so existing agents' deployed reply scripts pick it up on update (and the arg is regex-gated → fully backward compatible for callers that don't pass a thread id).

## 7. Rollback cost

Low / additive. Revert + patch; default (channel-keyed) behavior is unchanged on every install. No data migration (the resume map keys are forward-compatible: old channel-keyed entries still resolve since routingKey===channelId when thread routing is off). The slack-reply.sh marker refresh is idempotent.
