---
title: "Mobile push — notify the Instar iPhone app when something needs the operator"
slug: "mobile-push"
author: "echo"
parent-principle: "Bounded Notification Surface — no feature may flood the user"
eli16-overview: "mobile-push.eli16.md"
status: "draft"
review-convergence: "2026-11-01T01:54:28.563Z"
review-iterations: 6
review-completed-at: "2026-11-01T01:54:28.563Z"
review-report: "docs/specs/reports/mobile-push-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
approved: true
approved-by: "Echo under the operator standing rule that only constitution changes need Justin (2026-10-22, JKHeadley/instar); 24h autonomous app session approved by Justin 2026-10-31, topic 134088"
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

## 1. Problem

The approved Instar app plan includes push notifications (operator request, 2026-10-20 and 2026-10-31, topic 127504). Today the app only learns that something needs the operator when it is open. The agent already decides which notices reach the operator: the Attention hub filter. Hub posts that filter lets through, and that Telegram accepted, should be the only inputs that can notify the phone (bounded, best-effort delivery as in 2.4), and the notification should say what it is about without the text passing through Apple.

## 2. Design

### 2.1 Direct from the agent, no central relay

Each agent sends its own notifications to Apple's push service (APNs) with the operator's APNs signing key. No Instar-run relay sits in between, matching the app's rule that each agent answers for itself (decentralized by default, operator direction 2026-10-31). The key is an operator credential read from the agent's vault (`apns_key_p8`, `apns_key_id`); the team id comes from config (`mobilePairing.push.teamId`). A relay for operators who have no Apple developer key is a later design and out of scope.

### 2.2 Registering a phone

The app asks iOS for notification permission when the operator turns notifications on, receives its APNs device token, and registers it:

`POST /mobile/device/push` `{ token, environment, notifyTokenHash, revision }` → `{ ok: true, revision }`, device-signed, active devices only (added to the device allowlist).
- `revision`: a positive integer the app increases on every change it makes. The app computes it as `max(lastRevision + 1, currentTimeMs)` and stores the revision with the request body before sending, so two changes in one millisecond or a clock correction never produce an equal or lower revision. The server keeps the highest revision applied per device. An older revision is refused (`409 stale-revision`, nothing changes); the same revision is accepted only with the same body (a retry), otherwise `409`. So neither a retry nor a captured request replayed later can restore an older registration.
- `token`: 64–200 lowercase hex characters. `environment`: `"sandbox"` or `"production"`, chosen by the app's build. `{ "token": null }` clears it.
- Stored on the device's own record (`pushToken`, `pushEnvironment`, `notifyTokenHash`, `pushUpdatedAt`) with `pushVersion`, which increases only when the stored token, environment or hash actually changes. Registering a token clears it from any other device record on that machine, so one token belongs to at most one record per machine. Revoking a device clears its token in the same write. No route ever returns a token; the paired-phones list shows `push: true|false`.
- **Notification read token.** The phone generates 32 random bytes, keeps them, and sends only their SHA-256 (`notifyTokenHash`, 64 hex). The phone replaces it only when it chooses to (e.g. a reinstall); a lost response never strands a credential. The hash is cleared with the push token or on revoke. The token authorizes exactly one thing: `GET /mobile/attention/:id` for that device (header `X-Instar-Notify-Token` with `X-Instar-Device`). The app keeps it in a keychain item readable after first unlock, shared with its notification extension, because the device signing key is usable only while the phone is unlocked (device-keys §2.1) and notifications arrive mostly on a locked phone.
- **How it authenticates.** The device check in the auth middleware gains one branch, run before signature verification: a `GET` whose normalized path is exactly `/mobile/attention/<id>` and that carries `X-Instar-Notify-Token` (and `X-Instar-Device`, no signature headers) is accepted when that device is active and SHA-256 of the token equals its stored hash (constant-time compare); the request principal is `device-notify`, which no other route accepts. Any other request with that header is refused `403`. The same route is also added to the signed-request allowlist, so the unlocked app can read it with a normal device signature.
- **One registration per agent (app rule, best effort).** When the operator has several paired entries for the same agent (same `agentId`, e.g. two machines), the app registers the token with the most recently paired one and sends `{ "token": null }` to the others, retrying at every app launch until each answers. While an old entry's machine is unreachable and still holds the token, that phone can receive a second notification for the same condition; the duplicate suppression in 2.3 is per machine. Each machine keeps its own allowance for the devices it holds.

### 2.3 What triggers a notification

Exactly two points, both after the hub filter has admitted the post and Telegram accepted it:
1. **Attention items:** inside `routeToAttentionHub`, in the `markPosted()` step that runs only after the hub message was sent. Held items, throttled reposts and failed sends never notify. An item that was held and later posted notifies only through this same step.
2. **Hub notices:** in `server.ts` `notify()`, after `admitNoticeToHub` admits a notice bound for the hub (inbound-message loss, stuck recovery, sender rejection, and the other user-impact notices).

The adapter calls one hook, `onHubPost({ kind: "item" | "notice", itemId?, dedupeKey, priority })`. `dedupeKey` is the item's `conditionKey` when it has one, otherwise its id; for a notice it is the notice category.

**Fan-out.** The machine whose hub post fired the hook notifies its own devices and sends the same trigger to every other online machine of the agent with `POST /mobile/push/notify` (Bearer, through the existing pool peer fetch and its credential URL guard, 5-second timeout, no retry). The body is the trigger only (`kind`, `itemId`, `dedupeKey`, `priority`, `sourceMachine`); no text crosses. Each machine applies 2.4 to its own devices. **Duplicate suppression:** a machine drops a trigger whose `dedupeKey` it already notified in the last 10 minutes, so two machines raising the same condition notify a phone once. Two different items inside 2 minutes fold (2.4).

### 2.4 What is sent, and how often

Payload (no item text):

```json
{ "aps": { "alert": { "title": "<agent name>", "body": "Something needs you" }, "sound": "default",
           "mutable-content": 1, "thread-id": "<agent name>" },
  "instar": { "kind": "item" | "notice" | "aggregate", "agentId": "<agent id>", "deviceId": "<device id>",
              "itemId": "<only when kind is item>", "machine": "<only when kind is item>", "count": 1 } }
```

**Readable notifications without Apple seeing the text.** The app's Notification Service Extension finds the paired entry by `agentId` and `deviceId` (the entry that registered this token), fetches `GET /mobile/attention/:id?machine=<machine>` from that entry's origin with the notification read token, and replaces the body with the item's title on the phone. The route answers `{ title, priority }` (title cleaned and clipped to 160 characters, untrusted text). It reads the local store when `machine` is this machine; otherwise `machine` must be a registered machine of this agent, and the item is read from it through the existing pool attention read; anything else is `404`. A notice (no `itemId`), a failed fetch, or more than 20 seconds keeps the generic text.

**Bounds (per device, durable).** State lives in `.instar/state/mobile-push-state.json`, written synchronously before each send.
- **Fold window, 2 minutes.** A trigger arriving when this device has had no notification in the last 2 minutes is sent at once as `item` or `notice`. Triggers arriving inside the window (items and notices, from any machine) are counted and send one `aggregate` notification when the window closes: no `itemId`, body "2 more things need you", `count: 2`. The extension never replaces an aggregate's text; tapping it opens the app's Needs-you list. Example: items at 10:00:00, 10:00:30 and 10:01:10 → one notification at 10:00:00, one with count 2 at 10:02:00.
- **Hourly threshold: 40 sends in any rolling 24 hours.** Past it, the device is throttled to one notification per hour (status `throttled`); nothing is dropped, it is folded. Under sustained traffic the most a device receives is 40 + 1 per hour + 10 URGENT in 24 hours, at most 74. Being throttled is a normal, recorded outcome, not a degradation.
- **One schedule per device.** The device has at most one pending notification with a due time and a count. A trigger either sends now (nothing pending and the device is allowed to send now) or joins the pending one (count + 1). The due time of the pending notification is the latest of (a) 2 minutes after the last send, (b) when throttled, 1 hour after the last send, and (c) `backoffUntil`, set to 10 minutes after an APNs `429` and persisted. An URGENT trigger lowers the due time to the later of (a) and (c), while the extra URGENT allowance of 10 per 24 hours lasts; the pending notification then goes out at that earlier time carrying everything folded so far. The state (pending count, due time, whether it holds an URGENT trigger, last send, the rolling send log) is in the state file and survives a restart; a due time already past at startup sends at once after the re-checks below.
- **Accounting.** A send is reserved in the state file before the request goes out; failed and uncertain sends count against the allowance. A restart keeps the window, counts and pending fold.
- **Every send re-checks, including a fold that fires later:** the device is still active, still has a token, the gate is on, and push is not paused. The send records the `pushVersion` it used; an APNs answer that clears a token clears it only if the record's `pushVersion` is still that version, so an answer about an old token never clears a new one.
- The receiving `POST /mobile/push/notify` checks its own gate, refuses device principals, answers `202` at once and does the send in the background, so a fan-out never waits on Apple. It accepts at most 120 triggers per hour per machine; beyond that it answers `429` and counts it.

### 2.5 Signing and transport

- The key and key id are read from the vault, and the team id from config, before each send (so removing or changing any of them takes effect at the next send). The ES256 JWT (`kid` = key id, `iss` = team id, `iat`) is cached for 50 minutes per credential set: the hash of key, key id and team id together.
- One HTTP/2 session per environment (`api.push.apple.com`, `api.sandbox.push.apple.com`), opened on first use, closed after 5 idle minutes, at most 20 sends in flight; on GOAWAY or a closed session the in-flight sends are recorded as uncertain and the next send opens a new session. Headers: `apns-topic: io.sagemindai.instar`, `apns-push-type: alert`, `apns-priority: 10`, 10-second timeout per send.
- **APNs answers:**
  - `200` → `sent` (Apple accepted it; not proof the phone showed it).
  - `410 Unregistered`, `400 BadDeviceToken`, `400 DeviceTokenNotForTopic` → the token is cleared on that record.
  - `403 ExpiredProviderToken` or `InvalidProviderToken` → a new JWT, one retry; if the retry is refused the same way, the send is `failed` and push pauses as for a key `403` below.
  - Other `403` (key or team) → push pauses on this machine with one degradation report; every 30 minutes the credential set (key, key id, team id) is re-read and the pause clears when any part of it changed.
  - `429` → `backoffUntil` for that device (2.4); it applies to URGENT triggers too.
  - Anything else, or a timeout → `failed`, no retry; the next trigger is the next chance.

### 2.6 Status

`GET /mobile/push` (Bearer): `{ enabled, keyConfigured, pausedReason, devices: [{ id, deviceName, environment, sent24h, throttled, backoffUntil, pending, lastSend: { at, outcome } | null }], fanout: { sent, received, deduped, refused } }`. A missing key reports `keyConfigured: false`; nothing is sent and nothing fails per item.

### 2.7 Gate

`mobilePairing.push.enabled` (omitted ⇒ follows `mobilePairing.enabled`, the development-agent gate). Read live.

## 3. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Which events notify | `invariant` | Exactly the hub posts the existing filter admitted and Telegram accepted; no new judgment. |
| Peer fan-out and duplicate suppression | `invariant` | One fixed trigger per hub post, the registered online machines, exact `dedupeKey` match, no retry. |
| Sent, folded or throttled | `invariant` | Fixed per-device window, rolling allowance and hourly fold, durable state. |
| Token accepted or cleared | `invariant` | Device signature, active status, hex grammar; fixed list of APNs reasons. |

## 3a. Signal vs authority

No detector gains authority. Push is an output channel for decisions the hub filter already made.

## 3b. Verify the state, not its symbol

- `sent` reads Apple's `200`: Apple accepted the notification. It does not prove the phone showed it (the phone may be off or have notifications disabled). The status says "accepted by Apple", never "delivered".
- `keyConfigured: true` means the vault holds both values; whether Apple accepts them is known only after a send (`403` sets `pausedReason`).
- When the state file cannot be read, nothing is sent (the allowance is unknown) and one degradation report says so.

## 4. Multi-machine posture

Unified delivery: a hub post on any machine notifies phones paired to every online machine (2.3 fan-out), once per condition per registration. The trigger travels between machines; tokens and text do not.

Not guaranteed: if a phone's old registration sits on a machine that is unreachable, the phone can receive a duplicate for one condition until that machine accepts the clear.

machine-local-justification: physical-credential-locality — each push token stays on the device record of the machine the phone paired with (device records are bound to that machine's hostname, device-keys spec), and that machine sends to it with the APNs key it holds. The key reaches other machines through the existing cross-machine secret sync, not through this feature. A machine that is offline when a post happens misses that notification (no queue): accepted, because the item stays in Telegram and in the app.

## 5. Frontloaded Decisions

- **Direct from each agent with the operator's key; no Instar relay** (a relay is a later design).
- **Notify on the two hub-post points only; no item text in the payload; the phone fetches the title itself.**
- **2-minute fold, hourly after 40 sends in 24 h (at most 74 a day), URGENT skips the hourly wait up to 10 more, APNs 429 backoff wins over both; durable state; no retries except one JWT refresh.**
- **One registration per agent per phone, set by the app, best effort; a duplicate is possible while an old machine is unreachable.**
- **Lock-screen titles through a narrow per-device notification read token, not the device signing key.**
- **Published interfaces with the app, frozen:** `POST /mobile/device/push { token, environment, notifyTokenHash, revision } → { ok, revision }`, `GET /mobile/attention/:id?machine= → { title, priority }` (device signature or notification read token), and the payload's `instar` block.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** integration and E2E tests register a token, see a hub post reach a fake APNs sender folded and throttled as specified, see a held item not notify, see a peer trigger deduplicated, and see revoke clear the token.
- **dev-agent-live:** with the operator's key in the vault, a real attention item on the development agent shows a readable notification on the operator's iPhone (TestFlight build), with the phone locked.
- **fleet:** follows `mobilePairing`.
- **graduation criterion:** a week on the development agent with no notification beyond the bounds and none for a held item.
- **dark-window:** if not met within 30 days of release, the reason and a new date are recorded on CMT-1179.

## 6. Rollback

`mobilePairing.push.enabled: false` stops all sends at the next trigger; tokens stay on the records, inert. Removing the vault key stops sends at the next send.

## 7. Tests

- Unit: a `429` then a new trigger and a restart keeps the backoff; a twice-refused JWT pauses; the schedule (allowance exhausted plus mixed URGENT and ordinary triggers, then a restart); correcting the team id alone clears a key pause; an older or reordered registration revision is refused and a same-revision retry is accepted; the notification read token works only on the attention route, only for an active device with a matching hash, through the production middleware; an old-version APNs answer does not clear a new token; a fold firing after revoke or gate-off sends nothing; aggregate payload has no `itemId`; JWT shape, reuse and refresh; payload carries no item text; fold timeline (the 10:00:00 / 10:00:30 / 10:01:10 example); rolling allowance, hourly fold past it, URGENT bypass bound; restart keeps window and counts; each clearing APNs reason clears the token; key `403` pauses and clears on key change; `429` extends the window; GOAWAY marks in-flight sends uncertain; dedupe window.
- Integration: bearer → 403 on the register route; a pending device refused; token stored, cleared by `null`, by re-registration on another record, and by revoke; device list shows `push` and never the token; a posted item notifies, a held or throttled one does not; a hub notice notifies; peer trigger answers 202 and is deduplicated; an unreachable peer is skipped; `GET /mobile/attention/:id` answers title and priority with the notification read token and with a device signature, refuses a wrong or old token, reads a peer's item when `machine` names a peer and refuses an unknown machine; status route.
- E2E: production boot, register route alive, status reports `keyConfigured: false` without a key.
