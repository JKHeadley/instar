# Side-Effects Review — Android app support on the agent (Firebase push, App Links, platform-neutral pairing page)

**Version / slug:** `mobile-android-app`
**Date:** `2026-11-14`
**Author:** `echo (builder session)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (credential, a published app interface, every machine of the agent), driven by the converged and approved spec `docs/specs/mobile-android-app.md` (6 review rounds, at the cap). Android phones can now register for and receive notifications through Firebase Cloud Messaging, with every rule iPhone push already has. Files: `src/core/MobilePush.ts` (FCM transport, OAuth exchange, provider-aware send path, `pausedFcm`, trials, recheck, `ready`, status fields, side-by-side provider lists), `src/core/MobileDeviceKeys.ts` (`pushProvider` on the device record and in `samePush`/`clearPush`), `src/server/mobilePairingRoutes.ts` (`provider` on `POST /mobile/device/push`, `ready` in its answer, new `POST /mobile/push/recheck`), `src/server/AgentServer.ts` (vault key `fcm_service_account_json`, approval-capable test, fallback wording), `src/server/CapabilityIndex.ts`, `src/core/PostUpdateMigrator.ts` (two-provider CLAUDE.md section with a byte-exact V1 swap), `src/testing/selfActionRegistry.ts` (the trial loop registered), `site/src/pages/.well-known/assetlinks.json.ts` (new), `site/src/pages/pair.astro` (one sentence). Size: about 10 source files and 6 test files. Effort: 6 spec rounds; the build itself had 1 design fix found by its own tests (a key change must be noticed before a backoff is read).

## Decision-point inventory

- FCM token accepted (register route) — add — local size and storage floor `^[\x21-\x7e]{32,4096}$`; invariant.
- Which transport sends — add — `pushProvider ?? 'apns'`; invariant over a closed set.
- FCM answer → clear token / failed / backoff / mismatch backoff / pause — add — read only from the typed `FcmError.errorCode` and a `BadRequest` violation on exactly `message.token`; invariant.
- FCM pause lifted — add — a changed key hash (checked every 30 minutes) or a trial answered `200`/`UNREGISTERED`/token violation/`429`; at most 6 automatic trials.
- Approval notice to an FCM device — add — only when `canApprove` (presence key + active owner phone).
- APNs send path, APNs pause, APNs payload — pass-through, unchanged.

---

## 1. Over-block

- An FCM token outside 32–4096 printable ASCII characters is refused with `400 bad-token`. Real tokens are about 150–165 characters of `[A-Za-z0-9_:-]`, so no known real token is refused; a refusal is visible to the app.
- An FCM registration with an `environment` field is refused (`400 bad-environment`). The Android client sends none.
- An Android phone with no presence key gets no approval notices. That is intended: it cannot approve. Phase 1 Android registers no presence key, so it gets no approval notices until Phase 3.
- `SENDER_ID_MISMATCH` backs a phone off for 24 hours. A phone whose app build was briefly wrong and was then reinstalled with the right build keeps a stale backoff until its token changes (which re-registers it and does not clear the backoff) or until a key change or a recheck clears it. Bounded: at most one day.

## 2. Under-block

- A data message Google accepted (`200`) may still never be shown (force-stopped app, notification permission revoked). The agent cannot see that; status says "accepted by Google", never "delivered" (spec §2.4).
- Accepted at the cap (convergence report): an approval folded into an aggregate is not re-checked at dispatch, so an Android phone that lost its presence key while a fold was held still has that approval counted in "N more things need you". The aggregate carries a count only, and approving still needs a presence-key signature.
- An FCM send over the 20-in-flight limit is lost without retry, as for APNs.

## 3. Level-of-abstraction fit

FCM is a second output channel inside the existing `MobilePushService`; triggering, fan-out, folding, allowances, dedupe and the notification read token stay where they were and are shared. The provider choice lives on the device record, set only by that device's own signed registration. No new gate, no new config key. The pause, trial and recheck mirror the existing APNs pause but are kept in a separate `pausedFcm` field so neither provider can stop the other.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over agent behavior or messages.

Google's typed answers decide only what happens to one send, one token and the FCM provider's pause. The approval-notice filter is a deterministic test of whether the phone can answer (presence key + active owner), the same test the agent already uses. Nothing here gates information flow based on brittle content matching; no Google `message` text is ever read as a verdict.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Each rule is an invariant over a closed external domain (the FCM v1 `errorCode` enum, the `apns`/`fcm` provider set) or a safety guard on an irreversible action (a token is cleared only on Google's typed "this token is gone" answers, because a wrongly cleared Android token stays silent). The fixed numbers (10 s and 30 s deadlines, 20 in flight, 24 h mismatch backoff, 1 h backoff cap, 6 trials) are declared and justified in the spec's `## Decision points touched` table and convergence report.

---

## 5. Interactions

- **Shadowing:** the APNs path runs exactly as before inside its own list. FCM devices are sorted out before either list runs, so an FCM record never reaches the APNs `send()` (which would skip it anyway: no environment).
- **Double-fire:** one device is in exactly one list. Within the FCM list, each device's eligibility is re-read and its reservation (`sendLog`, `lastSendAt`, `save()`) taken synchronously before the first await, so two triggers during one token exchange send once (tested). The token exchange is single-flight per credential hash.
- **Races:** `tick()` now keeps one guard per provider. An unfinished FCM pass never holds back an APNs fold (tested); the APNs guard is new but APNs ticks were already safe (the fold is taken before the await). Folds kept after an await are merged, never assigned, and the due time is recomputed (tested).
- **Feedback loops:** the FCM trial is a self-triggered retry. It settles: 30 min × 2^k, at most 6, then none; registered as `fcm-pause-trial-retry` in `src/testing/selfActionRegistry.ts` and proven by `tests/unit/self-action-convergence.test.ts`. Recheck is a Bearer call from the agent, limited to 6 an hour per process; forwarded rechecks are never forwarded again (tested with two machines pointing at each other).
- **DegradationReporter:** the FCM pause report has its own feature name `MobilePush.fcmCredentials`, separate from `MobilePush.apnsCredentials`, so the reporter's dedupe never merges them. An unreadable key is `MobilePush.fcmKey`; a bad FCM request is `MobilePush.fcmSend`.

## 6. External surfaces

- **Phone app contract:** `POST /mobile/device/push` accepts optional `provider: "apns" | "fcm"` (absent ⇒ apns); FCM takes `token` (32–4096 printable ASCII) and no `environment`; the answer to a token-setting registration gains `ready: boolean`. A clear (`token: null`) accepts any provider value and its answer has no `ready`. The iPhone app ignores unknown fields.
- **Status:** `GET /mobile/push` adds `fcmConfigured`, `pausedReasons: { apns, fcm }`, `fcmTrials` (only while paused) and per-device `provider`; `environment` is null for FCM rows. `keyConfigured` and `pausedReason` keep meaning APNs. No token or Google message text appears anywhere (tested).
- **New route:** `POST /mobile/push/recheck` (Bearer; `{ provider: "fcm", forwarded?: true }`; answers `{ machines: [{ machine, armed, reason? }], unreachable }`).
- **External systems:** `https://oauth2.googleapis.com/token` (fixed; the key file's `token_uri` is ignored) and `https://fcm.googleapis.com/v1/projects/<projectId>/messages:send`. Google sees only the token, the agent name, a generic body and the `instar` block (ids only), the same as Apple.
- **instar.sh:** `/.well-known/assetlinks.json` is new; the pair page wording names both phones.
- **Persistent state:** `mobile-devices.json` gains `pushProvider`; `mobile-push-state.json` gains `pausedFcm` and `fcmKeyHash`.
- **Operator surface:** no operator-facing action is added. Recovery from an FCM pause is the agent's own job (new key, or switching the API/role back on in the Firebase project through the operator's browser profile, then recheck); the only operator step is a Google second-factor prompt, sent as one phone-completable approval (spec §2.6).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard, approval page or grant/revoke form is touched. The pair page change is one public sentence on instar.sh.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **machine-local BY DESIGN** for the FCM token and `pushProvider` on the device record (only the machine holding the record verifies that phone's signed registration and revocation), `pausedFcm`/`fcmKeyHash` in `mobile-push-state.json` (Google's answer to this machine's copy of the key; a unified pause would let one bad copy stop good ones), and the access token (process memory only).
- **replicated:** `fcm_service_account_json` reaches the operator's other machines through the existing secret sync (dev-gated `multiMachine.secretSync.enabled`); a machine without it reports `fcmConfigured: false` and answers `ready: false`.
- **Triggers** fan out between machines exactly as before; the recheck fans out once to every online machine with `forwarded: true`.
- **Notices:** no new user-facing notice; degradation reports are per machine, as for APNs.
- **Status surfaces:** `GET /mobile/push` is this machine's reading (as before); `POST /mobile/push/recheck` answers per machine and names unreachable machines.

## 8. Rollback cost

Remove `fcm_service_account_json` from the vault: FCM stops at the next send; iPhones unaffected. `mobilePairing.push.enabled: false` stops all push. Reverting the PR: the old code skips FCM records (no environment), reads `paused` as before and drops `pausedFcm`/`fcmKeyHash` at its next save, and ignores `pushProvider` on records, so nothing wrong is sent and iPhones are never paused. The CLAUDE.md section stays in its two-provider wording after a revert (harmless text). Removing the assetlinks route returns Android links to the browser page.

---

## Conclusion

The build follows the converged spec point by point. The second-pass review found four more gaps, all fixed (see below). One design gap was found by the tests and fixed: a key change was only noticed inside a send, so a phone in `sender-id-mismatch` backoff kept folding; the key is now checked at the start of each FCM pass, before any backoff is read. iPhone behavior is byte-identical (APNs payload snapshot tests, the existing APNs test file unchanged and passing). Clear to ship after the second-pass review. Work outside this repository (Firebase project, service account, app-side `ready` handling) is Echo's per spec §2.6; the Play signing fingerprint and the relay are tracked as CMT-1764 and CMT-1765.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (Opus 5.5), given the spec, the diff and this artifact, not the builder's conclusions
**Independent read of the artifact:** concern raised, then resolved

The reviewer confirmed the send path, the separate `pausedFcm`, the token-clear rule, the mismatch and trial rules, fold merging, the reservation before the first await, side-by-side lists, recheck, `ready`, no token or Google text leaks, the byte-identical APNs payload and the revert behavior. It raised four concerns, all fixed in this change with tests:
- A refused trial answered `SENDER_ID_MISMATCH` could raise the mismatch report (the spec says a refused trial raises no new report). Fixed: the mismatch report runs only for non-trial sends.
- A send already in flight when another device paused FCM could replace that pause and send a second report; one accepted by Google with the same key left the pause up until the next trial. Fixed: a pause is created only when none exists, and a non-trial send accepted with the paused key's hash clears the pause at once.
- A refused trial kept the original reason unless the answer was itself a pause reason. Fixed: the latest reason is recorded (an enum or our own label: `sender-id-mismatch`, `unavailable`, `failed`).
- A peer answering `429` to a forwarded recheck was listed as unreachable. Fixed: it is listed as `{ armed: false, reason: "rate-limited" }`.

After the fixes the review's conclusions and this artifact agree; reviewer concurrence is recorded on that basis.

---

## Evidence pointers

- Unit: `tests/unit/mobile-push-fcm.test.ts`, `tests/unit/mobile-push.test.ts` (unchanged, APNs regression), `tests/unit/PostUpdateMigrator-mobilePushAndroidSection.test.ts`, `tests/unit/site-android-app-links.test.ts`, `tests/unit/self-action-convergence.test.ts` (new controller).
- Integration: `tests/integration/mobile-push-routes.test.ts` (FCM registration, `ready`, both doubles in one run, revoke, recheck route, two-machine recheck).
- E2E: `tests/e2e/mobile-android-push-alive.test.ts` (production boot with and without a vault key).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `guard`
- **`guardEvidence`:** `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (controller fcm-pause-trial-retry in src/testing/selfActionRegistry.ts), howCaught: under a cause that never clears, trial k waits 30 min × 2^(k−1) and no trial runs after 6 (nextFcmTrialAt returns null), so the action count settles at 6 whatever the horizon; the only re-arm is the agent's Bearer recheck, limited to 6 an hour per process and never re-forwarded }`
