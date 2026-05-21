---
review-convergence: "rev-1 — operator-driven incident response. Three independent changes: non-destructive retrieve by default, explicit consume parameter, stuck-consumer event. Designed and discussed in topic 10873 immediately after the lost-SMS-code failure; design published as a private view + acknowledged by operator before implementation."
approved: true
approved-by: "operator (Justin) via Telegram topic 10873 — 2026-05-20T21:11Z (\"Approved, proceed as you best see fit\")"
approved-at: "2026-05-20T21:11:00Z"
---

# Secret Drop Hardening — Spec

**Status:** Approved 2026-05-20. Implementing now.
**Author:** Echo
**Companion:** SECRET-DROP-HARDENING-SPEC.eli16.md
**Trigger:** 2026-05-20 incident in topic 10873 — the in-memory Secret Drop submission was consumed by a buggy bridge consumer that failed to extract the value, losing the SMS code and forcing a second auth round.

---

## Failure being addressed

The `/secrets/retrieve/<token>` endpoint previously performed an **atomic retrieve-and-delete**: the submission was returned in the response and the same call removed it from the in-memory `received` map. Any consumer that dropped the response value (parse bug, network error after read, unhandled exception in the callback that writes the value to its destination) lost the secret with no recovery path.

The cost on 2026-05-20: one SMS code was burned. The cost in a worse failure mode: a more sensitive secret could be lost AND a downstream system could be left in an inconsistent state (e.g. auth half-completed, retry impossible without a fresh operator action).

A separate 5-minute server-side cleanup timer already existed. **The aggressive deletion-on-retrieve provided no additional safety beyond that timer** — the cleanup caught what the explicit delete caught, just on a longer horizon.

---

## Three changes (all ship in this PR)

### 1. `getReceived` becomes non-destructive by default

Two new methods on `SecretDrop`:

- `peekReceived(token)` — returns the submission without removing it. Safe to call repeatedly. Used by polling consumers that want retry semantics.
- `consumeReceived(token)` — returns the submission AND removes it before returning. Used when the caller is confident the value has been successfully handed off and a re-read would be wrong.

`getReceived(token)` is preserved as a back-compat alias for `consumeReceived(token)` so existing callers do not break.

The existing 5-minute auto-cleanup timer remains the only path through which submissions vanish without operator action.

### 2. The route honors a `consume` query parameter

```ts
router.post('/secrets/retrieve/:token', (req, res) => {
  const consume = req.query.consume === 'true' || req.query.consume === '1';
  const submission = consume
    ? secretDrop.consumeReceived(req.params.token)
    : secretDrop.peekReceived(req.params.token);
  if (!submission) {
    res.status(404).json({ error: 'No submission found for this token' });
    return;
  }
  res.json({ ...submission, consumed: consume });
});
```

**Default is non-destructive.** Callers must opt into consumption with `?consume=true`. The response includes a `consumed: boolean` so callers can self-check.

This is a backward-compatible change at the call-site level — existing callers that don't pass `?consume=true` retain the value across multiple retrieves (the safer behavior). Callers that depend on one-shot semantics opt in.

### 3. Stuck-consumer event

`SecretDrop.onStuckConsumer(listener)` registers a listener. If a submission lingers in `received` for >60 seconds without being explicitly consumed, every registered listener is invoked with a `StuckConsumerEvent`:

```ts
interface StuckConsumerEvent {
  token: string;
  label: string;
  topicId?: number;
  receivedAt: string;
  minutesUntilCleanup: number;
}
```

The `routes.ts` wiring registers a default listener that, when the bound topic and session manager are available, routes a `[secret-drop-stuck]` system message to the bound topic's agent session — giving the operator a visible cue that the consumer chain broke instead of silently waiting for a value that's already lost.

The grace period is fixed at 60 seconds (the operator decided "60s is the right default" during the design review).

---

## Test plan

`tests/unit/secret-drop-hardening.test.ts` — 13 cases:

1. `peekReceived` returns the submission without removing it.
2. `peekReceived` returns null for unknown tokens.
3. `consumeReceived` returns and removes.
4. Peek-then-consume: peek leaves, consume removes.
5. Legacy `getReceived` behaves like `consumeReceived` (back-compat).
6. **Regression — 2026-05-20 lost-SMS-code scenario:** a buggy consumer can retry after dropping the value on first call.
7. Stuck-consumer event fires after 60s grace when nobody consumes.
8. Stuck-consumer event does NOT fire when the submission was consumed before the grace ended.
9. Stuck-consumer fires once at 60s even when cleanup runs later.
10. Multiple listeners: one bad listener does not block others.
11. Submission disappears after 5 minutes even if never consumed.
12. Cleanup timer does not double-fire if consume happened first.
13. `submit()` still consumes the pending request (existing behavior unchanged).

The existing `tests/unit/SecretDrop.test.ts` suite remains untouched and all 25 cases continue to pass.

---

## Rollback

Single-PR revert. The route falls back to the pre-change atomic retrieve-and-delete (via the back-compat `getReceived` path that is now an alias for `consumeReceived`). Callers that adopted `?consume=true` continue to work (the parameter becomes a no-op on the pre-change code, since deletion happens unconditionally there). The stuck-consumer event simply stops firing.

---

## What this does NOT do

- It does not encrypt submissions at rest. They remain in-memory only (per the existing design).
- It does not change the CSRF or rate-limit posture.
- It does not address consumer-side bugs directly — but it makes them recoverable rather than terminal.
- It does not modify the form-rendering surface or the `/secrets/request` route. Operator workflow on the form side is unchanged.

---

## Operator decisions captured in the design review

1. **Grace period: 60 seconds.** (Operator approved the default.)
2. **Stuck-consumer event: always-on.** (Operator approved; no per-request opt-in needed for the v1 ship.)
