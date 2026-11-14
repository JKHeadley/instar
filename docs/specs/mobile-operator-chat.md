---
title: "Mobile operator chat — message an agent from the Instar iPhone app as the operator"
slug: "mobile-operator-chat"
author: "echo"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
eli16-overview: "mobile-operator-chat.eli16.md"
status: "draft"
review-convergence: "2026-11-01T01:04:23.848Z"
review-iterations: 6
review-completed-at: "2026-11-01T01:04:23.848Z"
review-report: "docs/specs/reports/mobile-operator-chat-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Echo under the operator standing rule that only constitution changes need Justin (2026-10-22, JKHeadley/instar); 24h autonomous app session approved by Justin 2026-10-31, topic 134088"
---

## 1. Problem

The approved Instar app plan includes native chat: read an agent's conversation and reply from the app, plus an "ask for update" button that opens a conversation with the question pre-filled (operator request, 2026-10-20 and 2026-10-31, topic 127504). Today the app can only read. Device keys (docs/specs/mobile-device-keys.md) give each phone an owner-confirmed key; this spec lets an active phone send a message that reaches the agent exactly as if the owner had typed it in that Telegram topic.

## 2. Design

### 2.1 One route, device-signed only

`POST /mobile/chat/:topicId`, body `{ text, requestId }`:

- **Device principal required.** A bearer request gets `403 { error: "operator-device-required" }`. The route is added to the device allowlist (docs/specs/mobile-device-keys.md §2.3), the only non-idempotent entry there, made idempotent by `requestId` (2.4).
- `text`: 1–4000 characters after trimming. `requestId`: `<unix ms>-<uuid v4>`, chosen by the app when the operator taps Send (2.4).
- `topicId`: a forum topic this agent knows (present in `GET /telegram/topics`, i.e. the adapter's topic registry); otherwise `404`.
- No Telegram adapter, or no configured owner: `503`.
- Gate: `mobilePairing.chat.enabled` (omitted ⇒ follows `mobilePairing.enabled`).
- Rate: 20 messages per minute per device, then `429`.

### 2.2 The shared inbound core

The `/internal/telegram-forward` handler mixes two kinds of work: request-specific steps (lifeline-secret guard, stale-secret header, server-boot 503, version handshake with its 426) and the steps every operator message must pass (pairing-code leak scan, pairing-invite and `/desktop` consumption, emergency-stop and pause intercepts, the exactly-once ledger, the scope-accretion ratifier and matrix-acceptance observers, the a2a hook, logging into topic history, the operator auto-bind, the serve-progress stamp, and the hand-off to `onTopicMessage`). This spec moves the second kind, unchanged, into `ingestTopicInbound(input, trust)`, which returns a typed outcome (`delivered`, `deduped`, `sentinel-kill`, `sentinel-pause`, `pairing-invite`, `desktop-approval`, `a2a-handled`, `refused`, `failed`) instead of writing an HTTP response. The lifeline route keeps its request-specific steps and maps each outcome to exactly the status and body it returns today; a regression test pins every current lifeline status and body before and after the move.

A step-inventory test lists every step of the core and asserts, for each trust kind, whether it runs or is skipped and why, so "every step" is checked in code rather than claimed.

### 2.3 What changes for an app message (trust kind `mobile-device`)

| Step | Lifeline (unchanged) | App message |
|---|---|---|
| Sender identity | from the request, dropped when the lifeline secret is unproven | the configured owner: id = `getOwnerUserId()`, first name = the owner's display name from config (`telegram.ownerName`), else "Operator" |
| `senderUnverified` / `verified` / `forwarded` | from the secret check / body | `false` / `false` / `false`, set explicitly |
| `updateId`, `caption`, `replyToMessageId` | from the body | absent |
| Ledger key | `telegram:<topic>:<updateId or messageId>` | `mobile:<deviceId>:<requestId>` (its own namespace; never collides with Telegram ids) |
| Event identity | Telegram's message id | `eventId` = `mobile:<deviceId>:<requestId>`, globally unique by construction, carried on the history row and across machines; the row's numeric `messageId` is a server-minted value above 2^52 (never a Telegram id) used only where the code needs a number |
| Pairing-code leak scan | runs | runs, first |
| `tlinv1:` pairing invites, `/desktop <id> <code>` approvals | consumed | **refused** with `422 { error: "not-from-the-app" }`, nothing logged or delivered (these need the Telegram path's own proof) |
| Credential-exposure guard | n/a | runs before anything is stored or mirrored; a live credential is refused `422` and nothing is logged |
| Emergency stop / pause intercepts | run | run |
| Observers, a2a hook | run | run |
| History row | inbound row | inbound row with `viaMobileDevice: true` and `deviceId` (new `LogEntry` fields, stored in the JSONL and SQLite paths and returned by the history route; the history sender label reads "Justin (from the app)") |
| Operator auto-bind (route and `onTopicMessage`) | runs | **skipped in both places** (`onTopicMessage` checks `metadata.viaMobileDevice`) |
| Serve-progress stamp | runs | **skipped** (it means "processed a fetched Telegram update") |
| Standing-authorization evidence | counted | **not counted**: the resolver ignores rows with `viaMobileDevice` |
| `onTopicMessage` | not awaited | awaited and caught; a rejection is recorded as `outcome-unknown` (the history row and observers may already have run) |

The owner's authority otherwise applies as in Telegram (the phone was confirmed through the owner's private chat): slash commands work. One limit: topic-profile confirmations ("yes" to a proposed model or framework change) require the topic to already have a bound operator; because app messages never create a binding, such a confirmation from the app in a never-bound topic is refused, and the app shows the agent's refusal reply. Out of scope, as in the device-keys spec: a process running as the agent's OS user.

### 2.4 Mirror, idempotency and crash behavior

- **Order: authenticate → look up → preflight → reserve → core → mirror.**
  - *Authenticate and look up*: after the device signature and the structural checks (text length, `requestId` grammar), the idempotency record is consulted **first**. A request already on record gets its recorded outcome (below), whatever the chat gate, lease, chat rate or classifiers say now, so a retry after a lost response never reads as "not delivered". This applies to requests that pass device authentication: the app retries with the same `requestId` and text but a fresh signature and time, so the device replay check and the device request cap still apply to the transport itself.
  - *Reserve atomically*: the decisive lookup is repeated and the `entered` record and the in-memory active entry are written in one synchronous step with no `await` between them (Node runs it without interleaving), so two simultaneous retries can never both reach the core.
  - *Preflight* for a new request (no effect on any session or history): gate, lease, rate, topic, `requestId` age; then the pairing-code leak scan (which may cancel a pending pairing, as on the Telegram path, but never refuses the message), then the refusals for `tlinv1:`, `/desktop` and credential-shaped text. The credential refusal is a deliberate lexical policy, not a judgment: it reuses the existing outbound credential wall, `detectOutboundCredential` (`src/messaging/outbound-credential-guard.ts`), which the operator ratified as the one hard wall on messages (directive 2026-07-19, topic 33368): a deterministic match on provider-prefixed value shapes (`sk-ant-`, `ghp_`, `AKIA`, `xoxb-`, private-key blocks, …), precision over recall, no model. It cannot tell a live key from an example or a revoked one and does not try; any text of that shape is refused from the app (the operator can still paste it in Telegram, where the inbound path is unchanged, or use Secret Drop, which is the right channel for secrets). A preflight refusal leaves no record; the app may send again.
  - *Core* (`ingestTopicInbound` with trust `mobile-device`): everything else in 2.3. The core skips the scan and the invite/desktop consumption for app messages because preflight already handled them.
  - *Mirror*: best-effort, after the core, never decides delivery.
- **Mirror:** after ingestion, the message is posted into the Telegram topic as `📱 <owner name> (from the app): <text>` through a dedicated origin producer (`mobile-mirror`) with the origin footer off, no outbound history row, no stall-timer reset and no promise tracking. It is the operator's text, so it is not reviewed by the outbound tone gate. If the mirror is held, forwarded or fails, the message is still delivered and the response says `mirrored: false`; a held mirror that is replayed later only adds the Telegram copy.
- **Idempotency record** (`.instar/state/mobile-chat-requests.json`, synchronous writes: temp file, `fsync`, rename, `fsync` of the directory, so the `entered` record is on disk before the core runs and survives a host crash, not just a process crash): `(deviceId, requestId) → { state, payloadHash, topicId, bootId, result?, at }`.
  - The record is written as `entered` (with this process's `bootId`) **before** the core runs, and as `done` with the full response (`outcome`, `eventId`, `mirrored`, stopped sessions) after it returns. The text itself is not stored.
  - **Two kinds of failure, never confused.** *Definitely not delivered*: every refusal before the core runs (validation, `422` guards, `not-serving`, rate, gate); the record is deleted and the app may send again. *Uncertain*: anything after the core started (an `onTopicMessage` rejection, a failure writing `done`, a restart); the answer is `outcome-unknown`, persisted, and the app shows "may or may not have reached the agent; check the conversation" and lets the operator decide whether to send again as a new message.
  - "Same payload" means the same `topicId` and the same text after trimming (`payloadHash` = SHA-256 of both).
  - A repeat with the same payload: `done` → the stored response; `entered` and still running in this process (tracked in an in-memory set of active requests) → `202 { state: "in-progress" }`; `entered` but not running (the server restarted mid-request, or the `done` write failed) → `409 { error: "outcome-unknown" }`, and the app says "this message may or may not have reached the agent; check the conversation" and offers to send it again as a new message. The core is **never** re-run for a request, so a restart can never deliver a message twice or repeat an emergency stop. Different payload under the same id → `409 { error: "request-id-reused" }`.
  - The exactly-once ingress ledger is not relied on (it is optional and runs after the intercepts); the app message's ledger key is still `mobile:<deviceId>:<requestId>` when the ledger runs, so it can never collide with Telegram ids.
  - **Age bounds:** the time in `requestId` must lie within 24 hours in the past and 5 minutes in the future, else `400`. Records are kept until their id can no longer be accepted (24 hours 5 minutes after its embedded time), are never evicted earlier, and at most 2,000 exist per device (`429` beyond).

### 2.4a Multi-machine delivery and reading

- **Send-time lease check.** App messages are accepted only on the machine that currently holds the serving lease (the machine that receives Telegram messages and holds live pairing codes). Pairing happens on the lease holder, but an active device stays bound to its machine's hostname, so after a lease move that machine answers `409 { error: "not-serving", detail }` in plain words ("this machine is not receiving messages right now; try again shortly or use Telegram") rather than ingesting outside the normal path.
- When the topic's session runs on another machine, the core's existing pool routing in `onTopicMessage` forwards it. The forwarded `senderEnvelope` gains `via: "mobile-device"`, `deviceId` and `eventId`; the receiving machine maps them to `metadata.viaMobileDevice = true`, `metadata.deviceId`, `metadata.eventId` before its own `onTopicMessage` logic, so it skips the auto-bind and labels the message the same way, and any history row it writes carries the same `eventId`. With the session pool `dark` (the default), delivery is same-machine, as for Telegram messages today.
- An emergency stop sent from the app has the same reach as one sent in Telegram (today: sessions on this machine); the response says which sessions were stopped.
- **Reading:** replies from sessions on other machines are logged where they are sent. The app reads history with `?scope=pool` on `GET /telegram/topics/:topicId/messages`, which this spec adds: rows from every answering machine, each tagged with its machine, deduplicated by `eventId` when present and otherwise by `(direction, Telegram messageId)` (Telegram ids are unique within the chat), ordered by timestamp; a machine that does not answer is listed as `failed`.

### 2.5 Reading

The app reads `GET /telegram/topics` and `GET /telegram/topics/:topicId/messages?scope=pool` (already on the device allowlist, view signatures stripped). After sending, it re-reads the topic every 3 seconds for up to 2 minutes, then every 30 seconds while the chat is open.

### 2.6 Ask for update

An app-side button on each topic and on each Fleet attention item that names a topic: it opens that topic's chat with "Can you give me a quick update on this?" pre-filled and focused. Nothing is sent until the operator taps Send.

## 3. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Chat accepted | `invariant` | Device principal (exact signature check), topic exists, text length, rate, gate. |
| Repeat suppressed / reused id refused | `invariant` | Exact `(deviceId, requestId)` match and payload hash. |
| Core steps | `invariant` | The same code the lifeline path runs, moved without behavior change; per-trust-kind differences fixed in the table in 2.3. |
| Invite / desktop codes and credential-shaped text refused from the app | `invariant` | Exact prefix matches and the operator-ratified lexical credential wall; deterministic, no judgment. |

## 3a. Signal vs authority

No new detector. The only new authority is that an active device speaks with the owner's voice, which is exactly what device confirmation was designed to establish; it is enforced by the signature check, not by a heuristic.

## 4. Multi-machine posture

machine-local-justification: physical-credential-locality — chat requests are signed for one machine's hostname and accepted only there, so their idempotency record lives with them; prohibited-by=the device-keys one-machine-per-hostname rule, TEMPORARY until multi-host serving is designed.

Delivery and reading across machines: section 2.4a.

## 5. Frontloaded Decisions

- **Credential-shaped text from the app is refused by the existing lexical wall** (examples and revoked keys included, by design; Secret Drop is the channel for secrets).
- **Check-and-reserve in one synchronous step.**
- **One core**: the shared steps move into `ingestTopicInbound` with typed outcomes; the lifeline route keeps its request-specific steps; a regression test pins its replies; a step-inventory test pins the per-trust-kind differences.
- **Owner's authority, recorded provenance; no auto-bind, no serve-progress stamp, no standing-authorization evidence; invites, `/desktop` codes and live credentials refused from the app.**
- **Ingest first, mirror best-effort through its own producer; own ledger namespace and reserved inbound-id range.**
- **`requestId` = `<unix ms>-<uuid v4>` within −24 h/+5 min; `entered` before the core, `done` after; a request is never re-run (restart mid-request → `outcome-unknown`); in-flight repeat → 202.**
- **App messages only on the current lease holder** (`409 not-serving` elsewhere).
- **History reads gain `?scope=pool`.**
- **Ask for update pre-fills and never auto-sends.**
- **Route shape `POST /mobile/chat/:topicId { text, requestId }`** (published interface with the app; frozen).

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** integration and E2E tests send a device-signed chat message through the production server and see it delivered via `onTopicMessage` with owner identity and `viaMobileDevice`, deduplicated on retry, stopped by an emergency-stop phrase.
- **dev-agent-live:** on the development agent the operator sends one message and one ask-for-update from the TestFlight app and gets the agent's reply in the app.
- **fleet:** follows `mobilePairing`.
- **graduation criterion:** one app message answered by a session on the development agent; zero duplicate deliveries for retried `requestId`s; the lifeline path's existing tests unchanged and green.
- **dark-window:** if not met within 30 days of release, the reason and a new date are recorded on CMT-1179.

## 6. Rollback

`mobilePairing.chat.enabled: false` turns off only this route. The extracted funnel is behavior-identical for the lifeline path, so reverting the chat route leaves it in place.

## 7. Tests

- Integration: two simultaneous identical requests → one delivery, one `202`; an emergency-stop phrase sent twice at once stops once.
- Unit: request-id store (done repeat returns the stored response; in-flight repeat 202; a failed `done` write → later repeats `outcome-unknown` without a restart; a reused id with a different topic → 409; entered by an earlier boot → outcome-unknown and never re-run; reused id → 409; past and future age bounds; no early eviction); trust-kind mapping.
- Crash test: stop the process after the core ran and before `done` is written, restart, retry: one history row, one delivery, no second stop, answer `outcome-unknown`. An `onTopicMessage` rejection → persisted `outcome-unknown`; a refusal before the core → record deleted.
- Pool: two machines' history merged by `eventId` with one row per event; a forwarded app message is labelled and not auto-bound on the receiving machine.
- Lease: an active device sending while this machine does not hold the lease → 409 `not-serving`, nothing logged.
- Integration: bearer → 403; unknown topic → 404; device message → delivered via `onTopicMessage` with the owner's id and `viaMobileDevice`, one history row, mirror posted after; same `requestId` → same answer, delivered once; "stop everything" from the app reaches the emergency-stop intercept; `tlinv1:` and `/desktop` → 422 with nothing logged; a live credential → 422; no topic-operator write; no serve-progress stamp; mirror failure → still delivered, `mirrored: false`; rate → 429; gate off → 503; pool history read merges and lists a failed machine.
- Regression: every current `/internal/telegram-forward` status and body pinned before the move and unchanged after; step-inventory test.
- E2E: production boot, device-signed chat delivered (alive on a development agent).
- Live-user-channel proof: the operator sends a message and an ask-for-update from the TestFlight app on the development agent and sees the reply.
