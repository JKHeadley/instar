# Convergence Report — Android app support on the agent (Firebase push, App Links, platform-neutral pairing page)

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (through the codex CLI) reviewed the spec in all six rounds, and every pass returned a result (none degraded). Gemini is installed but not signed in (`gemini-not-authed`), so the external review is single-family. The Anthropic clean-door reviewer (`claude-code:claude-fable-5`) was detected but not run. The internal reviewers ran as Claude subagents on the authoring session's model (Opus 5.5) in every round. The Standards-Conformance Gate ran in every round.

## ELI10 Overview

There is now an Android Instar app, and it already works for pairing and chatting. This spec covers the agent's side of three gaps. First, Android phones can now get notifications, through Google's free Firebase service, under the same rules the iPhone follows: the same events, the same limits, and no message text ever sent to Google. The phone fetches the text from the agent itself. Second, the instar.sh website publishes the small file Android needs so that a tapped pairing link opens the app instead of the browser. Third, the pairing page and the agent's own notes stop assuming everyone has an iPhone.

The main promise is that iPhones notice nothing. Their registrations, notifications, wording and limits stay byte-for-byte the same. A problem on the Google side only pauses Android, iPhones never wait behind a slow Android send, and undoing the change can't pause iPhones either.

The tradeoff: the published Android app's notifications belong to the operator's Firebase project, so other people's agents can't send to it yet. The iPhone app has the same limit today. Fixing it needs a relay, which is a separate design; the build opens a tracked item for it.

## Original vs Converged

- **Sending to Android at all.** The original said the FCM branch runs "after every existing re-check". Six reviewers and codex independently found that the existing check skips any device without an Apple "environment", so every Android phone would have been skipped, and that the credential lookup was Apple-only. The converged send path picks the provider first and looks up that provider's pause and key.
- **When a phone's registration is deleted.** Originally "a 400 naming the token" and `SENDER_ID_MISMATCH` cleared tokens. After review, a token is cleared only on Google's typed `UNREGISTERED` answer or a field violation on exactly `message.token`. A bug in our own message, a wrong key, or one mis-built phone can never wipe registrations. `SENDER_ID_MISMATCH` went through three designs (pause; then clear under a "proven" key; then neither). It now backs off only that phone for a day and never deletes anything, because nothing in the answer says which side is wrong, and a wrongly cleared Android token stays silent.
- **Pauses.** Originally any refused token exchange paused Android until someone changed the key. After review, a network blip or 5xx never pauses. Only Google refusing the key, the permission or the project does. A pause is kept in its own `pausedFcm` field, so a revert can't pause iPhones. Recovery is by reason and done by the agent itself (a new key, or switching the API or role back on), never handed to a person as a chore. Automatic trials back off and stop after six, and a new `POST /mobile/push/recheck` route, called by the agent after a fix, re-arms them on every machine.
- **Notifications are no longer lost while paused.** Review found that today's code drops a notification sent at once while paused. For Android it now joins the fold and goes out after recovery, and the fold is merged, never overwritten.
- **iPhones never wait.** APNs and FCM devices are sent as two lists side by side, in both the trigger path and the timer path, with a separate timer guard per provider and a 30-second deadline per Android device.
- **Parity fixes.** The 1-hour message lifetime and the collapse key were dropped, because APNs sets neither. Android text never says "Face ID", and approval notices go only to Android phones that can actually approve: active owner phones with a presence key.
- **The phone is told the truth.** The register answer gains `ready`, so the Android app can say "Notifications aren't set up on this agent yet" instead of showing them as on.
- **Narrow key, fixed endpoint.** Review asked for a dedicated service account holding only the FCM send role, a fixed token endpoint (the key file's `token_uri` is ignored), a single in-flight exchange, timeouts, and recording only Google's error code.
- **Work outside the repository is now part of done.** This covers the Firebase project in the operator's Google account, the app's Firebase config and `ready` handling, a dedicated commitment for the Play signing fingerprint, and a commitment for the relay.
- **Agent awareness.** The CLAUDE.md section is rewritten for both providers. A byte-exact swap protects hand-edited files, and the heading keeps its marker so no duplicate is added.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex, gate (5 flags) | 15 (deduplicated) | 6 | Provider-aware send path; structured FCM errors; exchange failure classes; no ttl/collapse_key; no Face ID; approval targeting; `ready`; `pausedFcm`; narrow service account; token grammar loosened; decision table with basis/evidence; §2.4 delivery limits; §2.6 external work; CLAUDE.md rewrite |
| 2 | combined (security/scalability/adversarial), integration, decision+lessons, codex, gate (9 flags) | 10 | 4 | `ready` includes the push switch; armed trial; FCM hold-while-paused; owner-phone approval test; own report name; byte-exact CLAUDE.md swap; operator account owns the Firebase project; agent-owned recovery; side-by-side provider lists |
| 3 | six-lens reviewer, codex, gate (3 flags) | 4 | 2 | `SENDER_ID_MISMATCH` never clears (per-device backoff); persisted trial fields; side-by-side lists in `tick()` too; reason-specific recovery; reservation before the first await; no writes while keyless |
| 4 | six-lens reviewer, codex, gate (3 flags) | 5 | 3 | Trials stop after 6; new recheck route; recheck fans out to peers; held fold goes as the trial; token-only answers clear a trial; per-provider tick guards; merged fold restore |
| 5 | six-lens reviewer, codex, gate (3 flags) | 3 | 2 | Key change or recheck clears mismatch backoffs; trial arming checked every tick; `forwarded` marker; eligibility re-read before reservation |
| 6 (cap) | six-lens reviewer (0 design), codex (2 design), gate (3 flags) | 1 applied, 1 accepted | 4 | Prune before each FCM send; one trial in flight; forwarded body schema |

Standards-Conformance Gate, per round: round 1 ran (5 flags); round 2 ran (9 flags); round 3 ran (3 flags); round 4 ran (3 flags); round 5 ran (3 flags); round 6 ran (3 flags). It was never degraded.

Externals: codex ran in every round, because the spec body changed between rounds, so nothing was delta-skipped. The codex round-4 pass read the text before the round-4 recheck edit. Rounds 5 and 6 read the text after it.

Model per round: the internal reviewers ran as Claude subagents (Opus 5.5) in all six rounds, and the external reviewer was GPT-6 Astra in all six.

## Proportion

Tier 2: the change touches a credential, a published app interface (the register answer, the assetlinks file) and every machine of the agent. The spec grew from 140 to 242 lines. Six rounds, at the cap. The design-finding count fell from 15 to 10, 4, 5, 3 and then 1. Rounds 3 to 5 mostly fixed problems introduced by the previous round's recovery logic (trials, recheck, fold merging), a sign that the pause-recovery design is the most intricate part to build and test.

## Left behind

- **APNs keeps today's drop-while-paused and plain fold restore.** The Android fix is not applied to APNs, because the spec must not change iPhone behavior. It is worth a small follow-up spec for APNs. (Queue: mobile-push follow-ups.)
- **Pruning before a send applies to FCM only.** APNs keeps today's prune points. Same follow-up.
- **Accepted at the cap (codex round 6): an approval folded into an aggregate is not re-checked at dispatch.** If an Android phone loses its owner presence key while a fold is held, the later aggregate still counts that approval. It is not a safety, security or data-loss issue. The aggregate carries only a count ("2 more things need you"), never approval text, and the approval itself still needs a presence-key signature.
- `mobileBrowserDevices.ts:143` says "Face ID on your phone". Android Phase 1 cannot approve browsers, so this goes with Android Phase 3.
- No pool view of `fcmConfigured`. Each machine's status and `ready` show it, and the §2.6 done test checks every machine of Echo's pool.
- **Gate advisory (every round, Judgment Within Floors):** the fixed limits (token bound, 10-second and 30-second deadlines, 20 in flight, 24-hour mismatch backoff, 1-hour cap, 6 trials, 6 rechecks an hour) are not adaptive. Each was contested by the reviewers. Each is inherited from APNs or carries a stated cost and a clearing path, so they are kept at operator scale.
- **Gate advisory (rounds 5 and 6, loop brakes):** ordinary sends that hit OAuth network errors are not retried on their own, and the per-device daily allowance (74) and the fold bound them. A breaker matters only at fleet scale.
- **Gate advisory (every round, Self-Hosting):** other people's agents can't push to the published app. This is the same as iPhone today. A commitment for the relay is part of done (§2.6).
- **Precision items from rounds 1–5 that were not worked in:** the test-list wording for timeouts at the 30-second deadline; a lessons note that FCM is server-to-Google HTTP, not an MCP tool; whether `data.badge` should be dropped, since the client ignores it.

## Full Findings Catalog

Round 1 (the codex pass, six internal lenses and the gate). Duplicates are merged; each item lists the reviewers that raised it.
1. DESIGN, high (codex, security, scalability, adversarial, integration, lessons): `send()` returns `skipped` without `pushEnvironment` (`MobilePush.ts:266`), and credentials are APNs-only (`AgentServer.ts:2174`). **Resolved:** the provider-aware send path, `fcmCredentials()`.
2. DESIGN, high (security, adversarial, lessons, decision): a `400 INVALID_ARGUMENT` "naming the token" would let a payload bug clear every token. **Resolved:** typed `errorCode` plus `fieldViolations[].field === "message.token"` only.
3. DESIGN, medium (adversarial): `SENDER_ID_MISMATCH` cleared tokens on a wrong key. **Resolved:** finally, per-device backoff and never clear (rounds 1–3).
4. DESIGN, high (codex, scalability, adversarial): a refused or failed exchange paused FCM forever. **Resolved:** network errors and 5xx are `failed`; only `invalid_grant`/`invalid_client` pause.
5. DESIGN, medium (security, scalability): the exchange had no timeout, no single-flight and no fixed URL. **Resolved.**
6. DESIGN, medium (scalability, decision, lessons): `ttl: 3600s` had no basis and broke APNs parity; the collapse key did too. **Resolved:** both dropped.
7. DESIGN, medium-high (codex, adversarial, lessons): the "Face ID" text was sent to Android, and approval notices went to phones that cannot approve. **Resolved:** per-provider text and presence-key targeting.
8. DESIGN, medium (adversarial, integration, lessons): `samePush`/`clearPush` ignored the provider. **Resolved.**
9. DESIGN, low (adversarial, integration): `paused` changing shape broke a revert. **Resolved:** a separate `pausedFcm`.
10. DESIGN, medium (security): the service account's permissions were unstated, and the data title was trusted. **Resolved:** a dedicated FCM-only account; data text is a placeholder.
11. DESIGN, medium (integration, lessons): other people's agents register successfully and then silently get nothing, and the relay had no owner. **Resolved:** `ready`, plus a relay commitment in §2.6.
12. DESIGN (decision): the decision-table rows had no basis/evidence. **Resolved.**
13. DESIGN (decision): the external Firebase/Play work had no route. **Resolved:** §2.6.
14. DESIGN (codex): the Android receiver contract was unspecified. **Resolved:** it was checked against the existing client (`InstarMessagingService.kt`: 15-second fetch, always posts) and documented in §1 and §2.4.
15. DESIGN (lessons): the degradation fallback text said "still in Telegram". **Resolved.**
Round 1 precision items (worked in briefly or left behind): the token grammar basis, the citations for the 10-second and 20-in-flight values, logging (token and Google message never stored), the intent filter staying on `/pair`, the CLAUDE.md migration bounds, SecretSync denylist plus dev-gate, per-surface posture lines, and the vault value type.

Round 2:
1. DESIGN (combined, integration): `ready` ignored the push switch. **Resolved.**
2. DESIGN (combined): the trial had nothing to ride on; `receive()` drops on `paused`. **Resolved:** an armed trial, and FCM hold-while-paused.
3. DESIGN (combined): approval targeting also needs an active owner phone. **Resolved:** `ownerPhoneCanApprove`.
4. DESIGN (combined): the FCM pause report would merge with APNs under the reporter's dedupe. **Resolved:** `MobilePush.fcmCredentials`.
5. DESIGN (combined, integration): a CLAUDE.md marker or duplicate, and clobbering hand edits. **Resolved:** the heading keeps its marker, and a byte-exact V1 swap.
6. DESIGN (decision+lessons, gate): the trial never stopped. **Resolved:** doubling, then a cap (round 4).
7. DESIGN (decision+lessons, gate): the pause report handed the operator a chore. **Resolved:** agent-owned recovery.
8. DESIGN (decision+lessons): which Google account owns the project was undecided. **Resolved:** the operator's (status quo, the same as the APNs key and the Play Console app).
9. DESIGN (codex): one phone could pause every Android device. **Resolved:** in round 3.
10. DESIGN (codex): sequential sends delayed iPhones. **Resolved:** side-by-side lists.
Round 2 precision items: the samePush normalisation, the null-clear order, the rollback wording, the persisted `pausedFcm`, the posture defences, the 404 project-not-found case, and the stale cached token on a `401`.

Round 3:
1. DESIGN (six-lens): one mis-built phone could switch Android push off for good. **Resolved:** the mismatch never pauses or clears.
2. DESIGN (six-lens): the trial state did not survive restarts. **Resolved:** persisted fields.
3. DESIGN (codex): `tick()` still serialised the providers. **Resolved.**
4. DESIGN (codex): recovery was not reason-specific, and the stop-after-6 rule contradicted "fixes itself". **Resolved:** reason-specific recovery (with the recheck added in round 4).
Also (gate, verify-state): `fcmKeyProven` could clear valid tokens. **Resolved:** removed. Precision items worked in: a refused trial keeps its fold, the reservation comes before the await, one tick at a time, and no disk writes while keyless.

Round 4:
1. DESIGN (six-lens): a recheck reached only one machine. **Resolved:** fan-out.
2. DESIGN (six-lens): a held fold could not carry the trial. **Resolved.**
3. DESIGN (six-lens): token-level answers counted as refused trials. **Resolved:** they clear the trial.
4. DESIGN (codex): a global tick guard let FCM block APNs. **Resolved:** a guard per provider.
5. DESIGN (codex): the fold restore overwrote new arrivals and kept a stale due time. **Resolved:** merge and recompute.
Also (gate): the daily trials never converged. **Resolved:** a cap of 6 plus recheck. Precision items: `nextTrialAt = now` on recheck, the schedule arithmetic, 400 for other providers, the per-process limit, and the token "logs" wording.

Round 5:
1. DESIGN (six-lens, codex): a fixed key left the mismatch backoffs for 24 hours. **Resolved:** cleared by a key change or a recheck.
2. DESIGN (codex): the recheck fan-out could loop. **Resolved:** `forwarded: true`.
3. DESIGN (codex): stale eligibility after an await. **Resolved:** re-read before the reservation.
Precision items: arming is checked every tick, the "clears at the next send" wording, posting is not proof the notification was shown, and backoff sends are allowance-bounded.

Round 6 (cap):
- Six-lens reviewer: 0 DESIGN. Precision items fixed in passing: one trial in flight (`nextTrialAt` null while in flight); the mismatch marker is `lastSend.outcome`. The reviewer also judged the three gate flags not worth building at operator scale.
- Codex: (1) DESIGN, stale rolling allowances in `tick()`. **Resolved:** prune before each FCM send. (2) DESIGN, folded approval eligibility. **Accepted at the cap** (see Left behind, with the reason). (3) PRECISION, the forwarded body schema. Fixed.

## Convergence verdict

Converged at round 6, the Tier-2 cap. The final round's six-lens internal reviewer found nothing that changes what gets built. Codex found two items: one was fixed in passing (one line), and one was accepted with a stated reason because it is not a safety, security or data-loss issue. The design-finding count fell from 15 to 1. `## Open questions` is empty. The spec is ready for Echo's review and approval.
