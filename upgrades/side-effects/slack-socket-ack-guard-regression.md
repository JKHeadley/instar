# Side-Effects Review — Slack Socket Mode ack-guard behavioral regression

**Version / slug:** `slack-socket-ack-guard-regression`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required — test-only Tier 1`

## Summary of the change

This is a test-only follow-up for the Slack Socket Mode reconnect crash guard. The existing production fix in `src/messaging/slack/SocketModeClient.ts` already checks `readyState === WebSocket.OPEN` before sending event acknowledgements and catches the send-race path. This change adds behavioral coverage in `tests/unit/slack-socket-reconnect.test.ts` by instantiating `SocketModeClient`, injecting fake socket states, and driving the raw-message handler directly.

## Decision-point inventory

- Slack Socket Mode event ack behavior — **pass-through** — production behavior unchanged; tests now assert the already-shipped guard path.
- Event processing after ack handling — **pass-through** — tests assert event processing continues after skipped or caught ack sends.

---

## 1. Over-block

No runtime block/allow surface changed. The only possible over-block is a future code change being rejected by tests if it removes the ack readiness guard or stops event processing after a skipped/caught ack.

---

## 2. Under-block

The test does not open a real Slack Socket Mode connection. It covers the unit-level failure mode directly: non-open socket state and send throwing after an open-state check. Real integration timing remains covered by existing reconnect/heartbeat tests and Slack's own redelivery behavior.

---

## 3. Level-of-abstraction fit

The regression belongs at the `SocketModeClient` unit layer because the crash was caused by ack behavior in the raw message handler. A source assertion already existed, but this behavioral test is the right layer to prove the guard path actually prevents throws and preserves event handling.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic — STOP. Reshape the design.

This is test-only coverage. It does not add a detector, gate, relay policy, or runtime decision point.

---

## 5. Interactions

- **Shadowing:** none at runtime.
- **Double-fire:** none at runtime.
- **Races:** the test explicitly simulates the reconnect race where the socket is not open, plus the narrower race where send throws after an open-state check.
- **Feedback loops:** none.

---

## 6. External surfaces

No external surface changes. Slack behavior, config, API routes, Telegram behavior, dashboard behavior, and persistent state are unchanged. The release fragment is marked internal-only because this ships only regression coverage.

---

## 7. Rollback cost

Rollback is deleting the added test assertions and artifacts. No data migration, agent state repair, or user-visible rollback behavior exists.

---

## Conclusion

Clear to ship as a test-only Tier-1 follow-up. The missing behavioral coverage now pins the crash guard that was previously covered only by source assertions.

---

## Second-pass review (if required)

Not required — test-only Tier 1.

---

## Evidence pointers

- `npx vitest run tests/unit/slack-socket-reconnect.test.ts` — 17 tests passed.
