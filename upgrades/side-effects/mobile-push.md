# Side-Effects Review — Mobile push

**Version / slug:** `mobile-push`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Paired iPhones get a push notification when the Attention hub posts (spec: `docs/specs/mobile-push.md`). New `src/core/MobilePush.ts` holds the per-device durable schedule (2-minute fold, hourly after 40 in 24 h, URGENT bypass, 429 backoff), the ES256 APNs JWT, and a lazy HTTP/2 transport. `MobileDeviceKeys.ts` gains push fields, `setPush` (revisioned, one token per record per machine) and `clearPushIfVersion`; revoke clears the token. `mobilePairingRoutes.ts` adds `POST /mobile/device/push`, `GET /mobile/attention/:id` (device signature or the notification read token, a new exact-route branch in the device authenticator), `POST /mobile/push/notify` (Bearer, 202) and `GET /mobile/push`, plus `fanOutPushTrigger`. `TelegramAdapter.routeToAttentionHub` fires `onHubPost` only inside `markPosted` (after Telegram accepted the post); `server.ts notify()` fires it for an admitted hub notice. `AgentServer` builds the service with the vault key. Dev-gated (`mobilePairing.push.enabled` follows `mobilePairing`). Tier 2.

## Decision-point inventory

- Which events notify — add, invariant (the existing hub filter's admitted, accepted posts).
- Peer fan-out and duplicate suppression — add, invariant.
- Sent, folded or throttled — add, invariant (durable per-device schedule).
- Token accepted or cleared — add, invariant (signature, revision, fixed APNs reason list).
- Device authenticator — modify: one exact-route branch for the notification read token.

## 1. Over-block

A real notification is held back when: the phone had one in the last 2 minutes (folded, not lost); the phone is throttled after 40 in a day (hourly, URGENT sooner); APNs answered 429 (10-minute backoff); the key is missing or refused (status says so). A machine offline at post time misses that notification.

## 2. Under-block

A phone whose old registration sits on an unreachable machine can get a duplicate for one condition until that machine accepts the clear (stated in the spec). A Bearer holder can post triggers to `/mobile/push/notify`; they cannot carry text and are bounded by the 120/hour route cap and the per-device schedule.

## 3. Level-of-abstraction fit

The trigger sits at the single point where the hub filter's decision became a real post, so push can never disagree with what Telegram showed. The schedule is per device and durable, beside the device registry that owns the token.

## 4. Signal vs authority compliance

No detector gains authority; push is an output channel for decisions the hub filter already made.

## 4b. Judgment-point check

No competing-signals decision point.

## 5. Interactions

The hook in `markPosted` runs inside a try/catch so a push failure never touches the hub post. `notify()` only calls a hook that reads the live adapter. The notification read token is accepted on exactly one route and nowhere else; any other request carrying it is refused 403. The pairing confirm/revoke flows are unchanged except that revoke also clears the push token.

## 6. External surfaces

The APNs payload carries the agent name, the device id, the item id and the source machine id — never item text. Item ids are chosen by their producers and can name a topic or peer, so they are identifying but not content. Calls to Apple's push service (api.push.apple.com / sandbox) with the operator's key. A published interface with the app: the register body, the title route, and the payload's `instar` block. Peers receive `POST /mobile/push/notify`.

## 6b. Operator-surface quality

Notifications show the agent and the item's title on a locked phone; nothing to configure on the phone beyond allowing notifications. The status route answers "why didn't my phone buzz?" in plain fields.

## 7. Multi-machine posture

Fan-out from whichever machine posts; per-machine dedupe on the condition key; tokens and text never cross machines. machine-local-justification: physical-credential-locality — each token stays on the record of the machine the phone paired with.

## 8. Rollback cost

`mobilePairing.push.enabled: false` stops sends at the next trigger; removing the vault key does the same. Tokens and state are inert JSON.

## Conclusion

The phone hears exactly what the Attention hub posts, bounded so it can never flood, with no item text passing through Apple.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the code: concern → resolved, concur.** The read token authenticates only the exact attention route for an active device (timing-safe hash compare, refused beside a signature, rate-limited); triggers received from a peer are never re-fanned, so they cannot bounce; each send is reserved before its first await; the only retry is one JWT refresh; revisions and version-checked clearing hold. Concern, fixed: a failed state write inside the async receive/tick could become an unhandled rejection and reach the process crash handler; every async entry point now catches and reports a degradation, and the fan-out call is wrapped. Minor notes applied: a fold due while paused or without a key is kept, not dropped; the artifact now says item ids (not text) reach Apple.

## Evidence pointers

- Spec and convergence report: `docs/specs/mobile-push.md`, `docs/specs/reports/mobile-push-convergence.md`.
- Tests: `tests/unit/mobile-push.test.ts` (15), `tests/integration/mobile-push-routes.test.ts` (4), `tests/e2e/mobile-pairing-alive.test.ts` (push route alive on production boot).

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `bounded`
- **reason:** Each send is triggered by a hub post the filter admitted; per device at most one per 2 minutes, hourly after 40 per rolling 24 h plus 10 URGENT (at most 74 a day), a persisted 429 backoff, no retries except one JWT refresh; the fan-out is one request per peer per post with no retry, and the receiving route caps 120 triggers per hour.
