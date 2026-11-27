---
title: "Tell the conversation that asked for a pairing link whether the phone paired"
slug: "mobile-pairing-outcome-notice"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-pairing-outcome-notice.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched). Requested by Justin, topic 142909, 2026-11-14 14:35 PST."
review-convergence: "2026-11-15T00:10:56.633Z"
review-iterations: 5
review-completed-at: "2026-11-15T00:10:56.633Z"
review-report: "docs/specs/reports/mobile-pairing-outcome-notice-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
---

## 1. Problem

On 2026-11-14 an agent told Justin his phone pairing had failed. It had read a held `sendOwnerDMWithButton` log line (the private Telegram message carrying Approve/Decline was delayed). `GET /mobile/devices` already showed the phone `active`: the late message arrived, Justin tapped Approve, and the phone paired. The agent admitted the error at 14:29. Justin (topic 142909, 14:35): "lets use this as a learning experience to improve the robustness of the full process including an Instar agent's awareness. The user experience should be seamless".

Two gaps caused it:

1. **Nothing tells the agent the outcome.** After the agent sends the link, the pairing finishes in the app and in the owner's private chat. The conversation that asked for the link hears nothing, so the agent guesses from whatever it can see, here a log line.
2. **Nothing tells the agent where the truth is.** The CLAUDE.md pairing section explains how to mint and revoke, but not that the device list is the outcome and a delivery log line is not.

The related server refusal (feedback fb-e6b7ee2b-a8c) is fixed separately in PR 3165 and is out of scope.

## 2. What exists (instar main eb0877c3d)

- `POST /mobile/pairing-codes` (`src/server/mobilePairingRoutes.ts`) mints a one-time code in `PairingCodeStore` (`src/core/MobilePairing.ts`). Codes live **in process memory only**, keyed by `sha256(code)`; a restart voids every live code. TTL 30 minutes.
- `POST /mobile/pairing-codes/redeem` takes the code (take-and-delete), and creates a **pending** device in `DeviceRegistry` (`src/core/MobileDeviceKeys.ts`), which is on disk (`mobile-devices.json` under the state dir). If the confirmation message cannot be delivered, the pending device is removed and the phone gets 409.
- A pending device leaves `pending` by one of several paths, all writing the same registry: `applyConfirm` (code typed, → `active`, or → `declined` after 3 wrong codes), the Telegram Approve tap, dashboard Approve, owner-phone Face ID approve, owner-agent introducer (all → `active` via `applyConfirm`/equivalent), `decline` (→ `declined`), `normalize` on read (pending past `expiresAt` → `expired`), `expireAllPending` at boot and lease loss (→ `expired`), `revoke` (→ `revoked`). Old expired/declined rows are pruned after a retention window.
- Server automation posts to a Telegram topic through `postOriginAutomationReply` (`src/messaging/telegram-origin/OriginAutomationReply.ts`), which calls the ordinary `POST /telegram/reply/:topicId` route with an origin grant, so the outbound tone gate, dedup and stand-down rules apply. `AgentServer` already receives it as `options.jobAnomalySendAutomationReply` (signature `(producerId, topicId, body, author?, logicalSendId?) => Promise<Response>`).

## 3. Design

### 3.1 The mint takes an optional `topicId`, and never refuses a link because of it

`POST /mobile/pairing-codes` accepts `topicId`.

- A positive safe integer (number or digit string) on an agent whose Telegram adapter **and** origin service are running (a new service dependency `outcomeNoticeAvailable: () => !!options.telegram && !!options.telegramOrigin?.service`), with the kill switch on → a watch is recorded and the response gains `outcomeNotice: { topicId, watchId }`, so the agent can say "I'll post here when it's done."
- A negative safe integer (an app or Slack conversation), no Telegram, no origin service, the kill switch off, or a watch that could not be recorded (cap reached, write failed) → **the link is still minted**, and the response carries `outcomeNotice: null, outcomeNoticeReason: "<plain reason>"`. A pairing link is the primary job; the notice is an addition and must never cost the operator the link (an Instar agent works without Telegram).
- Present but not a safe integer (zero, fractional, a non-numeric string such as an unexpanded `$INSTAR_TOPIC_ID`, other types) → the link is still minted, with `outcomeNotice: null` and the reason "topicId was not a conversation number". An empty string is treated as absent. Nothing about `topicId` ever costs the operator the link.
- Absent → today's response, byte for byte.

**Who may name a topic.** Only a Bearer-token holder can mint, and that same holder can already post anything to any topic through `/telegram/reply`, so naming a topic grants nothing new. The line goes only to the topic the minting caller named, at most once per link, and links are capped (10 live, 10 mints per hour), so the worst a token holder can do is post a handful of fixed lines.

**The agent does not have to remember the topic.** Sessions run with `INSTAR_TOPIC_ID` in their environment (`SessionManager`, set whenever the spawn knows a numeric topic), and the CLAUDE.md Mint example splices it into the single-quoted body (`-d '{"label":"…","topicId":"'"${INSTAR_TOPIC_ID:-}"'"}'`; unset → `""` → absent), so copying the example is enough.

Out of scope: `mintTeamLink` (the team invite path) and browser device setup; neither takes `topicId`.

Kill switch: `mobilePairing.outcomeNotice.enabled` (omitted = on; read live per request and per pass, so no `migrateConfig` default is needed).

### 3.2 A durable watch per minted code, joined to the device atomically

New `PairingOutcomeWatches` (`src/core/PairingOutcomeWatches.ts`): an in-memory map backed by `<stateDir>/mobile-pairing-outcome-watches.json` (mode 0600, temp file + rename, written only when an entry changes). Entry:

```
{ id, topicId, label, mintedAt, codeExpiresAt, codeEpoch,
  lastSeen?: { status, at },          // last registry status a pass observed for its device
  state: 'watching' | 'due' | 'sending' | 'handed-off' | 'sent' | 'failed',
  operationId?, anchorInboundId?,
  outcome?, text?, decidedAt?, attempts, nextAttemptAt?, sentAt?, lastError?,
  escalated?: boolean }
```

- **Record at mint.** After `codes.mint` succeeds, the watch is written; its `id` is also stored on the in-memory code entry (`PairingCodeStore.mint` gains an optional `watchId`). If the write fails, the code is kept and the response says `outcomeNotice: null` (§3.1).
- **Join at redeem, inside the device write.** `codes.redeem` returns the `watchId`; `devices.createPending` stores it on the new device record (`outcomeWatchId`) in the **same** registry write that creates the device. There is no separate bind step, so there is no crash window between "device exists" and "watch knows about it".
- **Taken.** The moment `codes.redeem` succeeds the route marks the watch `takenAt` (a phone used the link), before anything else can fail. The take, the mark and the device write run in one synchronous block (no `await` between them), and a pass is a separate event-loop task, so no pass can see `takenAt` without the device unless the process died in between, which is exactly when `ended` is the honest line.
- **Route-decided outcomes.** If the redeem is refused after the take (wrong origin, `createPending` refused or throwing), the watch is decided `ended` there. If the owner's approval message cannot be sent at all and the pending phone is removed (the 409 `approval-unavailable` path), the watch is decided `not-delivered` there, with its own line. A token rotation makes `redeem` refuse without taking, so that watch ends `link-expired` ("expired without pairing a phone", which stays true).
- **`codeEpoch`** = this process's boot id only. Codes live in process memory, so only a restart voids them; a lease move does not (`leaseTick` clears the *confirmation* codes, not the links, and a machine without the lease refuses redeem before taking the code, so the link works again when the lease returns).
- Cap 50 open entries. Basis: at most 10 mints per hour, and an entry stays open for its link time (1–60 min, default 30) plus 30 min pending plus the 1-hour send window, about 2.5 h, so a legitimate peak is about 25; 50 leaves room, and reaching it is reported in the response, never silent. Terminal entries are pruned 30 days after they end; their reader is `GET /mobile/devices` (§3.6), so "did it ever tell me?" has an answer.

### 3.3 The reconciler decides the outcome from the registry

A pass every 5 s on its own unref'd timer, which does nothing (no file read) while no entry is non-terminal. The first pass runs after the server is listening. Each pass reads the registry with a new **strict** read (`DeviceRegistry.listStrict()`): the same normalisation as `list()` (which expires pending devices past their time), but a file that exists and cannot be read or parsed **throws** instead of returning an empty list. On a throw the pass decides nothing new (unknown is not an outcome) and reports one degradation; already-decided entries keep sending, hand-offs keep being read, and attention items keep being raised, since none of that needs the registry.

For each `watching` entry, find the device with `outcomeWatchId === id`, record `lastSeen`, then:

| What the pass sees | Outcome | Line |
|---|---|---|
| device `active` | `paired` | `A phone named "<name>" was paired with <agent> (key <fp>).` (past tense: true even if it is revoked later) |
| device `revoked`, has `approvedAt` | `paired` | same as above |
| device `declined`, 3+ wrong codes | `declined` | `A phone named "<name>" was not paired with <agent>: the confirmation code was entered wrong too many times.` |
| device `declined` otherwise (owner Decline, or cancelled because its code was pasted in chat) | `declined` | `... was not paired with <agent>: the request was declined or cancelled.` |
| device `expired` at or after its own pending deadline | `expired` | `... was not paired with <agent>: nobody approved it in time. Ask for a new link to try again.` |
| device `expired` before its deadline (boot or lease-loss expiry) | `interrupted` | `... was not paired with <agent>: <agent> restarted or moved to another machine while it was waiting. Ask for a new link to try again.` |
| device `revoked`, no `approvedAt` | `ended` | `... was not paired with <agent>: it was removed before it was approved.` |
| no device now, `lastSeen.status` was `active` | `paired` | as `paired` (it was active, then revoked and pruned) |
| no device now, but seen before, or `takenAt` set, or refused after the take | `ended` | `A phone named "<name>" used the pairing link for <agent>, but I did not see it get approved. Check the phone list to be sure.` |
| owner's approval message could not be sent (route-decided) | `not-delivered` | `A phone tried to pair with <agent>, but I could not send you the approval message. Open a private chat with <agent> in Telegram and send it any message, then ask for a new link.` |
| device in a status this version does not know | `unknown` | `I could not tell how the pairing link for <agent><(label)> ended. Check the phone list to be sure.` |
| nothing taken, `codeEpoch` ≠ current | `link-void` | `The pairing link for <agent><(label)> stopped working when <agent> restarted. Ask for a new link to try again.` |
| nothing taken, `codeExpiresAt` passed | `link-expired` | `The pairing link for <agent><(label)> expired without pairing a phone.` |
| device `pending`, or nothing taken and the link still live | keep watching | — |

To tell `expired` from `interrupted`, `createPending` also records the device's original pending deadline (`pendingDeadline`) next to `expiresAt`, which `expireAllPending` overwrites.

A missing row is never read as "not paired": `paired` wins whenever any pass saw the device active (`approvedSeenAt`, immutable, with the name and fingerprint captured at first sight), and otherwise the line says only that the agent did not see it approved and points at the phone list. Rows leave the registry when the redeem cannot deliver the owner's message at all (with PR 3165 a slow message no longer removes the device), and by pruning: expired/declined after 24 h (`TERMINAL_KEEP_MS`), revoked beyond 200 tombstones. A boot pass after a long outage can find a pruned row with no observation, which is exactly the case worded neutrally.

**Untrusted text.** `<name>` (the phone's chosen name, else the mint label; with neither, "A phone was paired…") and `<label>` are reduced to letters, digits, spaces, apostrophes and hyphens (Unicode letters allowed; everything else, including `.`, `_`, markdown, `@`, `/`, `:`, bidi and zero-width characters, removed, so no domain or formatting survives), whitespace collapsed, cut to 40 characters, and shown in quotes after "a phone named". `<fp>` is the existing device fingerprint, so the operator can match it to the app. `<agent>` is `config.projectName` through the same filter. `<(label)>` is ` ("<label>")` when the mint carried a label, else nothing. With that alphabet a line cannot carry a link, a mention or formatting.

The outcome and its text are frozen when the entry becomes `due` (`decidedAt` set), so a later registry change cannot change what is said. A revoke after `paired` is the operator's own later act and produces no second line.

### 3.4 Sending: one message per outcome, across restarts

Each line goes through `postOriginAutomationReply` → `POST /telegram/reply/:topicId` as producer `mobile-pairing-outcome`, with logical send id `mobile-pairing-outcome:<id>` and the header `X-Instar-System: true` (`postOriginAutomationReply` gains an optional extra-headers argument; a dedicated closure in `server.ts` passes it). A new entry in `src/messaging/system-templates.ts` matches exactly the line shapes of §3.3 (fixed words, the filtered alphabet in the variable slots), so the route treats them as reviewed system templates: the LLM tone gate is skipped (a hostile name cannot get the notice refused) and the credential wall still runs. `AgentServer` receives the sender through a dedicated option (`mobilePairingAutomationReply`, wired in `server.ts` to the same `sendAutomationReply`), with a 15 s abort on the request.

There is no batching: each link is its own message (at most 10 live links; one line each).

**It reaches the conversation only when the person asked there.** This uses the presence-standby notice's producer shape (a fixed in-process producer plus the person's own message id), with the anchor checked at mint rather than at send:

- **Anchor at mint.** The service asks the selectivity gate for the topic's latest message from the operator (`recentOperatorInbound(topicId, 15 min)`, a new read over the gate's existing per-topic inbound rows). That message is the request the link answers; its id is stored on the watch as `anchorInboundId`. A mint with no such message (for example a job session that copied the example) still records the watch, but `anchorInboundId` is empty and the response says `outcomeNoticeReason: "No recent message from you in this conversation, so the result will go to the quiet feed."`
- **At send.** With an anchor, the route builds the envelope `{ category: 'pairing-outcome', inboundMessageId: <anchor> }` — only when the in-process producer is `mobile-pairing-outcome` and `metadata.inboundMessageId` is present, the same shape as the `presence-proxy` branch (HTTP callers cannot register or claim a producer). Without an anchor the line is an ordinary automated notice and quiet-by-default files it; `PRODUCER_NOTIFICATION_CATEGORIES` deliberately does not map `mobile-pairing-outcome`.
- **The gate.** The anchor is verified once, at mint, by the server itself (an operator message recorded in that topic within 15 minutes). The gate's inbound rows are in memory only (last 20 per topic, lost on restart), so re-checking them at send would turn every outcome decided after a restart, or after a busy conversation, into a quiet line plus an attention item. So `pairing-outcome` delivers when the envelope carries an `inboundMessageId`, and the route sets that category only for the in-process `mobile-pairing-outcome` producer, whose anchor came from the mint check. Without an anchor the envelope is an ordinary automated notice.
- **Limits, accepted.** The anchor is a heuristic: it is the operator's latest message in that topic in the 15 minutes before the mint, which is normally the request for the link. A mint on a machine whose gate saw no operator message (a standby with Telegram polling off) is unanchored and goes to the quiet feed; Telegram-path minting already requires the serving lease, so this is rare.
- **One protected set.** `CONVERSATION_CATEGORIES` today decides three things: no push redirect (`destination()`), the `configurable` flag the dashboard uses for its toggles, and the 400 on push changes (`notificationRoutes.ts`). A new `PROTECTED_DELIVERY_CATEGORIES` = conversation categories ∪ `pairing-outcome` is used in those three places; `decide()` keeps the conversation categories' inbound rule and gives `pairing-outcome` its own (above). Tests cover both sides.

Before the send the entry is written `sending` (`attempts+1`). The answer is classified by its body, not its status alone:

| Answer | Result |
|---|---|
| 2xx, delivered (not `recorded`) | `sent` |
| 2xx `suppressedDuplicate`, or an origin content-dedup answer | `sent` (an identical line was just posted in this topic; the reader has it) |
| 2xx `recorded: true` (filed in the quiet feed) | for an anchored watch `failed` (nobody saw it); for an unanchored watch `sent` (the quiet feed was the intended place). The same rule applies to an outbox outcome `not-delivered` with reason `quiet-notification-recorded` |
| 409 `telegram-origin-held` with `delivered: true` | `sent` |
| 409 `telegram-origin-held` **with an `operationId`** (the outbox owns the send; the route always says `retryable: false`, "only the outbox may retry") | `handed-off`: the `operationId` is stored and the entry reads `GET /telegram/origins/operations/:id/outcome` instead of resending, backing off like retries (30 s doubling, capped at 5 min; the read may ask the executing machine and take up to 4 s) — `delivered`/`partially-delivered` (including `reason: duplicate-content`) → `sent`; `not-delivered` with `quiet-notification-recorded` → as the quiet row; any other `not-delivered` → `failed`; `unknown`/`pending` → keep reading until 6 hours after `decidedAt` (the outbox's own deadline is 6 h from its preparation, which is later), then `failed` with "may not have been posted" wording. The 1-hour window and the 150-minute rule do not apply to a handed-off entry. A policy refusal also carries an `operationId`, but it is answered with its own `error` (not `telegram-origin-held`), which the table classifies first as a final refusal |
| 409 `telegram-origin-held` **without an `operationId`** (a refusal before any operation: `logical-send-content-conflict`, `invalid-automation-credential`, `unregistered-producer`, `invalid-automation-destination` — these all report outcome `held`) | `failed` |
| 409 `content-dedup-unavailable` or `duplicate-suppression-unrecorded`, or a hold with reason `notification-server-unavailable` (a lifeline not yet restarted after an update) | retry |
| thrown `TelegramOriginHoldError` before any request (e.g. `automation-credential-capacity`) | retry |
| 409 `standing-down` | retry (if this machine is the one standing down, the window ends in `failed` and the attention item) |
| other 4xx, 503 "Telegram not configured" | `failed` |
| network error, timeout, other 5xx, 429 | retry |

Retries back off 30 s × 2^(attempts−1), capped at 5 minutes, until 1 hour after `decidedAt`; then `failed`. Basis: an operator who just paired a phone wants to hear within minutes; after an hour the attention item below is the better channel, and the device list answers meanwhile.

**A crash mid-send:** an entry found `sending` at boot goes back to `due` and is replayed with the **same** logical id and the **same frozen text**. The origin service's logical-send index returns the stored receipt for a replay whose content matches (keyed by producer, topic, logical id and machine), so a send that landed is not posted again. The mint records a watch only when the origin service is running (§3.1), so this guarantee always has its index.

**Closing the loop.** When an entry becomes `failed`, one attention item per topic is upserted (`mobile-pairing-outcome:<topicId>`, NORMAL priority) listing, in plain words, each outcome that could not be posted there ("A phone named "Justin iPhone" was paired with Echo (key …). I could not post that in this conversation."; when the last answer was an unresolved outbox hold, "I may not have been able to post that in this conversation."), plus one degradation report (`MobilePairing.outcomeNotice`). `escalated: true` is written after the upsert succeeds; a pass that finds `failed` without `escalated` retries the upsert (idempotent by id). The retries are the self-heal; the attention item comes only after they are exhausted or the failure is terminal.

Only one pass runs at a time (re-entrancy flag; the 15 s abort bounds a stuck send). Work outside the send path has its own brakes: a failed attention-item upsert backs off per topic (30 s doubling, capped at 10 min), and a registry read failure is reported at most once per 10 minutes. Open work for the idle check includes `failed` entries whose attention item is not yet recorded, so the escalation retry survives a crash.

Known limits, accepted: the system-template skip of the tone gate holds for local Bot API dispatch; if the send is forwarded to another machine, that machine's policy review runs and a refusal ends in the attention item. Any Bearer-token holder can already send `X-Instar-System: true` with a line of this exact shape; it gains nothing a token holder lacks.

### 3.5 Multi-machine

The watch lives on the machine that minted the code: the code exists only in that process, redeem reaches only that machine's stable address (`verifySoleServer`), and the device record is written there. If that machine is down when the outcome happens, the line waits until it returns and is decided on its next pass; the device list (`?scope=pool`) answers meanwhile. A lease move does not void links; it expires waiting phones, which the lines report as `interrupted`. The send goes through `/telegram/reply`, whose origin layer routes to the machine serving Telegram.

### 3.6 Awareness (Agent Awareness + Migration Parity)

One new bullet in the "Mobile pairing link" CLAUDE.md section (`MOBILE_PAIRING_CLAUDEMD_SECTION`, which feeds both the template and the migrator), its own content-sniff marker, inserted before `\n- Revoke one phone`:

> - **The pairing outcome is the device list, never a log line.** Mint with `topicId` (the Mint example fills it from `$INSTAR_TOPIC_ID`) and one plain line is posted in this conversation when the phone pairs or fails; the response's `outcomeNotice` says whether it will be (`null` comes with the reason). Before telling anyone how a pairing went, read `GET /mobile/devices?scope=pool`: on this machine's rows `status: "active"` = paired, and `pairingOutcomes` lists the outcome of each recent link minted here, by `watchId` (a link minted on another machine is answered there). A held, slow or failed owner-message log line is not a failed pairing: the message can arrive late and still be approved.

**A structured read for the agent.** The posted line reaches the person; a session does not see server posts in its context. So `GET /mobile/devices` (owner callers only — never an MSP or team phone, whose branch returns early; local and `?scope=pool`, this machine's entries) gains `pairingOutcomes: [{ watchId, topicId, outcome, state, text, decidedAt, sentAt }]` for the last 30 days. The one read the bullet already requires answers "how did my link end?" without a second endpoint.

The Mint example's body gains the spliced `topicId` (§3.1), by a second idempotent patch that rewrites only the body `'{"label":"Justin iPhone"}'` on the Mint line (port-independent); each patch has its own marker, so either applies without the other, and the bullet says to pass `topicId` whatever the example shows. The CapabilityIndex mobile description and the `devGatedFeatures` description mention `topicId`. The awareness entry registry (PR 3171) is still open, so the existing template + migrator path is used.

## 4. What does not change

Pairing security: who can approve, the code budget, what the phone receives. The owner's private message still carries the code and buttons. Callers that do not pass `topicId` see byte-identical responses.

This builds on PR 3165 (open), which keeps a pending phone when the owner's message is slow instead of removing it. If 3165 has not merged when this is built, this branch is rebased onto it once it does; the `ended` row is correct either way, it only fires more often without 3165.

## 5. Tests

- **Unit** `tests/unit/PairingOutcomeWatches.test.ts`: every row of the §3.3 table, including `interrupted` vs `expired` and `lastSeen` active then pruned → `paired`; strict read throw → no change; text frozen at `due`; the §3.4 answer table row by row; `sending` at boot → replayed with the same id and text; re-entrancy; cap and prune; `escalated` retry; idle pass reads no file; persistence across a new instance.
- **Unit** `tests/unit/pairing-outcome-text.test.ts`: the name filter (markdown link, `evil.com`, `@mention`, `_x_`, U+202E, zero-width, 200-character name) and that every produced line matches the new system template while a line with any other character does not.
- **Unit** `tests/unit/notification-pairing-outcome-category.test.ts`: while enforcing, `pairing-outcome` with an anchor id delivers even with no inbound rows at all (the restart case); without an id it is recorded; it is not configurable and has no push destination; `recentOperatorInbound` ignores non-operator rows and old rows.
- **Unit** `tests/unit/PostUpdateMigrator-pairingOutcomeBullet.test.ts`: bullet inserted once, idempotent; Mint line patched only on exact match, independently; hand-edited section untouched; the fresh template contains both.
- **Integration** `tests/integration/mobile-pairing-outcome-notice.test.ts`: over HTTP with a stub sender: mint with `topicId` → redeem → approve → exactly one send to that topic with the paired line and the system header; decline path; negative id and `"$INSTAR_TOPIC_ID"` literal → link minted with `outcomeNotice: null`; redeem whose owner message cannot be sent → `not-delivered` line; `GET /mobile/devices` carries `pairingOutcomes`; kill switch → `null`; absent → response unchanged.
- **E2E** `tests/e2e/mobile-pairing-outcome-notice-alive.test.ts`: the production `AgentServer` construction path wires a real (non-no-op) sender into the service, and a minted watch reaches `sent`.

## 6. Live proof

On a throwaway agent with its own Telegram group (memory: telegram-live-proof-route): mint a link with `topicId` of a test topic, redeem with a test device key, approve, and see the one line arrive in that topic. Then a second link left to expire (short TTL in the throwaway config) and its line. Never on the operator's own topics.

## Decision points touched

- topicId admission at mint — invariant; basis: enumerable-domain; evidence: the value is either absent/empty, a positive safe integer (a Telegram topic), or anything else; each has one fixed handling in §3.1, and none refuses the link.
- outcome classification (registry state → outcome row, §3.3) — invariant; basis: enumerable-domain; evidence: `DeviceStatus` is the closed union `pending | active | declined | expired | revoked`, plus "no row" split by the recorded `lastSeen` and `codeEpoch`; every combination maps to exactly one row and no signals compete.
- send answer classification (§3.4 table) — invariant; basis: enumerable-domain; evidence: the reply route answers with a status plus a typed body (`telegram-origin-held` with `delivered`/`retryable`/`outcome`, `standing-down`, `suppressedDuplicate`), and the origin layer already labels each hold retryable or not; the table maps each typed answer once.
- send window (30 s doubling, 5 min cap, 1 h) — invariant; basis: external-constraint; evidence: the person who asked is waiting with the phone in hand, so the line's value is in its first minutes; transient causes (restart, lease handover, brief Telegram error) clear well within an hour; past that the per-topic attention item reaches the operator instead, so no outcome is dropped.
- 5 s reconcile interval — invariant; basis: external-constraint; evidence: matches the service's existing 5 s lease tick, is below a person's "did it work?" check, and the pass reads nothing while no entry is open.
- pairing-outcome delivery — invariant; basis: irreversible-consequence; evidence: a posted line cannot be unsent and an unrequested one is exactly what quiet-by-default holds back, so delivery requires proof the person asked: the operator's own message in that topic within 15 minutes before the mint, checked by the server at mint and carried only by the in-process producer, whose envelope the gate trusts; without that proof the line is quiet.
- non-terminal cap (50) and terminal retention (30 days) — invariant; basis: external-constraint; evidence: `MAX_MINTS_PER_HOUR` = 10 and an entry's open life of at most ~2.5 h give a legitimate peak near 25; reaching 50 is answered in the mint response (`outcomeNotice: null` with the reason), not silently dropped; 30 days only bounds a file of a few KB.
- name filter (alphabet, 40 characters) — invariant; basis: irreversible-consequence; evidence: a line posted into the operator's conversation cannot be unsent, and a link or mention in it is a phishing and injection path (the owner DM already warns the name is phone-chosen); the alphabet admits ordinary device names ("Justin's iPhone 15 Pro") and nothing that formats.

## Multi-machine posture

- Watch store `mobile-pairing-outcome-watches.json` — machine-local. machine-local-justification: physical-credential-locality — the pairing code it watches is a one-time bearer credential that exists only in the minting process's memory on one machine (never written to disk or replicated, by the pairing-link security design), its redeem is served only by that machine's own address (`verifySoleServer`), and the device record it reads is written on that machine. A copy elsewhere would watch a code that cannot be redeemed there; if the minting machine is down, the line waits for it and the pool device list answers meanwhile.
- The posted line — unified: it goes through `/telegram/reply`, whose origin layer routes to whichever machine serves Telegram (one voice).
- Device outcome truth — unchanged and already unified: `GET /mobile/devices?scope=pool` merges every machine's phones; the awareness line points agents at it.

## Frontloaded Decisions

1. Telegram topics get the line; negative ids (app/Slack) and agents without Telegram still get the link, with `outcomeNotice: null` and a plain reason.
2. Fixed third-person lines registered as system templates (no LLM wording, no tone-gate verdict on them); the phone's name is filtered to a plain alphabet and quoted as "a phone named …", with the key fingerprint.
3. Kill switch omitted = on; inert unless a caller passes `topicId`.
4. Awareness through `MOBILE_PAIRING_CLAUDEMD_SECTION` + two independent migrator patches (PR 3171 not merged); the example uses `$INSTAR_TOPIC_ID`.
5. A revoke after `paired` produces no second line.
6. No batching; one message per link.
7. Failed notices: one attention item per topic, after retries are exhausted.
8. Built on top of PR 3165; rebase onto it when it merges.
9. A new protected category `pairing-outcome` delivers only when anchored to the operator's own recent message in that topic (checked at mint; the gate trusts the in-process producer's envelope); otherwise the line is quiet. Not operator-configurable, never push-redirected.
10. Past-tense "was paired"; an identical line already posted counts as delivered.

## Maturation plan

- **test-agent-live:** the §6 live proof: a throwaway agent with its own Telegram group mints a link with a test topic id, a test device key redeems and is approved, and exactly one paired line arrives in that topic; a second link left to expire produces its line.
- **dev-agent-live:** live on the development agent from the release that carries it (kill switch omitted = on). For one week, every link minted with a `topicId` is checked against `pairingOutcomes` on `GET /mobile/devices`: each decided entry ends `sent` (or `failed` with its attention item).
- **fleet:** the same release; it acts only when a caller passes `topicId`, so there is no fleet flip.
- **graduation criterion:** over the dev-agent week, at least one real pairing link minted with a `topicId` reaches `sent` with its line visible in that topic, and no watch is `failed` without an attention item. Zero links is not a pass; the window extends until one happens.
- **dark-window:** none (live on release). If the criterion has no real link within 14 days, the reason and a new date are written in topic 143125.
- **ladder:** not applicable: no off-by-default switch (inert unless a caller names a topic)

## Open questions

*(none)*

## 7. Rollback

`mobilePairing.outcomeNotice.enabled: false` stops new watches and sends; existing entries stay on disk. Turning it back on resumes them. An outcome decided more than 150 minutes after its link was made (longest link 60 min + pending wait 30 min + send window 60 min), or a decided entry whose 1-hour window has passed, goes straight to `failed` and the per-topic attention item, so this feature never starts a send for a stale outcome. The same rule covers a minting machine that was down for hours. One accepted exception: a send already handed to the outbox follows the outbox's own 6-hour deadline and may land late; its past-tense line stays true, and its attention item is raised only when the outbox reports failure or the deadline passes, worded "may not have been posted". Reverting the PR removes the store; the file is inert without it.
