---
slug: token-burn-detection-phase-5
parent-spec: docs/specs/token-burn-detection-and-self-heal.md
review-convergence: "derived-from-umbrella"
review-iterations: 1
review-completed-at: "2026-05-15T20:25:00Z"
review-report: docs/specs/reports/token-burn-detection-and-self-heal-convergence.md
approved: true
approved-by: justin
approved-at: "2026-05-15T20:35:00Z"
approved-via: "Telegram topic 8615 — umbrella approval covers this phase"
eli16-overview: docs/specs/token-burn-detection-phase-5.eli16.md
---

# Token-Burn Detection — Phase 5 Spec

**Parent**: `docs/specs/token-burn-detection-and-self-heal.md` (approved by Justin 2026-05-15).

Phase 5 of six. Adds the principal-bound, HMAC-signed Telegram inline-button surface AND the subscriber wiring that connects the Phase 4 runbook into the live DegradationReporter chain.

## Scope (Phase 5)

1. **`BurnAlertButtons`** — pure module producing four inline buttons per alert (Release, Snooze 24h, Extend +1h, Investigate), each with HMAC-signed callback_data. The `handle()` method verifies:
   - Principal: `from.id` ∈ `authorizedUserIds` (same list `MessagingToneGate` consults).
   - HMAC signature: callback_data canonical form signed with the agent's capability key.
   - Freshness: each `(action, signalId)` pair can fire at most once (per the convergence audit's "replay reject" requirement).

2. **Snooze state** — when the user taps Snooze 24h, the attribution key is recorded in an in-memory map with a 24h TTL. The runbook now consults `isSnoozed(key)` before throttling — snoozed keys still produce alerts (so the user knows the burn is recurring) but never auto-throttle.

3. **Extend** — re-installs a throttle for another hour using a fresh signalId (so the gate's replay-prevention does not refuse the legitimate extension).

4. **`BurnDetectionSubscriber`** — small adapter that registers the runbook as a `DegradationReporter` healer for `feature: 'token-burn-detection'`. Returns true to the reporter when a throttle was installed, false for alert-only outcomes. An optional `onOutcome` sink is passed for the Phase 6 verification step to subscribe to.

5. **Runbook snooze honoring** — `BurnThrottleRunbook` accepts an optional `isSnoozed` dep; when provided, snoozed keys produce a new `alert-only-snoozed` outcome.

6. **15 unit tests** covering principal-bind accept/reject, HMAC tamper reject, replay reject, all four button actions, snooze TTL auto-expiry, runbook snooze-honoring, and subscriber wiring.

## Out of scope (deferred to Phase 6 and follow-up)

- **TelegramAdapter wire** — the actual emit of `reply_markup.inline_keyboard` with `BurnAlertButtons.buildKeyboard()`, and the receipt of the `callback_query` from the Telegram webhook into `BurnAlertButtons.handle()`, is a small change in `TelegramAdapter.ts` deferred to Phase 6 / follow-up. The pure module + the principal-bind + HMAC + freshness logic IS in this phase, fully tested.
- **AgentServer construction-order wiring** — invocating `registerBurnDetectionSubscriber(reporter, runbook)` at server startup is a 5-line `AgentServer.ts` change that lands in Phase 6 alongside the verification-step wiring (both need the same construction-order touch).
- **Verification + post-throttle re-sample** — Phase 6.

## Files touched

```
src/monitoring/BurnAlertButtons.ts                      (NEW — principal-bound, HMAC-signed callbacks)
src/monitoring/BurnDetectionSubscriber.ts               (NEW — wiring adapter)
src/monitoring/BurnThrottleRunbook.ts                   (+isSnoozed dep, +alert-only-snoozed outcome)
tests/unit/burn-detection-phase-5.test.ts               (NEW — 15 tests)
docs/specs/token-burn-detection-phase-5.md              (this file)
docs/specs/token-burn-detection-phase-5.eli16.md        (NEW)
upgrades/side-effects/token-burn-detection-phase-5.md   (NEW)
upgrades/NEXT.md                                        (release notes)
```

## Acceptance criteria

1. Release/Snooze/Extend/Investigate buttons all generate verifiable callback_data.
2. Unauthorized principal callback is rejected with reason `principal-not-authorized`.
3. Tampered callback_data is rejected with reason `invalid-signature`.
4. Replayed `(action, signalId)` pair is rejected with reason `signal-id-replayed`.
5. Snooze 24h records the snooze + revokes any active throttle.
6. Snooze auto-expires after 24h.
7. Runbook's `alert-only-snoozed` outcome fires when key is snoozed.
8. `registerBurnDetectionSubscriber` wires runbook as DegradationReporter healer.

## Signal-vs-authority compliance

The buttons are principal-bound: an unauthorized user (any Telegram user_id not in the authorized list) cannot install or revoke a throttle. The HMAC signature defends against forgery. The freshness check defends against replay. All three layers (principal + signature + freshness) must pass for a callback to take effect.

The runbook remains the sole decision authority. The buttons are a user-facing interface to express user intent (release / snooze / extend); the runbook's decisions are still made by the runbook's `handle()` method when burn signals arrive.

## Second-pass review

Required for this phase per `/instar-dev` Phase 5 criteria — touches inbound messaging (Telegram callbacks are inbound). Conducted in the same pattern as Phase 4.

## Rollback

Additive. Backout = delete `BurnAlertButtons.ts`, `BurnDetectionSubscriber.ts`, the test file, and revert the small runbook-deps additions. No persistent state; the snooze and consumed-id maps are in-memory and self-clear on restart.
