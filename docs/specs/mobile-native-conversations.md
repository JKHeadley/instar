---
title: "Native app conversations — an Instar agent the iPhone app can talk to without Telegram"
slug: "mobile-native-conversations"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-native-conversations.eli16.md"
status: "draft"
review-convergence: "2026-11-01T05:37:52.804Z"
review-iterations: 6
review-completed-at: "2026-11-01T05:37:52.804Z"
review-report: "docs/specs/reports/mobile-native-conversations-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: false
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched)"
---

## 1. Problem

Operator direction, 2026-10-31 21:59 PDT (topic 134088): "an Instar agent should not require telegram. It should support native app conversations similar to telegram, but the app should also allow the user to continue slack and telegram chats from within the app."

Operator direction, 2026-10-31 22:01 PDT: "the messages sent here from the app should have a special signature indicating they are from me/the app when they are recorded".

Today the app's chat (docs/specs/mobile-operator-chat.md) rides entirely on Telegram: a conversation is a Telegram topic, the agent's reply leaves through Telegram and the app reads it back from Telegram history, the pairing code is delivered in the bot's private chat (docs/specs/mobile-device-keys.md), and without a Telegram owner the chat route answers 503. An agent with only the app, or with Slack only, cannot be reached from the app. A stored app message carries `via: "mobile-device"` and `deviceId`, labels the server writes and nothing proves.

## 2. Goals

1. **Native conversations.** On any agent, the app can start, list, read and write conversations stored by Instar itself, with no messaging service configured.
2. **Continue existing chats.** Where Telegram or Slack is configured, the app lists those conversations beside the native ones and can read and write them.
3. **No Telegram on the app's path.** Pairing confirmation, the owner's identity, push triggers and replies work without Telegram.
4. **Signed records.** Every message the app sends is stored with the phone's own signature and the exact bytes it covers, so it can be checked again later against the agent's list of paired phone keys. The proof is the check's verdict (`originVerified`) in the app's history responses. A "📱" label in a Telegram or Slack copy is only a label, never proof (4.6).

## 3. What exists (code survey, 2026-10-31)

- `ConversationRegistry` (src/core/ConversationRegistry.ts) mints durable negative ids, but it is Slack-shaped throughout: `tupleForRoutingKey` accepts only Slack channel ids, `canonicalKeyFor` always yields `slack:<team>:…`, and `applyJournalRecord` hard-codes `platform: 'slack'` when replaying a `mint` record. Entry replication between machines is designed but not built (the file header defers it to later increments; nothing writes `origin: 'replicated'` today), and older versions skip unknown journal ops. `ConversationEntry` is Slack-shaped (`channelId`/`threadTs` always present). Speculative inbound mints (`mintForInbound`) are throttled; deliberate ones use `mintForDurableBinding`. Entries carry a `label`.
- Slack inbound runs `slackInboundDispatch` in src/commands/server.ts (defined only when Slack is configured): pick the session from `SessionChannelRegistry`, inject or spawn (`SpawnAdmission`, `spawnInteractiveSession` with `bootstrapConversationIds`), tag `[slack:<channel> from <Name> (uid:<U…>)]`, with history read from the Slack API.
- A Slack session replies with `slack-reply.sh`: in session mode (`INSTAR_CONVERSATION_ID` negative) it posts `{conversationId, text}` to `POST /slack/session-reply`, checked by `verifyConversationBind` (its `attention` argument is already optional) and then `handleSlackReply` (credential wall, tone gate, duplicate suppression). The route refuses entries whose origin is not local.
- `MessageLogger` writes per-platform JSONL logs and rotates them (cut to 75,000 lines past 20 MB and 100,000 lines). For Telegram and Slack the log is a backup copy of a service that keeps its own history.
- Device requests are rate limited at authentication (`deviceRateOk`, 120 per minute per device, in the device authenticator), before any route runs. `POST /mobile/chat/:topicId` refuses on a machine that does not hold the serving lease (`409 not-serving`) and runs, before recording anything: the chat setting, the per-device rate limit, the leaked-pairing-code scan (`scanInbound`), refusal of `tlinv1:` invites and `/desktop` codes, refusal of credential-shaped text, the request-id age check, and the emergency-stop and pause intercepts. Its idempotency is the `MobileChatRequestStore` contract of mobile-operator-chat.md §2.4 (`entered`/`done`/`outcome-unknown`, keyed on a time-carrying `requestId`).
- Every device request is signed (`MobileDeviceKeys.canonicalString`): version, device id, host, method, path with query, time, SHA-256 of the raw body, under the phone's P-256 Secure Enclave key, ±60 s, with a replay guard. Device records are machine-local and bound to the paired hostname (mobile-device-keys.md §4); revoked records are pruned past `MAX_TOMBSTONES` (200).
- Telegram-only pieces on the app path: owner DM for the pairing code, `MobilePushService` built only with Telegram and triggered by `telegram.onHubPost`, the chat route, the owner identity (`TelegramAdapter.getOwnerUserId()`), and the device allowlist (only `/telegram/topics*` reads; chat matched by `/^\/mobile\/chat\/\d+$/`).

## 4. Design

### 4.1 A native "app" conversation

- **Identity.** An app conversation is named by a random UUID chosen at creation, its `conversationKey`: the bare lowercase RFC 4122 UUID (pattern `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`), which is what every route, response, signed path and stored record carries.
- **The conversation store is the source of truth for conversations, not the registry.** Creation, renames and deletion are events in the conversation's own file (4.5): `{kind: "created", title, at, machineId}`, `{kind: "label", title, setAt, machineId}`, `{kind: "tombstone", at, machineId}`. They replicate with the store (4.8). The shown title is the `label` (or `created`) event with the latest time, ties broken by `machineId`, so every machine agrees.
- **The registry only gives each machine a local alias.** Each machine mints its own negative numeric id for an app conversation it sees in the store (registry key `app:<uuid>`, via `mintForDurableBinding`, not the throttled inbound mint), for session environments and durable consumers (commitments, notices, follow-through). Nothing signed or replicated carries that alias. Registry changes: a new `'app'` variant of `ConversationTuple` and `ConversationDescriptor` with its own key parser, `channelId`/`threadTs` made optional on `ConversationEntry` for that variant, and a new journal op `mint-app`, so an older version replaying the journal skips it instead of loading a fake Slack entry (the registry's existing unknown-op handling then pauses snapshot writes and raises one attention item, which this spec relies on and tests). With `conversationIdentity.recording.enabled: false` the alias cannot be minted; create then answers `503 {error: "conversation-recording-disabled"}` in plain words and the request is recorded `not-delivered`.
- **Routes** (device-signed): `POST /mobile/conversations` `{title, requestId}` creates one and returns `{conversationKey, title}`; `PATCH /mobile/conversations/:conversationKey` `{title, requestId}` renames; `DELETE /mobile/conversations/:conversationKey` `{requestId}` deletes (4.5). `GET /mobile/conversations?cursor=&limit=` lists app conversations plus, when configured, Telegram topics and Slack conversations, each row `{id, platform, title, lastActivity, lastPreview}`, newest first, at most 200 per page. Rows for an unconfigured platform are absent, never an error.
- **Idempotent mutations.** Each goes through `MobileChatRequestStore` keyed on `(deviceId, requestId)` with an operation-specific payload hash: `create|<cleaned title>`, `rename|<key>|<cleaned title>`, `delete|<key>`; a different payload under the same `requestId` is `409 payload-conflict`. For create, the new UUID is chosen and written into the reservation **before** the store or registry is touched. Each event's `eventId` is derived from `(deviceId, requestId)`, so a repeated write after a crash is the same event and merges away. Recovery of an interrupted mutation re-applies its event from the reservation and then records `done`, so a create that crashed midway returns the same conversation, never a second one.
- **Titles are untrusted text.** On create and rename the title is cleaned exactly as Slack sender names are (control characters, `"`, `[`, `]`, `(`, `)` stripped, whitespace collapsed), then checked for 1–80 characters. Everywhere it is shown to a session it sits inside quotes in a fixed position, and any "📱 signed" text is appended by the server after it, never derived from it.

### 4.2 Sending from the app into a native conversation

`POST /mobile/chat/app/:conversationKey` `{text, requestId}` (device-signed, 1–4000 characters). The steps keep the order mobile-operator-chat.md §2.4 fixes, and its response contract (including the answer to a concurrent retry) is inherited unchanged:

1. **Authenticate** the device signature. For the send routes (Telegram, app, Slack) the authentication-time device rate limit is not applied; sends have their own limit in step 3 (the existing 20 per minute), so the app's read polling can never use up the allowance an emergency stop needs.
2. **Look up** `(deviceId, requestId)` in `MobileChatRequestStore`. A known request answers its recorded result (or the inherited in-progress answer) and nothing below runs, so a retry of a request that already succeeded is never refused by a later check and never repeats an emergency stop.
2a. **Emergency stop first.** An exact-match emergency stop skips the feature setting and the rate limit, so it is never turned away. It is still atomically reserved (`entered`) before it executes and recorded as the request's result after; a stop interrupted by a crash answers `409 outcome-unknown` like any other request, and two concurrent copies cannot both execute because only one wins the reservation.
3. **Preflight with no conversation or session effects** (its one effect: `scanInbound` declining a pending pairing whose code appears in the text, as in mobile-operator-chat.md §2.4), shared by all three send routes (Telegram, app, Slack): the feature setting, the per-device rate limit, the `requestId` age check, and `scanInbound` (a live pending pairing code in the text declines that pairing). The key must name an app conversation (else 404). None of these can refuse a message because of what it says.
   - **Exact tokens are removed, everything else is delivered.** A pairing invite (`tlinv1:` token) and a remote desktop code are exact-format tokens that would hand an authority to the session; the server replaces each with `[pairing invite removed]` / `[desktop code removed]` (an exact match, so structure decides alone) and delivers the rest, answering with `redacted: true` and the kinds removed. The message is never refused for its content.
   - **Credential-shaped text is the operator's call, not the server's.** The server does not alter or refuse it. Before sending, the app runs the same credential-shape check locally and, on a match, asks: "This looks like a password or key. If you send it, it is saved in this conversation's history on every machine of this agent, in plain text. Send it through a Secret Drop link instead, or send as written?" The operator decides. The server's own check only adds `credentialShaped: true` to the response and the audit, as a signal. Pairing invites typed into the app are not delivered to the session at all (above); to pair agents the operator forwards the invite through Telegram or pastes it on the dashboard, as today.
4. **Atomic reservation** (`entered`), then **persist the message** to the conversation store with its signed `origin` and `receipt` (4.6) as a durable commit: the line is written, the file is `fsync`ed, and on first creation the directory is `fsync`ed too, before anything is dispatched. From here the message and its proof survive a process or host crash. The operator message's `eventId` is `sha256(deviceId, requestId)`, so a repeated persist after a crash writes the same event, which merges away.
5. **Pause intercept**, then **dispatch** to `appInboundDispatch` on the owning machine (4.8); this replaces the chat route's `409 not-serving` refusal with a forward. `appInboundDispatch` finds the conversation's session in a `SessionChannelRegistry`, injects when live, otherwise admits through `SpawnAdmission` and spawns with `INSTAR_CONVERSATION_ID=<local alias>` and a bind token. The tag is `[app:<alias> "<title>" from <owner name> (📱 signed)]`, with "📱 signed" only when 4.6 returns `verified`. Context history comes from the conversation store (4.5).
6. Append a delivery event (`{kind: "delivery", eventId, messageId, state: "delivered" | "refused" | "intercepted"}`) and record the request `done`.
7. **Lookups read the current state.** A later lookup of a request recorded `done` or `outcome-unknown` answers from the message's delivery state reduced at that moment (4.5), so a forwarded message whose `delivered` event arrives late stops reading `unknown`.
8. **Boot recovery**, for `entered` requests older than 5 minutes: if the message row is missing, the message was never dispatched (persist precedes dispatch), so the request is recorded `not-delivered` and a retry answers that, letting the app resend with a new `requestId`; if the message row exists with no delivery event, an `unknown` delivery event is appended and the request answers `409 outcome-unknown`; it is never re-dispatched blind.

`appInboundDispatch` and the session-reply route are built outside the Slack-configured block, so they exist on an agent with no Slack and no Telegram. The owner name comes from `threadline.ownerName`, falling back to "Operator".

### 4.3 The agent's reply

- New script `.instar/scripts/app-reply.sh` (template `src/templates/scripts/app-reply.sh`), the same shape as `slack-reply.sh` session mode: `POST /app/session-reply` `{conversationId, text}` (the local alias) with `X-Instar-Bind-Token`, checked by `verifyConversationBind`. The route accepts only those two fields, refuses unless this machine currently owns the conversation and holds its `bind-app` binding (`409 not-owner`, 4.8), and runs the same outbound pipeline as `handleSlackReply`: the credential wall, the tone gate with its advisory 422 answers, and duplicate suppression. It then appends the reply to the conversation store and queues a push (4.7).
- **Installed in all four places `slack-reply.sh` is:** `init.ts`, `PostUpdateMigrator.migrateScripts` (always overwritten), a boot-time relay installer beside `SlackReplyRelayInstaller`, and the template version-history list `TemplatesDriftVerifier` checks.
- **New route prefix** `/app/` (for `/app/session-reply`) is listed for the capabilities and route-prefix preflight.
- **Slack owner id.** The agent awareness text tells the agent to propose `mobilePairing.slackOwnerUserId` from the Slack channel's verified operator binding and set it after the operator says yes; it is never inferred silently.
- **Agent awareness** (`generateClaudeMd()` plus a `migrateClaudeMd()` section guarded by a content sniff for its heading): a message tagged `[app:N …]` is answered with `app-reply.sh`; the agent can list conversations and read history with `?scope=pool`; when asked "did my app message arrive / is it really from me?" it reads `originVerified`, never the text. A session spawned before the update has no such instruction; its first app message carries the reply instruction in the injected context, as Slack's does.
- **No text guard on imitation.** The agent could write a message that looks like the mirror label "📱 <owner name> (from the app): …". That is harmless by design: no surface treats that text as proof (Goal 4), and the app's mark comes only from `originVerified`. A text matcher with authority to refuse such messages would add a brittle gate without adding safety, so none is added.

### 4.4 Pairing without Telegram

The confirmation code proves the phone's holder can read something only the operator should see. Two paths, chosen by configuration:

- **Telegram owner present:** unchanged (private chat with the bot); the key is recorded `approvedVia: "telegram-dm"`.
- **Otherwise, dashboard:** redeem answers at once with `{status: "pending", approval: "dashboard"}`, since there is no DM to wait for. The server keeps the code's HMAC as today and, for the pending device's life (15 minutes), the plaintext in process memory only, never on disk. The dashboard's Devices card shows a pending device's fingerprint and its code only to an operator session (a fresh PIN unlock, `X-Instar-Operator-Session`); no Bearer route and no device route returns it. A restart loses it, as it voids the HMAC key today: the device expires and the operator pairs again. Confirm is unchanged (3 distinct wrong codes, the 24-hour guessing budget). The key is recorded `approvedVia: "dashboard-pin"`.
- **Which machine:** the one holding the pending record, which serves the paired hostname (device records are machine-local). The serving-lease rule and `approval-moved` exist because the Telegram path's code travels through the lease holder's adapter; the dashboard path has no such dependency, so it needs no lease, and a lease move does not expire a dashboard-path device.
- **What each path proves, stated plainly:** `telegram-dm` proves the holder can read the owner's private Telegram chat; `dashboard-pin` proves the holder unlocked the dashboard with the PIN. Neither holds against a process running as the agent's OS user, which can read the PIN in config and the bot token; that is the boundary mobile-device-keys.md §2.2 already states. The app shows a dashboard-approved phone's messages as "📱 signed (approved on dashboard)".
- A dashboard PIN is always generated, so "no Telegram owner and no PIN" does not occur; `approval-unavailable` remains only for a failed Telegram DM.

### 4.5 The app conversation store

- One append-only file per conversation, `<stateDir>/app-conversations/<sha256 of the canonical key>.jsonl`, never rotated, where the canonical key is `app:<uuid>`, `telegram:<topicId>` or the registry's canonical Slack key (`slack:<team>:<channel>[:<thread>]`, from `canonicalKeyFor`), so every machine names the same conversation's file the same way: for a native conversation this is the only copy. Every row is an immutable event with its own `eventId` (a UUID, except the operator-message rule in 4.2): a message event `{kind: "message", eventId, messageId, conversationKey, role: "operator" | "agent", text, at, machineId, origin?, receivedAt?, receipt?}` and a delivery event `{kind: "delivery", eventId, messageId, state, at, machineId}`. `eventId` is the merge and de-duplication key; `messageId` links delivery events to their message.
- **Delivery state** is reduced deterministically from a message's delivery events, independent of arrival order: a definite state (`delivered`, `refused`, `intercepted`) beats `unknown`; among definite states the latest `(at, machineId)` wins; no events means `pending`.
- **Torn tail.** On load, a final line that does not parse (a write cut short by a crash) is truncated back to the last newline and reported once as a degradation; earlier lines are never touched. Because a message commit completes before dispatch (4.2), a message whose line was torn was never dispatched.
- **Ingest position.** Every row a machine writes into its own copy, whether created there or received by replication, gets that machine's next `ingestSeq` for the file. A late-arriving replicated row therefore gets a higher `ingestSeq` than anything already read, so a local feed never skips it.
- Retention: kept until the operator deletes the conversation (`DELETE /mobile/conversations/:conversationKey`, device-signed), which appends a `tombstone` event; a machine that sees the tombstone hides the conversation and moves its file to `app-conversations/deleted/` (kept, never destroyed by this feature). Total size is reported in the authenticated `/health` (`appConversations.bytes`, `.count`).
- Reads go through the index below, so a read never scans a whole file.
- **Index.** The JSONL files are the source of truth. Beside them, `app-conversations/index.sqlite` (WAL, the same SQLite pattern as `PendingRelayStore`) holds: `events(conversationKey, ingestSeq, eventId, messageId, kind, at, byteOffset)` with indexes on `(conversationKey, ingestSeq)` and `(conversationKey, at, eventId)`, and `messages(messageId, conversationKey, at, deliveryState, lastPreview)`. Every append updates the index in the same step after the file commit. At boot, any file whose last indexed offset is behind its size is re-indexed from that offset; a missing or corrupt index is rebuilt from the files. Sync reads use `(ingestSeq)`, browse reads use `(at, eventId)`, and the list reads `messages`, each with a page bound.
- **Two reads.** *Sync:* `GET /mobile/chat/app/:conversationKey/events?cursor=<opaque>&limit=100` returns events in this machine's ingest order and a new opaque cursor (the machine id plus its `ingestSeq`); a cursor from another machine is not compared, the response starts again from the beginning, and the app de-duplicates by `eventId`. The app syncs against the machine serving its paired hostname, whose copy holds every replicated event. *Browse:* `GET /mobile/chat/app/:conversationKey/messages?before=<at,eventId>&limit=100` pages backwards through messages (with their reduced delivery state) in `(at, eventId)` order, so the whole history is reachable however long it is. Sessions read context through the same browse order. `?scope=pool` (4.8) applies to browse, merges by `eventId`, and never advances a sync cursor.

### 4.6 Signed records

Every message the app sends (native, Telegram, Slack) is stored with:

```json
"origin": { "kind": "device-signed", "v": 1, "deviceId": "…", "keyHash": "<sha256 of the public key, hex>",
  "publicKey": "<base64url>", "host": "…", "method": "POST", "pathWithQuery": "/mobile/chat/app/2f0c…",
  "timeMs": "…", "bodyB64": "<the exact signed request body; absent when redacted>",
  "bodySha256": "<hex, always present>", "sig": "<base64url DER>",
  "redaction": "<present only when redacted: {kinds, machineId, sig} — the accepting machine's identity-key signature over (bodySha256, sha256(stored text), kinds)>" },
"receivedAt": "<server time at acceptance>",
"receipt": { "machineId": "…", "signerKeyHash": "…", "sig": "<this machine's identity-key signature over (sha256(canonical request string), receivedAt, machineId)>" }
```

- **Device-key ledger** `<stateDir>/mobile-device-key-ledger.jsonl`: append-only, never pruned, rows keyed by the full `keyHash`: an activation row `{keyHash, publicKey, deviceId, host, approvedVia, activatedAt}` and a revocation row `{keyHash, revokedAt}`. Only the device registry's activation and revocation paths and the boot reconciliation below write it; no route accepts rows. Each row is signed by the writing machine's identity key and records which key signed it (`signerKeyHash`). It grants nothing; authentication stays machine-bound.
- **Write order and recovery.** Activation and revocation each write the ledger row first (a durable append) and the device registry second. At every boot, reconciliation compares the two and repairs each event independently: a registry device with no activation row gets one (with its recorded approval method, `telegram-dm` for devices approved before this change, and its recorded activation time; this backfill is the ledger's third writer); a revoked registry device with no revocation row gets one with the registry's `revokedAt`; a revocation row whose device is still active in the registry completes the revocation in the registry (the ledger row is the recorded intent). An activation row whose device never became active is harmless: no message from it can carry a machine receipt. Tests crash between the two writes in both directions.
- **Backfill:** at every boot, any active or revoked device in `mobile-devices.json` with no ledger row gets one (`approvedVia: "telegram-dm"` for devices approved before this change). Idempotent. Revoked devices already pruned before the backfill have no row; their old messages verify as `unknown`.
- **`verifyRecordedOrigin(record, ledger)`** returns one of five verdicts:
  - `none`: the record has no `origin` (Telegram-typed messages, records written before this change; nothing is rewritten).
  - `unknown`: the ledger here has no row for `keyHash`, or cannot be read.
  - `failed`: any check fails: the record's `publicKey` differs from the ledger's; `deviceId` or `host` differs from the ledger row; the signature does not verify under the ledger's key (strict DER, low-S) over the canonical string rebuilt with `bodySha256`; `pathWithQuery` does not name this record's conversation; `receipt.sig` does not verify, under the pinned identity key of `receipt.machineId`, over the canonical string's hash, `receivedAt` and `receipt.machineId`; `receivedAt` is outside the key's `[activatedAt, revokedAt)`; `|timeMs − receivedAt|` exceeds the acceptance window (60 s, from mobile-device-keys.md §2.3); or the text check below fails.
  - **Text check, one of two alternatives:** *exact*: `bodyB64` is present, `sha256(bodyB64) = bodySha256`, and the body's `text` equals the stored `text`; or *redacted*: `bodyB64` is absent, `redaction` is present, and `redaction.sig` verifies under the pinned key of `redaction.machineId` over `(bodySha256, sha256(stored text), kinds)`.
  - `verified`: every check passes with the exact text check.
  - `redacted`: every check passes with the redacted text check. This proves the paired phone signed a body with that hash and a machine of this agent attests it removed the named kinds of span; it does not independently prove the original wording, which is deliberately not kept.

- **A removed token is never stored.** For a redacted message the original signed body is not written anywhere (not to the store, not to replication, not to a log); only its hash and the attestation are.
- **What `verified` proves:** relative to the ledger this machine holds, the paired phone's key signed exactly this text for this conversation, and the named machine of this agent accepted that exact request (same conversation, same time, same body) within the 60-second acceptance window. Key lifetime is judged by the machine's signed acceptance time (`receivedAt`), not by the phone's clock, so a phone a few seconds slow is not marked `failed`. Because the receipt signs the whole canonical request, a lost phone's key cannot reuse an old receipt for a new request or backdate a message to before its revocation: a forged record would also need a machine's signature over that request. It does not prove which person held the phone.
- **Machine key rotation.** Every machine signature here (receipt, redaction attestation, ledger rows) records `signerKeyHash`. Verification uses the key that machine held at the signature's time, looked up in the attributable identity-change history (`GET /identity-changes`), not only the current pinned key, so an honest old record stays `verified` after a machine's key rotates. If that history cannot be read or does not name the key, the verdict is `unknown`, never `failed`.
- **Display:** the app shows "📱 signed" for `verified` (with "approved on dashboard" for a `dashboard-pin` key), "⚠ signature does not check out" for `failed`, "couldn't check on this machine" for `unknown`, "📱 signed, an invite or desktop code removed" for `redacted`, and nothing for `none`. History responses carry `originVerified` as that verdict.

### 4.7 Push without Telegram

`MobilePushService` is built whenever pairing is enabled, independent of Telegram, and gains a second trigger: an agent reply appended to an app conversation (4.3), one push per reply, through the service's existing budgets, folding and dedupe (docs/specs/mobile-push.md, otherwise unchanged). Attention items on an agent without Telegram have no store to push from; that is a separate, existing gap filed as instar feedback fb-4ce98e0f-293.

### 4.8 Several machines

- **The store replicates by default.** This is the one deliberate exception to the replicated-store foundation's dark/dry-run ladder for new kinds: an app conversation has no other copy. It uses the foundation's normal `ReplicationBudget` share for one store kind. For a native conversation the store is the only copy of the agent's memory of it, so it is a new replicated-store kind `appConversations` on the replicated-store foundation, always on whenever native conversations are on: it has no separate switch, because for a native conversation it is the agent's only memory of it; the one switch is `mobilePairing.native.enabled`. Events are immutable and keyed by `eventId`, so the union has no conflicts; a delete replicates as the journaled tombstone. Every machine therefore holds every conversation's history, and a session on any machine can answer coherently while the original machine is down.
- **Reads also merge live:** `GET /mobile/conversations` and browse accept `?scope=pool`, merge by `eventId`, and list machines that did not answer as `failed`, as mobile-operator-chat.md §2.4a does, which covers events not yet replicated.
- **Device-key ledger: replicated** as its own store kind `mobileDeviceKeyLedger`, on whenever native conversations are on, because a signed record read on another machine cannot be checked without it. A receiving machine accepts a row only if its signature verifies against the pinned identity key of the paired machine it names, so a peer cannot add a key on another machine's behalf. A revocation reaches each machine on the foundation's usual cadence; until it does, that machine still verifies the key's messages, and the `receipt` check limits that to messages a machine actually accepted.
- **Which machine runs the conversation.** With the session pool on, the pool's ownership and placement (`GET /pool/placement`, transfer, stale-owner release) apply to app conversations as to Telegram topics. With the pool dark, or on a single machine, the owner is the machine holding the serving lease. Ownership is recorded per machine as a local `bind-app` / `unbind-app` journal pair in its registry: a machine journals `bind-app` for a conversation when it creates it, when it gains it by placement or transfer, and for every live app conversation when it acquires the serving lease (pool dark); it journals `unbind-app` when it loses it. `/app/session-reply` checks that this machine is the current owner and holds a live binding (`409 not-owner` otherwise). A send accepted on a machine that is not the owner is forwarded through the pool's existing authenticated inbound forward with the stored `origin` in the envelope; the owner runs 4.6 itself and never trusts the forwarder's verdict. When the owner is dark, the message waits in the durable inbound queue when that is on (`GET /pool/queue`); otherwise the send answers `503 {error: "owner-unavailable"}` in plain words after the message is already persisted, so nothing typed is lost.

### 4.9 Continuing Telegram and Slack chats from the app

- **Telegram:** the send route `POST /mobile/chat/:topicId` now follows the 4.2 order and stores the message with `origin`, `receivedAt` and `receipt` in the app conversation store as above. The Telegram history row written for the same message carries its `eventId` in its metadata. `GET /telegram/topics/:id/messages`, when called by a device, joins each row that has an `eventId` to the store and returns `originVerified` computed there (4.6); a row whose store event is missing reads `unknown`, and app-sent messages whose Telegram row has rotated away are returned from the store, merged by `eventId`. Messages typed in Telegram itself read `none`.
- **Where app-sent Telegram and Slack messages are kept.** A message sent from the app into Telegram or Slack is also stored, with its `origin`, `receipt` and delivery events, in the app conversation store (4.5) under its canonical key (`telegram:<topicId>`, or the canonical Slack key; the route's negative alias is translated on the accepting machine, and the receipt records the canonical key), never rotated. That store, not the rotating platform log, is the evidence boot recovery reads, so a rotated log can never make a dispatched message look undelivered.
- **Slack** (device-signed): `GET /mobile/chat/slack/:conversationId/messages` (from `slack-messages.jsonl` and the in-memory ring, filtered to that channel or thread, merged by `eventId` with the app-sent messages from the store) and `POST /mobile/chat/slack/:conversationId` `{text, requestId}`. The post follows the 4.2 order exactly: authenticate, look up, preflight, reserve, persist the message with `origin` and `receipt` to the app conversation store (and a copy to `slack-messages.jsonl` for the Slack history view), intercepts, `slackInboundDispatch` with the operator as sender, record the outcome, the same boot recovery; then it posts the mirror "📱 <owner name> (from the app): <text>" through the Slack adapter. The mirror is a copy for people reading that channel, so it always shows credential-shaped spans as `[credential hidden]` even when the operator sent them as written; the Telegram mirror does the same. A failed mirror never fails or repeats the dispatch (the result records `mirror: "failed"`). The operator's Slack user id comes from `mobilePairing.slackOwnerUserId`; when it is unset the Slack routes answer `503 {error: "slack-owner-unset", detail}` in plain words, and the app hides Slack rows.

### 4.10 Device routes

The device allowlist gains (each for `active` devices only; `<uuid>` is the strict lowercase RFC 4122 pattern of 4.1):

| Method | Pattern |
|---|---|
| GET, POST | `/mobile/conversations` |
| PATCH, DELETE | `/mobile/conversations/<uuid>` |
| POST | `/mobile/chat/app/<uuid>` |
| GET | `/mobile/chat/app/<uuid>/messages` |
| GET | `/mobile/chat/app/<uuid>/events` |
| POST | `/mobile/chat/slack/-\d+` |
| GET | `/mobile/chat/slack/-\d+/messages` |

The comment calling the Telegram chat route "the only non-idempotent entry" is updated: every POST, PATCH and DELETE above is idempotent through `MobileChatRequestStore`.

### 4.11 The app

- One conversation list from `GET /mobile/conversations?scope=pool`, newest first, with a small label per row (App, Telegram, Slack) and a "New conversation" button with a title prompt.
- The chat view picks the send and history routes by platform, and shows each message's mark from `originVerified` only.

## Multi-machine posture

- App conversations (creation, titles, deletion, messages): **replicated** as events in the conversation store; registry aliases and `bind-app` bindings are derived per machine from that replicated state and rebuilt from it at any time (a numeric alias is meaningless on another machine), so they hold no memory of their own.
- App conversation store: **replicated** by default, with a live pool-merged read on top (4.8).
- Device-key ledger: **replicated** (4.8).
- Device records and pending pairing codes: machine-local, unchanged from mobile-device-keys.md. machine-local-justification: physical-credential-locality (a phone's credential is bound to the machine serving its paired hostname, and a pending code lives only in that machine's memory).
- Push tokens: unchanged from mobile-push.md.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| The verdict shown for a stored message (`verified` / `redacted` / `failed` / `unknown` / `none`) | invariant | Cryptographic checks against a ledger; no judgment applies, and the conservative default never shows `verified`. |
| Which pairing-code delivery path is used | invariant | Configuration presence (Telegram owner, else dashboard); both paths require an authenticated operator surface. |
| Whether a device may call a route | invariant | The explicit allowlist plus signature verification, unchanged in kind. |
| The send preflight | invariant | No content check can refuse a message. Only exact-format tokens (pairing invites, desktop codes) are removed, by exact match; credential-shaped text is a signal the operator acts on in the app, never a server decision. The remaining refusals (feature off, rate limit, stale `requestId`) do not read the content, and an emergency stop bypasses them. |
| Credential-shape detection | judgment-candidate | Heuristic (`detectOutboundCredential`); floor: it never refuses or alters a message, it only asks the operator in the app and adds a signal to the audit; the operator is the arbiter. |
| Which machine may reply (`bind-app`) | invariant | Follows the recorded owner: pool placement when the pool is on, the serving-lease holder otherwise (4.8). |
| Which session receives an app message | invariant | The deterministic `SessionChannelRegistry` lookup, as for Slack. Which machine runs it, forwarding and the offline queue are the existing pool ownership, placement and queue rules, cited and not changed by this spec. |

## Frontloaded Decisions

- The app's signing payload is unchanged: it already covers the path (which names the conversation) and the SHA-256 of the exact body (which carries the text and `requestId`).
- App conversations are named by UUID; negative numeric ids are machine-local aliases.
- Titles resolve by latest `setAt`, ties by `machineId`.
- The store is per conversation, append-only, never rotated, deleted only by the operator, and replicated by default.
- Unverifiable records are shown as "couldn't check", failed ones with a warning; neither is hidden.
- The Telegram-less pairing path is the dashboard PIN, labelled as such on every message from that phone.
- The operator's Slack user id is a config field, never inferred.

## Configuration, rollout and rollback

- `mobilePairing.native.enabled`: omitted means live on a development agent and off on the fleet (the dev-agent gate); read at boot. It also gates every change this spec makes to the existing Telegram chat route (the 4.2 order, token removal instead of refusal, the signed copy in the store, the rate-limit move). Off: the new routes answer 503, the Telegram chat route behaves exactly as before, the app hides native conversations and the "New conversation" button, and nothing else changes.
- The conversation store's replication has no separate switch (4.8).
- **Increments**, each shippable on its own: (1) the conversation store with its index, the `appConversations` replicated store kind, registry `mint-app`/`bind-app`/`unbind-app`, native send and reply routes, `app-reply.sh`, agent awareness; it is live only where Telegram pairing exists until (3). (2) Signed records, the device-key ledger with reconciliation and replication, verdicts, the Telegram history join. (3) Dashboard pairing and push without Telegram. (4) Slack from the app. (5) The iOS app changes.
- **Rollback:** switch `mobilePairing.native.enabled` off; the files stay on disk and return when it is switched on. Rolling back to an older version leaves the `mint-app` and `label` journal rows unread (skipped, with the registry's attention item) and the store files untouched.

## Tests

- **Unit:** an old receipt still `verified` after the signing machine's key rotates, and `unknown` when the identity-change history is unreadable; the conversation title resolved identically on two machines from out-of-order `label` events; an emergency stop accepted while the device is over its rate limit, and two concurrent stops executing once; ledger/registry reconciliation after a crash between writes, for activation and for revocation; a credential-shaped message delivered unchanged with `credentialShaped: true`; create recovery after a crash between mint and `done` (same conversation returned); index rebuild and catch-up from a partial index; the text check's two alternatives (exact; redacted with a valid and an invalid attestation); a redacted record holding no copy of the removed token anywhere on disk; lifetime judged by `receivedAt` with a phone clock 50 s slow; torn-tail truncation; delivery-state reduction with events arriving in every order; receipt verification failing for a reused receipt on a different path; token removal producing `redacted`; registry `mint-app`/`label` replay, including replay by the previous version (skipped, no fake Slack entry); title cleaning against tag-forgery strings; each `verifyRecordedOrigin` check on both sides (a record passing every check, and one failing each); backfill idempotency; ledger row signature acceptance and rejection; store index rebuild; replication merge of two machines' rows for one conversation.
- **Integration:** every new route on a real server: preflight refusals, `MobileChatRequestStore` replay (a retry of a delivered request after an emergency stop answers its recorded result), payload conflict and outcome-unknown, a crash between persist and dispatch (the message and its `origin` survive, delivery becomes `unknown`), the events route reached through the production device authentication, an emergency stop getting through after the device spent its 120-per-minute read allowance, a reply accepted on the serving-lease holder with the pool dark and refused elsewhere, create returning 503 with conversation recording disabled, a Telegram history read returning `originVerified` for an app-sent message, a replicated event arriving after the cursor (still returned), browsing a 250-message conversation backwards to its first message, a Slack crash between persist and dispatch, a dispatched Slack message after `slack-messages.jsonl` rotates (still recovered as delivered), a reply refused with `409 not-owner` before a `bind-app` and accepted after a transfer, the 404 and 409 cases, Slack 503 without an owner id, a pool-scope merge with a failed peer.
- **E2E (feature is alive):** an agent booted with no Telegram and no Slack: pair through the dashboard path, create a conversation, send a signed message, a session receives the `[app:…]` tag, `app-reply.sh` answers, and history shows both, with `originVerified: "verified"` on the operator message.

## Maturation plan

- **test-agent-live:** integration and E2E tests on an agent booted with no Telegram and no Slack pair a device through the dashboard path, create a conversation, send a signed message, receive the agent's `app-reply.sh` answer, and read both back with `originVerified: "verified"`.
- **dev-agent-live:** on the development agent the operator creates a native conversation from the TestFlight app, sends a message, gets a reply in the app and a push, and sees the signed mark; a Telegram topic and a Slack conversation continued from the app show the same mark.
- **fleet:** follows `mobilePairing.native.enabled`, dark on the fleet until the graduation criterion holds.
- **graduation criterion:** on the development agent, one week with app conversations in daily use, zero lost or duplicated app messages, zero `failed` verdicts on genuine messages, and the store replicated to every machine with matching event counts.
- **dark-window:** if not graduated within 30 days of release, the reason and a new date are recorded on CMT-1187.

## Open questions

*(none)*
