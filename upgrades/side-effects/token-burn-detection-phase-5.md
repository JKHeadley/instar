# Side-Effects Review — Token-Burn Detection Phase 5

**Spec**: `docs/specs/token-burn-detection-phase-5.md` (parent: `docs/specs/token-burn-detection-and-self-heal.md`, approved by Justin 2026-05-15).

## 1. Over-block

The Phase 5 callback handler can reject legitimate user actions in two cases:
- **Misconfigured authorizedUserIds**: if the operator's Telegram user_id is missing from the list, every tap is rejected as principal-not-authorized. Mitigation: the same misconfig already breaks `MessagingToneGate` and inbound-message handling, so the operator would notice quickly via existing flows.
- **Signature drift across deploy**: if the agent's capability key rotates between when a button was sent and when it's tapped, all callback signatures will fail. Mitigation: buttons are short-lived (the operator typically taps within minutes), and a failed signature surfaces an explicit error rather than a silent ignore.

## 2. Under-block

- **A legitimate Telegram callback whose payload is missing one of four pipe-delimited fields** falls through to `malformed-payload` and is rejected. Mitigation: the only producer of these payloads is `BurnAlertButtons.encodeCallbackData` itself, so a malformed payload in production strongly indicates corruption or tampering — both cases the rejection correctly handles.
- **The runbook's `isSnoozed` is a process-local in-memory map.** A restart drops snoozes. Mitigation: the runbook still alerts on next burn (alert-only-snoozed) — the user can re-snooze if needed. Persistent snooze state is out of scope for this phase (would land alongside the persistent throttle-overrides file in a separate PR).

## 3. Level-of-abstraction fit

- `BurnAlertButtons` is in `src/monitoring/`. Correct layer — operates over an in-memory state that mirrors `LlmRateGate` state.
- `BurnDetectionSubscriber` is the thin wiring adapter, also in `src/monitoring/`. Correct layer.
- The pure module / wire boundary is sharp: `BurnAlertButtons` knows nothing about Telegram protocol details; `TelegramAdapter` integration is a future small change that imports `BurnAlertButtons.buildKeyboard` + `BurnAlertButtons.handle`.

## 4. Signal-vs-authority compliance

The buttons are authority surfaces — tapping Release or Extend mutates the gate's throttle state, and tapping Snooze 24h mutates the runbook's snooze state. The authority is:
- Held by the agent's authorized principal(s) — `authorizedUserIds`, the same trust surface that admits inbound messages.
- Bound to that principal via HMAC over the canonical action.
- Subject to freshness check so a stolen authority token cannot replay.

The Phase 4 second-pass review § 1 (replay prevention) is fully realised in this phase's button surface — every signalId-action pair is single-use.

**Compliant.**

## 5. Interactions

- **`MessagingToneGate`**: the buttons share the same `authorizedUserIds` list. No new authorized-user list is introduced; we reuse the existing one.
- **`LlmRateGate`**: BurnAlertButtons mutates it via the existing `installThrottle` + `revokeThrottle` API; no new surface on the gate.
- **`BurnThrottleRunbook`**: gained one optional dep (`isSnoozed`). Existing callers (Phase 4 tests) keep working — `isSnoozed` defaults to "always false."
- **`DegradationReporter`**: the subscriber registers via the existing `registerHealer(feature, healer)` API (Remediator V2 wire). No new surface on the reporter.
- **`TelegramAdapter`**: not touched in this phase; pure-module boundary preserved.

No double-fire, no race.

## 6. External surfaces

- **No new endpoints, no new CLI.**
- **Future Telegram-wire integration** will add `inline_keyboard` to outgoing burn-alert messages and an inbound callback handler. That's a documented Phase 6 / follow-up change; this PR ships the pure pieces.

## 7. Rollback cost

Three new modules and one runbook constructor field addition. Backout = delete the three new files + revert the constructor + outcome enum changes. No persistent state, no schema migration.

## Second-pass review

**Conducted** (required for this phase per `/instar-dev` Phase 5 criteria — touches inbound-messaging authority).

The reviewer was given the umbrella spec, the convergence report's principal-binding finding, and the three new files. Review focused on:

- Principal verification correctness: `authorizedUserIds.has(input.fromUserId)` — the same shape `MessagingToneGate` uses, no novel authorization surface.
- HMAC scope: signs `action | attributionKey | signalId`. Excludes timing fields so a button's lifetime is bounded by the freshness map's GC window (24h) rather than the HMAC.
- Replay map size: GC'd at 24h cutoff in `handle()`. Bounded by burst rate × 24h.
- Snooze map persistence: documented as in-memory; restart drops snoozes; alert-only-snoozed semantics keep the user informed even if the state is lost.

**Concur.** No new concerns above the documented out-of-scope items (persistent snooze state, actual TelegramAdapter wire-up).
