# Side-Effects Review — Native app conversations, increment 4 (Slack conversations from the app)

**Version / slug:** `mobile-native-conversations-inc4`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not run (--second-pass false, as instructed for this build)`
**Tier:** 2 (spec-driven; inbound dispatch and a signed-record format). Size: 11 source files (~520 added source lines, one new route module) + 3 new test files (~560 lines). No spec review round (the spec was already converged and approved); commit attempts recorded in the PR.

## Summary of the change

Increment 4 of docs/specs/mobile-native-conversations.md (§4.9 Slack, §4.10 allowlist), behind the existing boot-read `mobilePairing.native.enabled` gate.

- **List:** `GET /mobile/conversations` adds this machine's local Slack conversations (registry entries whose origin is not `replicated`): `{id: <negative durable id>, platform: "slack", title: label or "#<channel>" (+" (thread)"), lastActivity, lastPreview}`, merged on the same lossless cursor as app and Telegram rows (sort key `slack:<id>`). `?scope=pool` accepts peers' Slack rows (re-validated: negative safe integer). With `mobilePairing.slackOwnerUserId` unset the rows are withheld and the response says `slackOwnerUnset: true`.
- **History:** `GET /mobile/chat/slack/:id/messages` (device, or the agent's Bearer token) merges the tail of `slack-messages.jsonl` (newest 5000 lines within 8 MiB), the adapter's in-memory ring, and the app-sent messages kept in the app conversation store under the registry's canonical key. App-sent rows carry `originVerified` (and their delivery state); rows typed in Slack and agent replies read `none`. Pages backwards by `(at, eventId)`.
- **Send:** `POST /mobile/chat/slack/:id` follows §4.2: authenticate → look up (`MobileChatRequestStore`) → emergency stop skips the setting and rate limit → preflight (chat setting, 20/min, request-id age, `scanInbound`) → serving-lease check → token removal, credential signal → reserve → persist (fsync) with the signed origin and a **v2 receipt** → a copy in `slack-messages.jsonl` carrying the store `eventId` → stop/pause intercepts → the server's real Slack inbound dispatch with the operator as sender (`mobilePairing.slackOwnerUserId`, `threadline.ownerName`) and `appOrigin` → delivery event → mirror "📱 <owner> (from the app): <text with credential spans hidden>" → done. Boot recovery of an interrupted send is the existing `recoverStranded` (`op: send` with the canonical key).
- **v2 receipt:** a Slack send path names a machine-local alias, so the receipt also signs the canonical key (`instar-app-receipt-v2`, fields `v: 2`, `conversationKey`). `verifyRecordedOrigin` requires, for a `slack:` record, a POST to `/mobile/chat/slack/-N` and a v2 receipt naming the record's key; a v1 receipt, a different key, or a non-Slack path reads `failed`. Non-Slack records are verified exactly as before (a v2 receipt on them must also name their key).
- **Slack dispatch outcome:** `slackInboundDispatch` now returns `delivered | queued | refused` (previously `void`); the live and forwarded Slack paths ignore it. A message sent from the app gets ` (📱 signed)` (verified) or ` (📱 from the app)` appended to its tag by the server, after the sanitized name.
- **Agent replies in the Slack log:** `handleSlackReply` now writes the agent's reply to `slack-messages.jsonl` (Slack never echoes the bot's messages), so the app's Slack history shows both sides. Inbound Slack rows gain `threadTs` when they sit in a thread.
- **Config:** `mobilePairing.slackOwnerUserId` (optional, `U…`/`W…`). Never inferred.
- **Awareness:** CLAUDE.md section "Slack conversations from the Instar app" (template + `migrateClaudeMd`, sniffed by heading); CapabilityIndex lists the two routes.

## Decision-point inventory

- Slack send preflight — add — invariant: the same content-free checks as the app/Telegram send routes; only exact authority tokens are removed; credential-shaped text is a signal.
- Owner identity — add — invariant: a config field (`slackOwnerUserId`) that must also be an authorized user on the Slack adapter; never inferred from content.
- Serving-lease check — add — invariant (as the Telegram chat route): refused before anything is saved.
- Origin verdict for Slack records — modify — invariant cryptographic checks (v2 receipt).

---

## 1. Over-block

- A machine that does not hold the serving lease answers `409 not-serving` before saving, as the Telegram route does; with the session pool on, a Slack conversation owned by another machine is still sent through this machine's dispatch only if this machine holds the lease (the dispatch then re-checks ownership through `SpawnAdmission`). No message is lost: nothing is saved on a refusal and the app keeps the text.
- `slackOwnerUserId` unset or not an authorized Slack user ⇒ 503 with a plain reason. Intentional (spec: never inferred).
- A thread conversation's history shows only rows that say they are in that thread; Slack log rows written before this change have no thread field, so older thread replies are not shown in a thread view (they still appear nowhere else either; Slack itself keeps them).

---

## 2. Under-block

- History reads a bounded tail of `slack-messages.jsonl`; messages older than the newest 5000 lines are not reachable from the app (app-sent messages are, from the store, never rotated). Slack keeps its own full history.
- **Slack ids are local to one machine (review fix).** Every Slack list row names the machine that serves it (`machine`), a pool list never includes another machine's Slack rows (a peer row with the same number would otherwise collapse onto this machine's row, or name a different conversation), and both Slack routes require the row's machine (`?machine=` on the read, `machine` in the signed send body): another machine answers 409 `wrong-machine` (with `servedBy`), none answers 400 `machine-required`, before anything is read, saved or sent. A Slack conversation is therefore only reachable through the machine that lists it; with several machines that is the one the phone is paired to.
- Verification of a Slack record is relative to the canonical key: a workspace id that was `_` on one machine and `T…` on another yields two keys (two store files) for one channel; each record still verifies under its own key.

---

## 3. Level-of-abstraction fit

Reuses the app conversation service (request store, store, verify, delivery events, boot recovery), `buildSignedOrigin`, the registry's canonical key, and the server's own Slack inbound dispatch (the same function the live and mesh-forwarded Slack paths run), so a message from the app gets the same session lookup, spawn admission, context and relay instructions as a Slack message. The bridge is a thin adapter over SlackAdapter with an interface small enough to stub in tests.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no brittle block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

No content check refuses a message. The added refusals are structural (feature setting, rate, request-id age, lease, configured owner identity); credential-shaped text only adds `credentialShaped: true` and is hidden in the mirror copy, never refused.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new judgment point. Credential-shape detection is the existing `detectOutboundCredential` signal (the spec's decision table classifies it as a judgment candidate whose floor never refuses).

---

## 5. Interactions

- **Slack log readers:** PresenceProxy's Slack log check and the Slack compaction-resume path now also see the agent's own replies in `slack-messages.jsonl`. Both look for "did the agent answer after the user's last message"; seeing the reply is the correct answer (previously they only learned it through `onMessageLogged`). `slack-cli` search shows the replies too.
- **slackInboundDispatch** return type change: callers `await`/`void` it and ignore the value; tsc and the Slack wiring tests pass.
- **Tag:** the app mark is appended inside the bracket after `(uid:U…)`; the existing tag parser in sessions only reads `[slack:<channel>`.
- **Mirror loop:** the mirror is posted by the bot; Slack does not deliver bot messages back as inbound, so it cannot re-enter dispatch.
- **Emergency stop:** an app stop into Slack kills every running session, exactly what a Slack "emergency stop" does.

---

## 6. External surfaces

Two new device routes (allowlisted for active devices: `POST /mobile/chat/slack/-N`, `GET /mobile/chat/slack/-N/messages`, both requiring the list row's `machine`), Slack rows in the conversation list, a new optional config field, a new receipt version in stored records (replicated; an older machine reading a v2 Slack record cannot verify it and reads `failed` for a Slack path — such records only exist once this version runs), a new message posted into Slack (the mirror) on each app send, and agent replies added to the Slack log. CLAUDE.md gains a section on update.

- **iOS app:** must list `platform: "slack"` rows, send to `/mobile/chat/slack/<id>` with the row's `machine` in the body and read `/mobile/chat/slack/<id>/messages?machine=<row machine>`, show `slackOwnerUnset` as a plain hint, and show marks from `originVerified` (increment 5).
- **Operator surface:** setting the owner id is done by the agent after the operator's yes in conversation (no PIN, no file editing by the operator).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- App-sent Slack messages: **replicated** in the app conversation store under the canonical Slack key (the existing `appConversations` replicated kind); the v2 receipt makes them checkable on any machine.
- Slack rows in the list and Slack history: **machine-local BY DESIGN** (a Slack conversation id is minted per machine): the list carries only this machine's Slack rows even with `?scope=pool`, and the routes refuse any other machine's id.
- Sending: on the serving-lease holder (where Slack inbound is dispatched).

---

## 8. Rollback cost

Switch `mobilePairing.native.enabled` off: the Slack routes answer 503 and the list has no Slack rows (the conversation service is not built). Unsetting `slackOwnerUserId` hides Slack alone. Reverting the PR leaves stored Slack records with v2 receipts that an older version reads as `failed`/unknown (display only) and extra agent-reply rows in `slack-messages.jsonl` (harmless log rows). No data migration.

---

## Class-Closure Declaration (display-only mirror)

Not applicable: no agent-authored-artifact defect. The mirror post fires once per operator app send (an external event), never on a timer or its own output.

---

## Second-pass review

Not run for this build (`--second-pass false`, per the build instructions). The PR is the review surface.

Review follow-up (Slack ids are per machine): independent reviewer — Concur with the review. The machine check runs before any read or send in both routes; the query is inside the signed path and the body field inside the body hash; the agent read works with ?machine=; pool lists drop peers' Slack rows; the CLAUDE.md text matches (it now names the 400 too).
