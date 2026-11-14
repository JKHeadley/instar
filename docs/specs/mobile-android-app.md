---
title: "Android app support on the agent: push through Firebase, App Links, platform-neutral pairing page"
slug: "mobile-android-app"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-android-app.eli16.md"
status: "draft"
review-convergence: "2026-11-14T11:59:14.648Z"
review-iterations: 6
review-completed-at: "2026-11-14T11:59:14.648Z"
review-report: "docs/specs/reports/mobile-android-app-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 15
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched); 24h Android run approved by Justin 2026-11-14 02:11 PST, topic 141385"
---

## 1. Problem

Justin decided on 2026-11-14 (topic 142909, 01:43 PST) to build a native Android Instar app at the iPhone app's level, and asked at 02:11 PST for a 24-hour run on it. Phase 1 of the app (pair, agent list, app lock, conversations, read and send) exists at `apps/instar-android` and was proven on an Android 16 emulator against a throwaway agent on 2026-11-14 (link and QR pairing, code and Approve confirmation, signed send recorded `originVerified: verified`, agent reply shown, read marker recorded). The app's notification client is also written (`InstarMessagingService.kt`, `Push.kt`, commit 204ba17): it registers `{ provider: "fcm", token, notifyTokenHash, revision }`, and on a data message fetches the real text with the notification read token, at most 15 seconds, then always shows a notification (the generic text when the fetch fails).

Everything the app calls on the agent is platform-neutral (device keys, signatures, pairing, conversations, unread, media) except these, all on the agent or its website:

1. **Push is Apple-only.** `POST /mobile/device/push` accepts only a lowercase hex APNs token with `environment` `sandbox|production` (`mobilePairingRoutes.ts:1721-1722`). `MobilePushService` has one transport, HTTP/2 to APNs, and its send path requires `pushEnvironment` (`MobilePush.ts:266`). An Android phone cannot register, so it never gets a notification.
2. **No App Links file.** A tapped `https://instar.sh/pair#…` link opens the Instar iPhone app because `instar.sh/.well-known/apple-app-site-association` names it. Android verifies `https://instar.sh/.well-known/assetlinks.json` instead; there is none, so on Android the link opens the browser's pair page (whose copy/QR fallback still works) instead of the app.
3. **Apple wording.** `site/src/pages/pair.astro:36` says "On your iPhone". The approval notices say "Tap to approve with Face ID" (`MobilePush.ts:48-51`). The agent-facing CLAUDE.md push section and the CapabilityIndex entry describe push as Apple-only (`PostUpdateMigrator.ts:1691-1693`, `CapabilityIndex.ts` mobilePairing entry), so an agent would tell an Android user to use the iPhone app.

## 2. Design

### 2.1 App Links file

`site/src/pages/.well-known/assetlinks.json.ts` (next to `apple-app-site-association.ts`, same Astro API-route pattern on the Vercel adapter, `prerender = false`, `Content-Type: application/json`, `Cache-Control: public, max-age=3600`) answers:

```json
[{ "relation": ["delegate_permission/common.handle_all_urls"],
   "target": { "namespace": "android_app", "package_name": "io.sagemindai.instar",
               "sha256_cert_fingerprints": ["<upload key>", "<Play app signing key>"] } }]
```

- The fingerprints are public values (certificate hashes, not secrets) kept as a constant list in the file. The upload key's is known now (`3B:05:15:62:1C:08:64:31:EB:55:A6:82:EA:17:42:1A:65:17:03:D1:8C:30:BD:83:A4:20:50:86:72:DD:6B:50`); the Play app signing key's exists only after the app is created in Play Console and is added then (same file, one line; tracked in §2.6). Until it is added, an app installed from Play opens pair links in the browser, exactly as today.
- `handle_all_urls` grants the whole host; the app's own intent filter (`autoVerify`, `https`, host `instar.sh`, path `/pair`) is what limits it to pairing links. This is Android's only model. The app's intent filter must stay limited to `/pair`; widening it would hand the app every `instar.sh` URL.
- The pairing code rides in the fragment, which never reaches instar.sh (mobile-pairing-link §2), so the file changes nothing about what the site sees.

### 2.2 Wording

- `pair.astro`: "On your iPhone with the Instar app, scan this code with the camera." becomes "On your phone with the Instar app (iPhone or Android), scan this code with the camera." The page has no platform detection and gets none.
- Approval notice text is chosen per provider (§2.3 Message). iPhone text is unchanged.
- The agent-facing text is rewritten to name both providers (§2.5).
- Out of scope, recorded in the convergence report's Left behind: browser-approval copy elsewhere that says "Face ID" (`mobileBrowserDevices.ts:143`). Android Phase 1 cannot approve anything, so no Android user reaches it yet.

### 2.3 Push to Android through Firebase Cloud Messaging (FCM)

The design of mobile-push.md (what triggers a notification, the fan-out between machines, the fold window, the rolling allowance, the durable per-device state, the notification read token, the payload's `instar` block) is unchanged and applies to every device. Registration, the send path, transport and the outer message shape gain an FCM branch. mobile-push.md froze its interfaces with the iPhone app; this section extends them without changing any iPhone-visible behavior.

**Registration.** `POST /mobile/device/push` gains an optional `provider: "apns" | "fcm"`; absent means `"apns"`, so every existing iPhone request is read exactly as today. Unknown `provider` values → `400 bad-provider`.
- `provider: "fcm"`: `token` is 32–4096 printable ASCII characters with no spaces (`^[\x21-\x7e]{32,4096}$`). Google documents FCM tokens as opaque with no published format, so this is a local size and storage floor, not a provider rule: real tokens are about 150–165 characters of `[A-Za-z0-9_:-]`, and the token only travels inside a JSON body, never a URL path. `environment` must be absent (any value → `400 bad-environment`). Every other rule is unchanged: device-signed, active devices only, `revision` ordering, `notifyTokenHash` required, `{ "token": null }` clears, revoke clears.
- `provider: "apns"`: unchanged (hex 64–200, `environment` required).
- **Clearing** (`{ "token": null }`) is handled before any provider, token or environment check, as today (`mobilePairingRoutes.ts:1719`): it accepts a missing `provider` or either value. The Android app's clear sends no provider (`NotifyTarget.kt` `pushRegistrationBody`).
- **The device record** gains `pushProvider: 'apns' | 'fcm'`, written on every registration that sets a token (absent on old records = `apns`). `samePush` compares `(d.pushProvider ?? 'apns')` with `(r.provider ?? 'apns')`, so an old iPhone record retried at the same revision still matches, and a provider change (even with the same token string) is a change: it bumps `pushVersion`, and a same-revision retry with a different provider is a `409`. Setting an FCM token deletes any `pushEnvironment` left from an APNs registration. `clearPush` deletes `pushProvider` with the other push fields. The one-token-per-machine rule compares the raw token string, as today.
- **The answer** to a registration that sets a token gains `ready: boolean`: true when push is switched on (`isMobilePushEnabled`, the same check `send()` makes), this machine holds the key for that provider, and that provider is not paused. A clear's answer has no `ready`. It is additive; the iPhone app ignores unknown fields. The Android app uses it to say "Notifications aren't set up on this agent yet. The agent is fixing it." instead of showing notifications as on while nothing can arrive (an app change, §2.6). `ready` is a reading at registration time, not a promise.

**The send path** (`MobilePushService.send`) becomes provider-aware. Before the reservation it:
1. reads the provider (`d.pushProvider ?? 'apns'`);
2. re-checks the device is active, the gate is on, and it has a token, and, only for `apns`, that it has an environment;
3. checks that provider's pause (`paused` for APNs, `pausedFcm` for FCM) → `paused`;
4. reads that provider's credential (`credentials()` for APNs, a new `fcmCredentials()` for FCM) → `no-key` when absent.

So an FCM device on a machine with no APNs key, or the reverse, is unaffected by the other provider. The reservation, the budgets and `clearPushIfVersion` are shared and unchanged.

**Held while paused or keyless (FCM only).** Today a fold that comes due while push is paused or has no key is kept (`tick()`, `MobilePush.ts:238`), but a trigger sent at once (`receive()`, `MobilePush.ts:209`) is dropped when the answer is `paused` or `no-key`. For FCM devices, that answer joins the device's pending fold instead (count + 1, due at the next allowed time), so the notification goes out once sending works again, through the same fold and allowance. Nothing was reserved, so nothing is counted twice. The send that causes a pause, and a refused trial, also keep their fold (its spent allowance is not refunded). Keeping a fold after an `await` merges, never assigns: the held count is added to whatever `receive()` folded in meanwhile, the URGENT mark is the OR of both, and the due time is recomputed from the current state (`dueFor`, which includes the new `lastSendAt` and any `backoffUntil`). The same merge replaces the plain restore in today's `tick()` (`MobilePush.ts:238`) for FCM devices. While FCM is paused or keyless, `tick()` leaves held FCM folds in place without calling `send()`, so a phone on an agent with no Firebase key costs no disk writes. APNs behavior is unchanged (convergence report, Left behind).

**iPhones never wait for Android.** `receive()` and `tick()` send to devices one after another (`MobilePush.ts:200-210`, `229-239`). Both now send the APNs devices and the FCM devices as two lists side by side, each list still one device after another. `tick()` keeps one guard per provider: a provider's pass still running when the 15-second timer fires is skipped for that provider only, so an unfinished FCM pass never holds back an APNs fold that comes due meanwhile. Immediately before each FCM device's send, its rolling send logs are pruned (today `prune` runs only in `receive()` and `status()`, so a fold resumed by `tick()` after a long pause could read expired entries) and its eligibility is re-read from the current state (nothing pending that this pass did not take, `dueFor` already passed); if it no longer holds, the notification joins that device's fold instead. The reservation (`sendLog`, `lastSendAt`, `save()`) is then taken synchronously in the same step, before the first `await`, the token exchange included. So a pass that was waiting on an earlier device, or two triggers arriving during an exchange, can never send twice to one device. `save()` is synchronous and the two lists never share a device. A slow or stalled Google exchange never delays an iPhone send. Each FCM device's work in one trigger (exchange, send, the one `401` refresh and resend) has an overall deadline of 30 seconds; past it the send is `failed`.

**Credential.** A Firebase service-account JSON key in the vault as `fcm_service_account_json`, read before each send like the APNs key. The entry may be stored as JSON text or as an object; the credential hash is SHA-256 of the text, or of `JSON.stringify` of the object. `fcmCredentials()` parses it and returns `{ projectId, clientEmail, privateKey }` only when `project_id` matches `^[a-z][a-z0-9-]{4,29}$` (it goes into the URL path), `client_email` is an email address, and `private_key` parses as a PEM private key; otherwise it returns null (`no-key`) and one degradation report says the entry is unreadable. No new config key. The service account is a dedicated one holding only the Firebase Cloud Messaging send role (`roles/firebasecloudmessaging.admin`), not the default `firebase-adminsdk` account, so a leaked key can send messages and do nothing else in the project. The JSON's own `token_uri` is ignored.

**Auth.** An RS256 JWT (`iss` = `sub` = `client_email`, `aud` = `https://oauth2.googleapis.com/token`, `scope` = `https://www.googleapis.com/auth/firebase.messaging`, 1-hour expiry) is exchanged at the fixed URL `https://oauth2.googleapis.com/token` for an access token, with a 10-second timeout. The access token is held in process memory only (never in the state file), cached 50 minutes per credential hash (Google's access tokens last 1 hour; the APNs JWT uses the same 50 minutes, `MobilePush.ts:24`), with one exchange in flight per credential hash (concurrent sends wait for it). A `401` from FCM discards the cached token for that hash before the retry, so other sends do not reuse it. Exchange answers:
- `200` with a token → use it.
- `400` or `401` with `invalid_grant` or `invalid_client` (the key is wrong, revoked or deleted) → pause FCM (below).
- A network error, timeout or `5xx` → this send is `failed`, no pause, no retry; the next trigger tries again.

**Send.** `POST https://fcm.googleapis.com/v1/projects/<projectId>/messages:send` with `Authorization: Bearer <access token>`, a 10-second timeout (`AbortSignal.timeout`), at most 20 in flight (the same values as the APNs transport, `MobilePush.ts:412,426`; over the limit the send is `failed`, as for APNs), the response body read up to 64 KB (FCM error bodies are about 2 KB; a larger one is `failed`, never read as a verdict), through Node's global `fetch` (no new dependency). The 10 seconds and 20 in flight bound this agent's own outbound load per machine; a send over the in-flight limit is lost (no retry) while the item stays in the app, as for APNs. The transport returns `{ status, errorCode?, tokenFieldViolation, retryAfterSec? }`.

**Message.** Data-only, so the app builds the notification itself after fetching the real text, as the iPhone's notification extension does:
```json
{ "message": { "token": "<token>",
    "android": { "priority": "HIGH" },
    "data": { "instar": "<the same instar block as JSON text>", "title": "<agent name>",
              "body": "<the generic body text>", "badge": "<only for a reply, when known>" } } }
```
- `buildPayload` stays as it is for APNs. A `buildFcmMessage(token, agentName, instar, body, badge)` helper builds this from the same `instar` block (FCM data values must be strings).
- **No `ttl` and no `collapse_key`**, matching APNs, which sets neither `apns-expiration` nor `apns-collapse-id` (`MobilePush.ts:304`). Google keeps the message for its default time and delivers each one; the fold and the daily allowance already bound how many there are.
- **Body text** is the same generic text as the APNs alert ("Something needs you", "New reply", "N more things need you"), except the two approval notices, whose FCM text has no "Face ID": "A new browser wants to use your conversations. Tap to approve." and "A new phone wants to pair. Tap to approve." The iPhone text is unchanged.
- **Approval notices (`subject` `browser-approval` or `phone-approval`) go to an FCM device only when it can approve**: it has a presence key and is an active owner phone, the same test the agent already uses for "an owner phone able to answer" (`ownerPhoneCanApprove`, `mobilePairingRoutes.ts:974`). Approving needs a presence-key signature, so a phone that cannot approve is not asked to. Android Phase 1 registers no presence key, so it gets no approval notices until Phase 3 adds approving. Other notices are filtered as today (`receivesNotices`). iPhone targeting is unchanged.
- No item text, reply text or preview ever goes to Google, matching the APNs rule. `data.title` and `data.body` are placeholders the app replaces with what the agent returns to the read-token fetch.

**Answers.** Read from the structured error (`error.details[]` entry of type `google.firebase.fcm.v1.FcmError`, field `errorCode`, and a `google.rpc.BadRequest` entry's `fieldViolations[].field`), never from the `message` text:
- `200` → `sent` (Google accepted it; not proof the phone showed it, same wording as APNs).
- `errorCode: UNREGISTERED` (404), or `INVALID_ARGUMENT` (400) with a field violation on exactly `message.token` → clear the token (`clearPushIfVersion`, unchanged rule).
- Any other `400`, or a body that is missing, too large or does not parse → `failed`, with one degradation report (the reporter dedupes), and the token stays. A bug in our own message can never clear tokens.
- `401` → one retry with a fresh access token; a second `401` → pause FCM.
- `errorCode: SENDER_ID_MISMATCH` (403): either this one token belongs to another Firebase project (a mis-built app, such as a debug build), or this machine holds the wrong key. It acts on that device only: `backoffUntil` of 24 hours, outcome `sender-id-mismatch` in its status row, token kept, no provider pause. A wrong key shows up as every FCM device on the machine in that state; when that is true, one degradation report (`MobilePush.fcmCredentials`, reason `sender-id-mismatch`) names both possible causes (a mis-built app, such as a debug build, or the wrong key) and starts the recovery below. When the FCM credential hash changes, and on `POST /mobile/push/recheck`, every `backoffUntil` on a device whose `lastSend.outcome` is `sender-id-mismatch` is cleared (no send can overwrite that outcome while the device is in backoff), so a fixed key reaches the phones at their next notification instead of a day later. No token is ever cleared for this answer: Android re-registers only when its token changes, so a wrongly cleared token would stay silent, and nothing here proves which side is wrong. One mis-built phone never silences the others, and costs at most one request a day. Every send to a device in backoff (mismatch or `429`) is still started only by a real trigger and counted against that device's existing allowance (at most 74 a day, mobile-push §2.4), so no failure answer makes the agent send on its own.
- Other `403` (`PERMISSION_DENIED`: the FCM API turned off, or the role missing) → pause FCM with reason `permission-denied`. A `404` without `UNREGISTERED` (the project id does not exist) → pause FCM with reason `project-not-found`.
- `429` (`QUOTA_EXCEEDED`) or `503` (`UNAVAILABLE`) → `backoffUntil` for that device: the later of `Retry-After` and the existing 10-minute backoff (`BACKOFF_MS`, a local default inherited from APNs), capped at 1 hour (a local choice). Only a whole number of seconds counts; an HTTP-date or anything else is treated as absent. The cap stops a bad header from silencing a phone for days; if Google wanted longer, the cost is one more `429` an hour.
- Anything else, or a timeout → `failed`, no retry.
- Only the `errorCode` enum is recorded (in `lastSend.outcome` and the pause reason). Google's `message` text and the token never reach `status()`, `lastSend` or a degradation report.

**Pause per provider.** `PushState` keeps `paused` as the APNs pause, unchanged, and adds `pausedFcm: { reason, credHash, at, checkedAt, refusedTrials, nextTrialAt } | null`, which `load()` must read alongside the existing fields (`MobilePush.ts:132` rebuilds state from a fixed field list). The trial count and next trial time are saved so a restart (several a day, on updates) does not reset the backoff; only the "trial armed" flag lives in memory, and losing it only delays a trial. After a revert, the old code reads `paused` exactly as before and drops the new field at its next save; iPhones are not paused, and after a re-upgrade the next FCM send simply tries again. An FCM pause never stops iPhone sends, and the reverse.

**Recovering an FCM pause.** Every `tick()` checks the FCM pause. The credential hash comparison runs at most every 30 minutes (keyed on `checkedAt`, as for APNs) and clears the pause when the hash changed, so a new key is noticed within 30 minutes whatever the trial schedule. Separately, on every tick, once `nextTrialAt` has passed and the hash is unchanged, it arms one trial: the next FCM send is let through, and the flag is consumed and `nextTrialAt` set to null before the request goes out (its real value is written when the answer arrives), so one trial covers all devices and no second trial is armed while one is in flight. While a trial is armed, `tick()` lets the first due held FCM fold through as the trial, so held notifications do not wait for a new one. The trial clears the pause on `200`, and also on any answer that is only about that phone's token (`UNREGISTERED`, a `message.token` violation, `429`), because Google gives those only after accepting the key, project and permission; the token is still cleared where the normal rule says so. Any other answer (`SENDER_ID_MISMATCH`, `401`, `403`, `404`, `5xx`, a network error, the 30-second deadline) keeps the pause, adds one to `refusedTrials`, records the latest reason, and raises no new report. Trial k waits 30 minutes × 2^(k−1) after the previous one (30 minutes, 1, 2, 4, 8, 16 hours), and after 6 trials no more run (`nextTrialAt` null). So a cause that is never fixed costs at most 6 requests in about 31.5 hours, then none, and the pause stays visible in `pausedReasons.fcm`.

**Re-check after a recovery.** `POST /mobile/push/recheck` (Bearer, `{ provider: "fcm", forwarded?: true }`; any other body is `400`; at most 6 an hour per process, in memory like the notify limit) resets `refusedTrials` to 0 and sets `nextTrialAt` to now, so the trial survives a restart. A Firebase fault (`permission-denied`, `project-not-found`) pauses every machine with an Android phone, each on its own trial clock, so the route also sends the request to every online machine of the agent (Bearer, through the pool peer fetch and its credential URL guard, 5-second timeout, no retry, the pattern of `/mobile/push/notify`) with `forwarded: true`; a forwarded request is applied locally and never sent on, so each machine applies one recheck once. Each machine applies its own limit. It answers `{ machines: [{ machine, armed, reason? }], unreachable: [...] }`, where `armed: false` carries `not-paused` or `no-key`. The agent calls it at the end of every recovery it carries out (below). A cause fixed without a new key (the API or role turned back on) therefore clears at the next FCM send after the recheck (a held fold goes on the next tick), and a new key still clears within 30 minutes with no call.

**The pause report.** A pause is a credential failure the agent must act on, so it is reported once, on the same tick (as for APNs), under its own name `MobilePush.fcmCredentials` (APNs keeps `MobilePush.apnsCredentials`, `MobilePush.ts:285`), so the reporter never merges the two. It names the agent's own recovery for that reason, not a chore for a person:
  - `invalid_grant`, `invalid_client` or a second `401`: "Google refused the Firebase key. Recovery: make a new key for the Instar push service account in the Instar Firebase project with the operator's Google browser profile and store it as `fcm_service_account_json`; the pause clears within 30 minutes."
  - Every device in `sender-id-mismatch`: "Google says these phones belong to a different Firebase project than the key. Recovery: check whether the installed app is a build for another project (a debug build) and whether the vault key is for the Instar Firebase project; fix the one that is wrong, then call recheck."
  - `permission-denied`: "Google refused the send permission. Recovery: in the Instar Firebase project, turn the Firebase Cloud Messaging API on and give the push service account the Cloud Messaging role; the next trial clears the pause."
  - `project-not-found`: "The key names a Firebase project that does not exist. Recovery: make a new key in the Instar Firebase project."

  The agent does that recovery itself (§2.6 route) and ends it with `POST /mobile/push/recheck`. It asks the operator only for a Google step only they can complete, through one phone-completable approval.

**Status.** `GET /mobile/push` adds `fcmTrials: { refused, nextAt }` while FCM is paused, and `fcmConfigured` (`fcmCredentials()` returns a value) and `pausedReasons: { apns, fcm }`. `keyConfigured` and `pausedReason` keep meaning APNs, for older readers. Each device row adds `provider`; `environment` is null for FCM rows. No row ever shows a token.

**Degradation wording.** The push degradation report's fallback text changes from "the item is still in Telegram and the app" (`AgentServer.ts:2182`) to "the item is still in the app and the agent's other channels". The old text is false for app replies and for agents with no Telegram.

**Gate.** Unchanged: `mobilePairing.push.enabled`. FCM needs no gate of its own. With no FCM key nothing is sent to Android and nothing fails per item (`fcmConfigured: false`, `ready: false`), the same posture APNs had before its key existed.

**Phones without Google Play services** (no FCM token): the app does not register a token and says so; it tries again when opened. No server change.

### 2.4 Android delivery, honestly

What the agent can and cannot see after Google's `200`:
- A phone that is off or offline gets the message when it reconnects, within Google's default storage time.
- A user who force-stopped the app gets nothing until they open it. Android rules, not ours.
- Android lowers the priority of an app's high-priority data messages if the app often shows no notification. The app's handler (`InstarMessagingService.onMessageReceived`) builds and posts a notification on every message, with the generic text when the fetch fails or takes more than 15 seconds, which is what keeps that rule from applying. Posting is not proof Android showed it; if the user later denies the notification permission in Android settings, Android drops it and the agent cannot tell (the app asks for the permission when notifications are turned on, `AgentsScreen.kt`).
- The badge is carried as data; many Android launchers show only a dot.
- None of these are visible to the agent. Status says "accepted by Google", never "delivered".

### 2.5 Agent awareness and migration

- CapabilityIndex: the mobilePairing entry's push wording names both providers, `fcm_service_account_json`, `fcmConfigured`, `pausedReasons`, the register route's `provider` and `ready`, and the new `POST /mobile/push/recheck` (added to its endpoint list).
- `MOBILE_PUSH_CLAUDEMD_SECTION` (`PostUpdateMigrator.ts:1690`) is rewritten to name both: "Phone notifications go to iPhones through Apple and to Android phones through Google's Firebase. The Android key is the vault entry `fcm_service_account_json`; `GET /mobile/push` shows `fcmConfigured` and `pausedReasons`; after fixing an Android pause, call `POST /mobile/push/recheck`." Its heading keeps the words `Mobile push notifications`, so the existing add-if-missing guard (`PostUpdateMigrator.ts:11281`) never adds a second copy.
- Agents whose CLAUDE.md carries the core markers rebuild the block from `buildCanonicalClaudeMd()` (`PostUpdateMigrator.ts:9352`) and pick up the new section on their next update with no new migration.
- For marker-less (legacy, full-layout) files, the old text is kept as `MOBILE_PUSH_CLAUDEMD_SECTION_V1(port)` and swapped for the new one only on a byte-exact match, following the `RECOMMENDED_SERVICES_V2_TAIL` pattern (`PostUpdateMigrator.ts:11243`). An old section the operator edited is left alone, with one `REVIEW:` line. The swap runs before the add-if-missing guard.
- No config default changes, so no config migration.

### 2.6 Work outside this repository (part of done)

Each is on this spec's completion list; the build is not done without it.
- **Firebase project and key.** The building run creates the free Firebase project in the operator's Google account (browser profile `justin-google` in the Playwright profile registry), registers app `io.sagemindai.instar`, creates the dedicated service account with only the FCM send role, and stores its key in Echo's vault as `fcm_service_account_json`. It does this under the 2026-11-14 run request (topic 142909, 02:11 PST). The operator's account is the status quo for this app: the APNs key is the operator's Apple credential (mobile-push §2.1) and the Play Console app is the operator's, so the project that signs the app's pushes sits with them, not with the agent's own account. Done means `GET /mobile/push` shows `fcmConfigured: true` on every machine of Echo's pool and a trial send returns `sent`. If Google asks for a step only the operator can do (a second-factor prompt), the run sends one phone-completable approval in the operator's topic and continues after it; that step is the only point the run waits.
- **Android app config.** The Firebase app id, sender id, API key and project id go into the app build (`BuildConfig.FIREBASE_*`, public values). `apps/instar-android` is Echo's own local repository; Echo makes this change in the same run.
- **Android app reads `ready`.** The app shows "Notifications aren't set up on this agent yet. The agent is fixing it." when the register answer says `ready: false`, and shows a refused token's `400 bad-token` as an error rather than as notifications on. Same repository, same run.
- **Play app signing fingerprint.** Added to `assetlinks.json.ts` once Play Console creates the app. The building run opens a dedicated commitment for it; its close test is the Digital Asset Links API check in §3b listing both fingerprints. Opened as CMT-1764.
- **A push path for other people's agents.** Tokens from the published app belong to the operator's Firebase project, so another person's agent cannot send to them even with its own Firebase project. The same is true for iPhones today (mobile-push §2.1). The building run opens one tracked commitment for a relay design covering both platforms. Its close test: a phone paired only with an agent that is not the operator's receives a notification. Opened as CMT-1765.

## 3. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| FCM token accepted | `invariant`; basis: irreversible-consequence; evidence: the token is persisted in the device registry file for the life of the registration, so a local size and storage floor (printable ASCII, 32–4096, about 25 times the observed 150–165 characters) keeps control characters and unbounded strings out of that record; Google documents tokens as opaque, so no tighter rule is claimed | Device signature and active status unchanged; a refused token is a visible `400 bad-token` in the app. |
| Which transport sends | `invariant`; basis: enumerable-domain; evidence: the closed set `apns`/`fcm`, read from the device record's `pushProvider`, set only by that device's own signed registration | — |
| FCM token cleared / failed / pause | `invariant`; basis: external-constraint; evidence: the FCM v1 `FcmError.errorCode` enum and the `BadRequest` field violation on `message.token` | Same shape as the APNs list; a malformed or unknown answer never clears. |
| FCM backoff length | `invariant`; basis: external-constraint; evidence: Google's `Retry-After` header and FCM's documented 429/503 retry guidance; the rule is the later of `Retry-After` and the inherited 10-minute local default, capped at a local 1 hour whose cost (one more `429` an hour) is stated | Two inputs, one fixed combination rule; no competing judgment. |
| `SENDER_ID_MISMATCH` handling | `invariant`; basis: irreversible-consequence; evidence: a wrongly cleared token stays silent until the phone's token changes, and nothing in the answer says which side is wrong, so the action is limited to the one device and deletes nothing | All devices in that state raise the key report. |
| FCM pause lifted | `invariant`; basis: external-constraint; evidence: only Google's answer to a changed key or to a trial send can show sending works again; an answer about one token (`UNREGISTERED`, token violation, `429`) is given only after the key, project and permission were accepted | At most 6 automatic trials, doubling from 30 minutes; a new key is noticed within 30 minutes; the agent's recheck after a recovery arms one more. |
| Approval notice sent to an FCM device | `invariant`; basis: enumerable-domain; evidence: approving needs a presence-key signature from an active owner phone, the existing `ownerPhoneCanApprove` test (`mobilePairingRoutes.ts:974`) | iPhone targeting unchanged. |
| App Links association | `invariant`; basis: external-constraint; evidence: Android's Digital Asset Links format, one package and its certificate hashes | — |

## 3a. Signal vs authority

No detector gains authority. FCM is a second output channel for decisions the hub filter already made. Google's answers decide only what happens to this one send, this token and this provider's pause, never to iPhone sends.

## 3b. Verify the state, not its symbol

- `sent` reads Google's `200`: accepted, not shown (§2.4). Status says "accepted by Google", never "delivered".
- `fcmConfigured: true` means the vault entry parses into the three fields; whether Google accepts the key is known only after a send (`pausedReasons.fcm`). `ready: true` in the register answer is the same reading, not proof.
- A token cleared on `UNREGISTERED` is cleared only when the record still holds the version used for that send (`clearPushIfVersion`), so an answer about an old token never clears a new one. An unparseable answer is `unknown` (recorded `failed`), never "token bad".
- assetlinks.json being served does not prove verification: the live check is Google's Digital Asset Links API (`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://instar.sh&relation=delegate_permission/common.handle_all_urls`) listing the statement, and `adb shell pm get-app-links io.sagemindai.instar` showing `instar.sh: verified` on a phone with the Play build.

## 4. Multi-machine posture

Unchanged from mobile-push §4: the trigger fans out between machines; tokens and text do not. Each machine sends to the phones paired with it, with the key it holds.

- machine-local-justification: physical-credential-locality — the FCM token and `pushProvider` on the device record, as in mobile-push §4: only the machine holding the record verifies that phone's signed registration and revocation, so a copied token could notify a phone another machine had already revoked. The binding of device records to one machine is marked temporary in mobile-device-keys; when multi-host serving lands, these move with the record.
- machine-local-justification: physical-credential-locality — `pausedFcm` in `state/mobile-push-state.json`: they record Google's answer to the key copy on this machine's disk. A unified pause would let one machine's wrong copy stop sends on machines whose copy is good.
- machine-local-justification: physical-credential-locality — the FCM access token, in process memory only, derived from this machine's key and never written down.
- `fcm_service_account_json` is unified: it reaches the operator's other machines through the existing secret sync, which copies every vault entry except a short denylist (`SecretSync.ts:80-93`), with no change. Secret sync is itself dev-gated (`multiMachine.secretSync.enabled`). On an agent without it, a machine without the key reports `fcmConfigured: false` and `ready: false` to the phones paired with it, so the gap is visible to the phone and in that machine's status.

The website file is not machine state.

## 5. Frontloaded Decisions

- **Data-only FCM messages; the app fetches the text with the notification read token**, so Google sees no more than Apple does.
- **`provider` absent means `apns`**: no iPhone request, record or payload changes.
- **Provider-aware send path; pause per provider in a separate `pausedFcm` field**: an FCM problem never silences iPhones, and a revert never pauses them.
- **Clear a token only on `UNREGISTERED` or a token field violation; `SENDER_ID_MISMATCH` backs off that one device and never clears**: a bug or a wrong key never clears tokens.
- **FCM devices hold a notification that arrives while paused or keyless; APNs unchanged.**
- **APNs and FCM devices are sent side by side**: iPhones never wait for Google.
- **The Firebase project is in the operator's Google account**, like the APNs key and the Play Console app.
- **An FCM pause is recovered by the agent**, by reason (a new key, or turning the API or role on, through the browser profile); the person is asked only for a step only they can do.
- **No `ttl`, no `collapse_key`**: matches APNs.
- **No "Face ID" in Android text; approval notices only to phones with a presence key.**
- **A dedicated service account with only the FCM send role.**
- **`ready` in the register answer**: the phone can say when notifications cannot arrive.
- **No new config key**: the project id comes from the service-account JSON.
- **No new HTTP dependency**: global `fetch`.
- **Play app signing fingerprint added when Play creates it**: the file ships with the upload key's fingerprint now.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** unit and integration tests below; an FCM transport double asserts the exact request; a throwaway agent with the real Firebase key sends to the Android emulator (Google APIs image, Play services) and the app shows the notification with the real title.
- **dev-agent-live:** with the key in Echo's vault, a real attention item and an app reply notify the operator's Android test phone (Play internal testing build) with the phone locked; assetlinks verified by `pm get-app-links` on that build.
- **fleet:** follows `mobilePairing.push`.
- **graduation criterion:** a week on the development agent with no Android notification beyond the bounds, none for a held item, none lost while the phone was online and the app not force-stopped, and no iPhone notification lost or duplicated.
- **dark-window:** if not met within 30 days of release, the reason and a new date are recorded on CMT-1759.
- **ladder:** mobilePairing (push has no entry of its own and follows the mobilePairing switch when unset, per mobile-push 2.7)

## 6. Rollback

Remove `fcm_service_account_json` from the vault: FCM stops at the next send, iPhones unaffected. `mobilePairing.push.enabled: false` stops all push as before. Removing the assetlinks route returns Android links to the browser page. Revert the PR for everything: old code skips FCM records (they have no environment) and drops `pausedFcm` at its next save, so nothing wrong is sent and iPhones are not paused.

## 7. Tests

- Unit:
  - FCM token grammar: accepted, too short, a space, with `environment` → 400; unknown `provider` → 400.
  - `provider` absent reads as `apns`, and an existing APNs registration round-trips unchanged.
  - Switching provider with the same token bumps `pushVersion`; a same-revision retry with a different provider is `409`; clearing removes `pushProvider`.
  - An FCM device with no environment reaches the FCM transport; an FCM device on a machine with no APNs key sends; an APNs device on a machine with no FCM key sends; an FCM fold that fires later sends.
  - `buildFcmMessage` carries the same `instar` block as `buildPayload` as JSON text, string data values, the generic body, the badge only on replies, no `ttl` or `collapse_key`, no item text; approval text has no "Face ID"; the APNs payload is byte-identical to before.
  - An approval notice skips an FCM device without a presence key and a non-owner FCM device with one, and reaches an active owner FCM device with one; iPhone devices unchanged.
  - Access-token JWT shape, 50-minute reuse, one exchange in flight; `token_uri` ignored; exchange `invalid_grant` pauses; exchange timeout or `503` is `failed` without a pause.
  - `401` then fresh token then success; `401` twice pauses FCM only (an APNs device still sends).
  - `UNREGISTERED` and a `message.token` violation clear only with a matching `pushVersion`; another `INVALID_ARGUMENT`, a missing body and an unparseable body leave the token.
  - `SENDER_ID_MISMATCH` backs off only that device for 24 hours and keeps its token, and a second FCM device still sends; when every FCM device is in that state, one report naming both causes is raised; a key change or a recheck clears those backoffs.
  - `429` with `Retry-After: 120`, with `7200` (capped), with an HTTP-date, and with none.
  - An old state file with only `paused` reads as an APNs pause; a new file read by the old shape pauses nothing; the FCM trial lifts a pause when it succeeds; under a cause that stays, trials back off and stop after 6 (network errors count), and the count and next time survive a restart; a new key lifts the pause within 30 minutes even with a 16-hour trial gap; after the sixth trial, re-enabling the API and calling `POST /mobile/push/recheck` clears the pause with no new trigger (the held fold goes as the trial on the next tick); a trial answered `UNREGISTERED` clears the pause and the token; recheck with nothing paused answers `armed: false`; recheck refuses a device principal, another provider (`400`) and a seventh call in an hour; a recheck right before a restart still trials after it. Two machines: trials used up on B, a recheck on A clears B, and each machine applies it exactly once. A stalled first FCM device with a trigger for a later device during the stall: the later device gets one notification.
  - An FCM trigger sent at once while paused or keyless joins the fold and goes out after recovery; an APNs one is unchanged.
  - A stalled FCM exchange does not delay an APNs device in the same trigger, nor an APNs fold behind a stalled FCM fold in `tick()`; the FCM device fails at its 30-second deadline; two triggers during one exchange send once; a refused trial keeps its fold, and a trigger that arrives during it is merged into the fold rather than overwritten, with the due time recomputed; an APNs fold that comes due while an FCM pass is still running is sent on the next timer; a keyless agent's held FCM fold causes no writes per tick.
  - `ready` is false with push switched off, with no key, and while paused; a clear's answer has no `ready`.
  - The FCM pause report is `MobilePush.fcmCredentials` and names the recovery for its reason; an APNs pause still reports `MobilePush.apnsCredentials`.
  - An old iPhone record (no `pushProvider`) retried at the same revision with no `provider` is `ok`.
  - An unreadable `fcm_service_account_json` (bad PEM, bad `project_id`) is `no-key` with one report.
  - Status fields; no token or Google `message` text in status, `lastSend` or reports.
- Integration: an Android device registers an FCM token through the signed route, the answer has `ready`, and status shows `provider: fcm`; a posted attention item reaches the FCM transport double and an iPhone device in the same run reaches the APNs double; revoke clears an FCM token; a Bearer request is refused as before.
- E2E: production boot with no FCM key: the register route accepts an FCM token with `ready: false`, status reports `fcmConfigured: false`, nothing is sent. Production boot with an FCM key in the vault (test key, transport double): an attention item reaches the double.
- Migration: a marker-less CLAUDE.md with the exact old section gets the two-provider section; an edited old section is left alone with a `REVIEW:` line; running it twice leaves exactly one section.
- Site: the assetlinks route answers the JSON above with `application/json`; the pair page shows the new sentence.
