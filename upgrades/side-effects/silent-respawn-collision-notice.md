# Side-Effects Review — Silent respawn collision notice

**Version / slug:** `silent-respawn-collision-notice`
**Date:** `2026-07-11`
**Author:** `instar-codey`
**Second-pass reviewer:** framework_guard_review (Banach)

## Summary of the change

The two dead-session respawn collision guards in `wireTelegramRouting` no longer return silently. They send a deterministic, honest custody notice through the existing Telegram topic-send funnel before returning. No queue, persistence format, config, or authority surface is added.

## Decision-point inventory

- Context-exhaustion dead-session respawn collision — modified — sends the loss notice, then preserves the existing return.
- Ordinary dead-session respawn collision — modified — sends the loss notice, then preserves the existing return.
- Initial respawn and durable pending-inject paths — pass-through — unchanged.
- Sentinel kill/pause intercept and exactly-once ingress gate — pass-through — unchanged and remain in their existing order.

---

## 1. Over-block

No new block/allow surface exists. The colliding message was already rejected by the active-spawn guard; the change only makes that pre-existing lack of custody visible. The notice does not suppress, deduplicate, pause, or kill any message or session.

## 2. Under-block

The notice is dispatched asynchronously through the existing adapter. If Telegram delivery itself fails, the existing adapter failure behavior and error logging apply; this change does not claim external delivery succeeded. It also intentionally does not retry or queue the colliding user message, avoiding duplicate injection into a session whose startup ownership is already in flight.

## 3. Level-of-abstraction fit

The collision guard is the only layer that knows the message was refused specifically because another respawn owns the topic. The wording and injectable send helper live beside the existing cold-start fallback reply machinery, keeping user-facing spawn failure notices in one messaging module.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The notice is a truthful signal about custody already declined by existing control flow. It creates no authority and makes no semantic inference about the user's message.

## 5. Interactions

- **Shadowing:** Both reachable dead-session collision guards receive identical behavior; neither shadows the other.
- **Double-fire:** Each inbound traverses only one of the mutually exclusive dead-session branches, so at most one notice is attempted.
- **Races:** The existing `spawningTopics` ownership remains unchanged. The notice does not mutate it or wait on the spawn.
- **Feedback loops:** The notice asks for an explicit resend after restart; it does not self-trigger another spawn or injection.

## 6. External surfaces

Telegram users may see one new message: “I got this message while the session was already restarting, so it was not queued or delivered. Please resend it once the restart finishes.” No dashboard, API, config, schema, URL, or other external surface changes.

## 6b. Operator-surface quality

The wording distinguishes receipt by the bridge from custody by the session, states exactly what failed, and gives one concrete recovery action. It does not falsely promise that the message is queued.

## 7. Multi-machine posture

Machine-local by design and fully functional with `multiMachine.sessionPool.inboundQueue` dark. It uses the local respawn ownership set and the existing Telegram adapter. No cross-machine state or dark feature is required.

## 8. Rollback cost

Pure code rollback: revert the helper, two call sites, tests, and release artifacts. No durable state or data migration requires repair.

## Conclusion

Clear to ship. The change closes the reachable silent-loss collision without changing queue semantics or safety authority.

## Second-pass review (required: messaging/information-flow path)

**Reviewer:** framework_guard_review (Banach)
**Independent read:** Concurred after requesting an executable routing regression. The final test holds the first respawn unresolved, drives a second inbound through `wireTelegramRouting`, and proves exactly one loss notice, one spawn total, and zero injection. The reviewer confirmed both production guards preserve the existing return and that `src/server/routes.ts` safety ordering is untouched.

## Evidence pointers

- `tests/unit/respawn-collision-notice.test.ts`
- `tests/unit/cold-start-fallback-reply.test.ts`
- `tests/unit/cold-start-fallback-wiring.test.ts`
- `tests/integration/telegram-forward-sentinel-intercept.test.ts`
- `tests/integration/exactly-once-ingress.test.ts`
- `tests/unit/no-silent-fallbacks.test.ts`

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a`
- **Reason:** One-shot user-driven custody notice emitted only when an inbound message collides with an already-running respawn; not a self-triggered loop.
