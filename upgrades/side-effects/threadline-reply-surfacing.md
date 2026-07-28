# Side-Effects Review — Threadline topic-bound reply surfacing fix

**Version / slug:** `threadline-reply-surfacing`
**Date:** 2026-05-25
**Author:** Echo
**Second-pass reviewer:** (pending — required; this touches messaging surfacing decisions, session inject lifecycle, and "gate"/"guard" surfaces)

## Summary of the change

Makes a co-located/relayed agent's reply on a topic-bound Threadline thread reliably surface to the bound Telegram topic, instead of vanishing into the store. Files: `src/threadline/ThreadResumeMap.ts` (get() guard), `src/commands/server.ts` (warm-listener relay guard + injectIntoSession now confirms consumption), `src/core/SessionManager.ts` (new `injectPasteNotificationConfirmed`), `src/threadline/TopicLinkageHandler.ts` (surface only when the live hand-off didn't confirm + first-reply carve-out), `src/messaging/MessageRouter.ts` (thread-aggregate maintenance for both legs + `recordLocalOutbound`), `src/server/routes.ts` (stamp `transport.originTopicId`, persist outbound leg). Decision points touched: the inbound spawn-vs-route branch, the warm-listener routing branch, the Telegram-surface gate inside `tryRouteReplyToTopic`, and the commitment-resolution gate.

## Decision-point inventory

- `ThreadResumeMap.get()` JSONL-existence guard — **modify** — exempts topic-linkage entries (originTopicId set) from the guard so they aren't falsely nulled.
- `server.ts` relay `gate-passed` warm-listener branch — **modify** — adds a `!isTopicBoundReply` condition so topic-bound replies reach the router.
- `TopicLinkageHandler.tryRouteReplyToTopic` live-inject vs surface — **modify** — `deliveryMode='live-inject'` now requires confirmed consumption; `shouldSurface` excludes confirmed live-inject; first-reply bypasses rate limit.
- commitment-resolution (`surfacedToUser`) — **pass-through** (logic unchanged, but now correct because `live-inject` means confirmed).
- thread-aggregate write (`MessageRouter.relay` / new `recordLocalOutbound`) — **add** — maintains `threads/{id}.json` for both legs.

---

## 1. Over-block

**What legitimate inputs does this reject that it shouldn't?**

The surfacing gate now fires a Telegram note whenever a topic-bound reply's live-inject is NOT confirmed (failure-visible/resume-pending). It could *over-surface* (post a note the user didn't strictly need) for a low-salience reply that happened to land while the session was busy — but salience still suppresses pure-acks for the non-failure path, and the per-thread (60s) / per-topic (3/60s) rate limits cap volume. It does NOT reject/drop any legitimate input. The `ThreadResumeMap.get()` change only *widens* what `get()` returns (fewer false nulls) — it cannot newly reject anything.

## 2. Under-block

**What failure modes does this still miss?**

- If `sendTelegramToTopic` is null (no Telegram configured) AND the live-inject stalls, the reply is not surfaced and the commitment stays open (by design — never falsely resolved; PromiseBeacon + 7-day TTL are the backstop). Documented; covered by a unit test.
- A reply whose live-inject is *confirmed* but whose agent then fails to relay conversationally (agent-level failure, not inject-level) would not get a deterministic note. This is out of the inject layer's visibility; the commitment-resolution-on-confirmed-inject preserves existing behavior here.
- Cross-machine replies that take neither the warm-listener nor pipe branch and have no resume entry still cold-spawn — unchanged, and correct (no topic binding to honor).

## 3. Level-of-abstraction fit

`ThreadResumeMap.get()` is a low-level data-access guard; exempting topic-linkage entries is correct at that layer because the entry itself carries the topic-vs-JSONL distinction (`originTopicId`). The surfacing decision stays in `TopicLinkageHandler` (the existing authority for topic-linkage replies) — no new parallel authority is introduced. The inject-confirmation is a capability added to `SessionManager` (the owner of tmux injection), consumed by the handler via the existing `injectIntoSession` dep — the handler does not re-implement tmux probing. Correct layering throughout.

## 4. Signal vs authority compliance

The change adds NO brittle check with blocking authority. The inject-confirmation is a *signal* (did the paste submit?) consumed by the existing `TopicLinkageHandler` authority. The warm-listener guard is a routing predicate (signal) that defers the decision to the existing `handleInboundMessage`/`tryRouteReplyToTopic` authority. The `get()` change removes a false-negative from a data guard. Per `docs/signal-vs-authority.md`: detectors feed authorities; no detector gained blocking power.

## 5. Interactions

- **CollaborationSurfacer overlap:** topic-bound replies route via TopicLinkageHandler; parentless via CollaborationSurfacer. Mutual exclusivity preserved (the topic-bound predicate gates which path runs). Covered by an integration test.
- **Double-surface:** eliminated — the deterministic surface is suppressed when live-inject is confirmed (the agent relays instead).
- **verifyInjection double-recovery:** `injectPasteNotificationConfirmed` *observes* the recovery window; it does not fire its own Enter-resends, so it does not race with `injectMessage`'s internal `verifyInjection`.
- **Other `get()` callers** (pipe-spawn guard, tryInjectIntoLiveSession, onSessionEnd/Resolved/Failed, MCP history): enumerated in the spec §3; the pipe-spawn guard now correctly excludes topic-bound (desired); others operate benignly on the returned entry.
- **Thread-aggregate writes** added to `relay()`: non-fatal try/catch; idempotent (store.save dedups). No double-fire — `updateThread` is idempotent on message id.

## 6. External surfaces

- New optional `transport.originTopicId` on the local-delivery envelope — additive; older peers ignore it; it is an opaque per-chat integer (Telegram `message_thread_id`), inert without bot token+chat id. The peer maps it via its own table and must never echo it back as a routing target (the existing F1 anti-poisoning guard on the send path still holds).
- More Telegram notifications may appear in topics where replies previously vanished — this is the intended user-visible behavior (rate-limited).
- Inject confirmation adds up to ~7.5s latency to the live-inject path of a *stalled* inbound reply handler (returns ~1s on a healthy submit). Not user-blocking (background reply surfacing).

## 7. Rollback cost

Localized to six files; revert is a clean `git revert` of the implementation commit. No data migration (thread-aggregate writes are additive + idempotent; existing reads tolerate missing aggregates). No agent-state repair. `transport.originTopicId` is optional, so a rollback leaves no dangling dependency. Pure `src/` change → existing agents pick up the revert via the normal update path; no PostUpdateMigrator entry involved.

---

## Second-pass review

**Concur with the review** (independent reviewer, 2026-05-25). Audited the full diff against the artifact: diff matches §1–7; the `injectPasteNotification` void→string change breaks no caller (4 callers discard the return); `injectPasteNotificationConfirmed` only reads (no `fireStuckInputRecovery`) so it observes rather than races `verifyInjection`; `relay()`'s `exists()` early-return precedes `updateThread` so no inbound double-count; the awaited inject (≤7.5s) runs only on the background reply-surface path when a session is alive AND the inject stalls (healthy submit returns ~1s), gates no transport, holds no lock; the `originTopicId === undefined` guard exemption is safe (it derives solely from `boundTopicId`, so non-topic resume entries still null correctly).

Reviewer's one non-blocking note — `updateThread` is not internally idempotent, so the artifact's "recordLocalOutbound idempotent (store.save dedups)" overstated where idempotency comes from — has been **addressed in code**: `recordLocalOutbound` now gates `updateThread` on a first-sight `store.exists()` check, making it truly idempotent regardless of caller behavior.
