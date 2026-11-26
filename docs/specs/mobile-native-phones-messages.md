---
title: "Native Phones, Messages to you, and Insights screens for the Instar iPhone app"
slug: "mobile-native-phones-messages"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-native-phones-messages.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST: the app should do every feature natively; his plan names Phones list-and-revoke, Messages to you and Insights); approval applies because the two read-only routes return a field-trimmed subset of what the console shows the owner (Messages after the PIN unlock, Insights in full), and an owner phone removing another phone is what the console's Phones panel already lets the owner do"
review-convergence: "2026-11-04T14:46:38.706Z"
review-iterations: 6
review-completed-at: "2026-11-04T14:46:38.706Z"
review-report: "docs/specs/reports/mobile-native-phones-messages-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 2
---

## 1. Problem

Operator request (Justin, Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST): the Instar iPhone app should do every feature natively instead of opening dashboard pages. The plan of record (`.instar/lanes/app-native-coverage-plan.md`) lists three rows this change covers:

- **Phones** (paired devices): list and remove. The plan says `GET /mobile/devices` and revoke are already device-key OK.
- **Messages to you** (message origins): read-only.
- **Insights**: read-only.

A paired phone signs each request with its device key, and `deviceAuthenticator` admits only paths in `DEVICE_ALLOWLIST` (`src/server/mobilePairingRoutes.ts`).

## 2. What exists (instar main e87b4eee1)

- **Phones.** `GET /mobile/devices` is on the allowlist (active devices). An owner phone (or the bearer) gets this machine's device rows (`publicDeviceView`: id, name, label, pairedAt, status, person name and role, fingerprint for active/revoked, approvedAt, revokedAt, machine); an MSP phone gets only its own row. `POST /mobile/devices/:id/revoke` is on the allowlist (statuses pending/active/declined/expired, `unassignedOk`), but the route answers `403 a device may only revoke itself` when a device names another id. The bearer may revoke any device (here, or forwarded to the peer holding it). **Verified: the list is device-key OK; revoking another phone is not.** The console's Phones panel (`dashboard/phones.js`) lists active and pending phones from `GET /mobile/devices` (this machine) and offers "Remove this phone" on active rows after a browser confirm, using the bearer token with no PIN.
- **Messages to you** (`dashboard/console/messages.js`, `messages-model.js`): reads `GET /telegram/origins/status` and `GET /telegram/origin-display` (both require a dashboard operator session, i.e. a PIN unlock; the bearer alone gets `403 operator-audit-scope-required`), `GET /health` (`telegramOrigin.heldForward`, bearer) and `/telegram/topics?scope=pool` (names). Without the PIN the page shows only the held count from `/health`. With it: a headline ("2 replies are held on this machine."), held sends grouped by conversation (or by cause when the conversation is unknown) with the hold reason in words and the oldest wait, an expired count, a sentence about sends Telegram never confirmed, the recording-readiness items that are not ready, and the who-wrote-this footer settings (editable).
- **Insights** (legacy dashboard tab `insights`, `dashboard/index.html` `loadInsights`): reads `GET /insights` (bearer; `503 live-insights disabled` when the engine is dark). Each page strip shows title, source badge (AI / AI cached / summary / paused / no data), "as of", headline, lines (text, severity, next step), metrics (label, value) and a drill button to a dashboard tab. `DashboardInsightEngine.getInsight()` is documented never to throw (`getAll()` loops over it with no catch of its own, so callers keep a try/catch); LLM output is cached per page for 5 minutes per data fingerprint and is off unless `dashboard.liveInsights` is live and not dry-run.
- The merged mobile read pattern (PRs #2706, #2712, #2725): purpose-built trimmed routes, `ownerOrBearer`, `phoneText` / `cleanText`, `rowKey`, `singleFlight` (15 s), `DegradationReporter` on read failure, owner-only allowlist entries with their own bucket.

## 3. Design

### 3.1 Two new read routes

New module `src/server/mobilePhonesMessagesRoutes.ts`, mounted inside `createRoutes` beside the plans-people routes.

| Route | Reads | Answers |
|---|---|---|
| `GET /mobile/messages` | this machine's `telegramOrigin.deliverySummaryInputs()` (new, a strict subset of `status()`: `heldStatusWithDurable()`, `heldForwardHealth()`, `service.expiredHeldStatus()`, `assessOriginActivation(enrollment)`, `service.metrics()`; the held read is the store's bounded `listHeldOperations({ limit: 200 })` that `status()` also makes, plus `heldComplete`: false when that read failed or filled its 200-row page, so more may exist; no notice sockets, browser, detector, storage-health or retention reads) + this machine's topic names + each online peer's `GET /mobile/messages?scope=local` (proxied-on-read) | `{ schemaVersion: 1, generatedAt, state, headline, sub, tone, groups, truncated, expired, unconfirmedLine, recording, notReady, machines, unread, offline, footerLine }` |
| `GET /mobile/insights` | this machine's `dashboardInsightEngine.getAll({ cachedOnly: true })` + each online peer's `GET /mobile/insights?scope=local` (proxied-on-read) | `{ schemaVersion: 1, generatedAt, state, selfState, headline, pages, truncated, unread, offline }` |

`?scope=local` answers this machine's summary only (no peer reads, and pages and groups keyed for this machine); it is how one machine reads another's summary, so no read fans out twice. Any other `scope` value is ignored (treated as the merged answer).

Each answer is built by a pure summarizer from an explicit field allow-list.

**MobileMessages.** `state`: `ok | off | unavailable` (`off` = no origin runtime on this machine; `unavailable` = the read threw or answered without its held list). When `state` is not `ok`, the headline uses this machine's `heldForward` counts if readable, worded as what they are: held forwards only ("N replies are waiting to be passed to the machine that holds the conversation."; zero → "No replies are waiting to be passed on; other held messages can't be read right now."), else "Can't tell how many messages are held." When `ok`, the summarizer copies `buildMessagesPage`: held rows grouped by conversation (named conversations stay distinct; unnamed ones are grouped by hold reason as "N delayed messages"), `groups: [{ key (rowKey of the group), title, reasonWords, count, oldestAt }]` (largest first, then newest; cap 50, `truncated` when more); the headline is the console's `heldHeadline` (replies / automatic / other split when every row has a known producer kind), else the expired line, else "Messages to you"; `sub` is the console's sentence ("I need to restore delivery. This is not a task for you." plus the oldest wait); `tone` is `attn | bad | ok`; `expired` is the console's count; `unconfirmedLine` is the console's "Of N sends Telegram confirmed, M more ended without a confirmation either way." or null; `recording` is `on | not fully set up`; `notReady: [{ key, title, detail, tone }]` (fixed words as below; cap 30). Hold reasons use the console's fixed `HOLD_WORDS`; any other reason reads "held for another reason" and a missing one "held for an unstated reason" (no reason text passes through). Readiness rows carry fixed vocabulary only: `title` is the obligation from the fixed `ORIGIN_ACTIVATION_OBLIGATIONS` list in words (any other value reads "Another recording check"); `detail` is the state ("held" or "can't tell yet") plus a reason only when it is one of the two fixed reasons `assessOriginActivation` itself writes (`enrollment-observation-missing` → "not checked yet", `enrollment-observation-expired` → "last check is out of date"). Observation subjects and any other reason text are never returned. A peer's group reason is kept only when it is one of the fixed reason phrases; otherwise it reads "held for another reason". Conversation titles come from this machine's topic registry through `isVerifiedChannelName` (a placeholder like `topic-123` or an id is never a title; "Conversation name unavailable" otherwise). Peers: each online peer's `?scope=local` summary is read; its groups are added to `groups` (each key namespaced by the peer's registry machine id and the peer's own group key, so equal causes or conversations on two machines are two rows) with `machine` set to the peer's verified nickname ("another machine" otherwise; null for this machine), and `machines: [{ name, count, complete, state }]` lists every machine read (this machine first, named "This machine"), with `count` its held total and `state` its own `ok | off | unavailable`. A peer whose own state is not `ok` is listed with that state, never as zero held. Machine scope of each field: `groups`, `machines`, the held counts in the headline and `truncated` cover every machine read (a peer's own `truncated` is carried into the merged one, and held totals come from each machine's `heldCount`, not from the shown rows); `sub`, `expired`, `unconfirmedLine`, `recording` and `notReady` are this machine's (the app shows them under this machine). `heldCount` (this machine's held count) and `heldComplete` are part of the `?scope=local` answer only. When `heldComplete` is false the count is a lower bound: the headline reads "At least N messages are held on this machine (more may not be listed)." (or, with none listed, "Some held messages may not be listed: the record couldn't be read in full.") and `truncated` is set. `machines[].count` is `null` whenever a machine's count is unknown (it answered `off` or `unavailable`); `machines[].complete` is that machine's `heldComplete`, and the app shows an incomplete count as "At least N held". When any peer's count is a lower bound, the peer subtotal in the headline reads "at least N more on other machines." (or "At least N messages are held on other machines."). Whenever any machine did not answer, is offline, has a `null` count, or read zero rows from an incomplete record, the headline ends "Machines that did not answer or can't tell are not counted." The headline joins two independently built sentences: this machine's (as above, whatever its state) and, when peers hold any, the peers' ("N more on other machines." after a local held count, "N are held on other machines." after a local not-`ok` sentence, or "N messages are held on other machines." alone when this machine is `ok` with nothing held). `footerLine` is a fixed sentence: the who-wrote-this footer is changed in the console.

The "never returned" list is about structured fields. Messages carry no free text except verified conversation names (which the bearer already reads from `/telegram/topics`). Insight text is free text: they are cleaned, scrubbed and capped, and shown as the console shows them; like the console, they can mention something the owner can already see there.

Never returned from messages: operation ids, origin ids, topic ids, chat ids, message ids, account ids, profile ids, holder machine ids, deadlines, recovery internals, browser recovery state, detector health, storage paths, notices, metric counter names, payloads or any message text.

**MobileInsights.** `selfState`: `ok | off | unavailable` for this machine (`off` = no engine here, i.e. live insights dark (an engine that failed to construct is also null and reads `off`; its init failure is logged at boot); `unavailable` = the read threw). `state`, by this table: `ok` when this machine or any peer answered `ok` (pages from every source that answered are kept, even when others failed); `off` when this machine is `off`, every peer read answered `off`, and nothing was unread or offline; otherwise `unavailable`. `headline`: off → "Insights are not turned on for this agent."; unavailable → "Can't read insights right now."; ok → "N pages have something to say." or "No pages have insights to show yet.", each scoped "(on the machines that answered)" when anything was unread or offline or this machine's own read failed. The app shows the headline and a machines note above the pages, so partial and total failure are visible without any page row. `pages: [{ key (rowKey of machine and page id), title, headline, sourceWords, asOf, stale, lines: [{ text, severity, action }], metrics: [{ label, value, trend }], machine }]`. `severity` is `info | watch | alert` (anything else → `info`); `trend` is `up | down | flat` or null; `sourceWords`: llm → "AI summary" (cached → "AI summary, saved"), deterministic → "Plain summary", paused → "Paused: this page's data couldn't be read", empty → "No data yet", anything else → "Summary". Caps: 40 pages (`truncated`), 5 lines and 8 metrics per page; text capped (title 80, headline 280, line 280, action 200, metric label 80, value 40). `stale` is the engine's own flag: that page's data could not be read (the strip is "Paused"); it is not an age. `asOf` is the engine's data time for that page. Pages are in the engine's order, this machine's first, then each peer's, each peer page naming its machine. `truncated` is set when pages were capped here or any peer's own answer was truncated; capping lines and metrics per page is silent (the console shows at most 3 lines and the engine emits a small fixed metric set). Never returned: the `tab` deep link, the page id, `cacheHit` as a field (it only picks the words), machine ids.

All shown text passes `cleanText` (normalized, control and bidi characters removed, `scrubSecrets`, whitespace folded, capped). Insight text is LLM output over page data that can include peer-authored rows; it is display-only data, never instructions, for the phone and for any agent reading these routes with the bearer token. SwiftUI renders it as plain text.

**No LLM spend from the phone.** `getAll({ cachedOnly: true })` is a new engine option: for each page it serves the cached AI summary when one is fresh for the current data, otherwise the deterministic floor, and never starts an LLM call. A phone refresh (here or proxied to a peer) therefore costs no model call; AI summaries appear on the phone when the console has generated them.

**Peers.** Online peers come from `resolvePeerUrls` filtered by the pool registry's `online` (the plans-people helper), at most 16 per answer (the same ceiling `forwardRevoke` uses; any beyond are counted in `unread`). Each peer read uses `poolPeerFetch` with the agent token and a 5 s timeout that covers reading the body; the body is read incrementally and the read is cancelled once it passes 500,000 bytes (the peer then counts as not answering), so one answer never buffers more than 16 × 500,000 bytes of peer bodies. A peer that answers anything but 200 with the expected shape (an older peer without the route answers 404) is counted in `unread` (named by verified nickname); a peer's own `off` state is its answer, not unread. Registered machines the pool does not count as online are counted in `offline`. For Messages the qualifier is defined above;  the Insights headline is scoped as above; both answers carry `unread` and `offline` for the app's machines note.

**Observability.** A read that fails answers `500` with a fixed code (`messages-unavailable`, `insights-unavailable`) and records one `MobilePhonesMessages.read` degradation (route and error class only) through `DegradationReporter`. A part that fails inside an answer becomes that part's `unavailable` state and is reported the same way.

The 15 s single-flight cache is keyed by route and scope only, shared by bearer and owner callers, whose answers are identical.

### 3.2 Who may read them

Two entries are added to `DEVICE_ALLOWLIST`: `GET /mobile/messages` and `GET /mobile/insights`, each `statuses: active`, `body: 'none'`, `ownerOnly: true`, sharing one bucket of their own (`phones-messages-reads`, 20 per minute for both together). Inside each route `ownerOrBearer(req, bearerOk)` admits only the bearer token (checked explicitly) or a device whose person resolves to role `owner`; everything else gets `403 owner-phone-required`. Earlier layers answer first, unchanged (MSP device refused at the device layer, unknown person `403 person-unknown`, notify token `403 notify-token-not-allowed`, revoked/pending/unsigned/replayed/tampered `401 device-unauthorized`). Every answer carries `Cache-Control: no-store`. The raw routes (`/telegram/origins/status`, `/telegram/origins`, `/telegram/origin-display`, `/insights`, `/insights/:page`) stay off the allowlist. Answers are cached single-flight for 15 s per route.

**Why the bearer may read `/mobile/messages` although it cannot read `/telegram/origins/status`.** The operator-session gate on the raw route protects the audit records (origin ids, chat and message ids, accounts, browser state). The summary carries none of those: it is counts, hold-reason words, conversation names and readiness words. The bearer already reads, from `/health` `telegramOrigin.heldForward`, the count, reply/automatic split, conversation ids and oldest time of held **forwards** (lease holds), and the conversation names from `/telegram/topics`. New to the bearer: the count, grouping and fixed reason words of every other held send, the expired count, the confirmed/unconfirmed send counts, and the recording-readiness items (fixed obligation, state and reason words only). These describe delivery health, not content; sessions holding the bearer can use them to tell the operator why a reply is late. Recorded as Frontloaded Decision 6.

### 3.3 Removing another phone from an owner phone

`POST /mobile/devices/:id/revoke` keeps every current rule and adds one: a device-signed request naming **another** device's id is accepted when the requesting device's record is `active` and its person resolves to role `owner` (the same check `ownerOrBearer` makes). The route reads the requester's status from `svc.devices.get(requesterId)` at request time (the allowlist also admits pending, declined and expired devices on this path, so the allowlist cannot be relied on) and its role from `devicePersonOf(req)` (null for a removed person). Then the revocation runs exactly as for the bearer on this machine (key-ledger row first, registry revoke, pending-confirm dropped, `featureEvidence` row with `by: 'device'` plus `requestedBy`: the requesting device's id). A device request never forwards to peers: a device not held on this machine answers `404 unknown-device`, as a device request does today. An MSP phone, a pending/declined/expired phone (owner or not), and a phone whose person was removed get `403 owner-phone-required` for another id (an old server answers `403 a device may only revoke itself`, which lets the app tell the two apart). Self-revoke is unchanged. On the server an owner phone may remove a pending phone too (as the bearer can); the app offers Remove only on active rows, as the console does. Removing the phone that signed the console in leaves that console session to expire on its own schedule, as with a bearer removal.

This matches the console: the owner removes any phone on this machine from the Phones panel with the bearer and no PIN. The allowlist rule is unchanged (its statuses already admit the self-revoke of a pending phone); the owner check is in the route.

### 3.4 The app

Three SwiftUI screens in `apps/instar-ios` (agent home), in new files `PhonesMessagesData.swift` (parsing, unit-tested) and `PhonesMessagesViews.swift`, opened from a new "Phones and messages" section on the agent's detail screen:

- **Phones**: reads `GET /mobile/devices`; shows active and waiting phones (as the console does), each with name, person, "Paired since <date>" or "Waiting to confirm", and "This phone" on the row whose id equals this app's device id. Each active row has "Remove". Removing another phone asks for confirmation ("Remove <name>? It will stop reaching this agent at once."). Removing this phone shows a stronger warning ("This is the phone you're using. Removing it signs this app out of <agent> at once, and you'll need to pair again to use it.") with a destructive "Remove this phone" button; after success the app forgets that agent. A `403 owner-phone-required` reads "Only the owner's phone can remove other phones."; `403 person-unknown` reads the same; the older server's own refusal (`403 a device may only revoke itself`) reads "This agent's server only lets a phone remove itself. Update the agent to remove other phones from here." Older servers keep the list.
- **Messages to you**: headline, the held groups (each naming its machine when not this one), expired and unconfirmed lines, the per-machine list, the recording items not ready, a note when anything was capped or a machine did not answer, and the footer line.
- **Insights**: the headline and a note naming machines that did not answer or are offline, then one section per page: headline, source and time, the lines with a coloured dot by severity and the next step, and the metrics.

Pull to refresh; no background polling. `403 device-not-allowed` or `404` → "This agent's server is too old to show this here. Update the agent to see this here." (`device-not-allowed` means no allowlist rule matches the path: on a current server an MSP phone gets `owner-phone-required` from the `ownerOnly` rule instead, so the two are distinct; the integration test checks the MSP case.) `403 owner-phone-required` / `person-unknown` → "Only the owner's phone can see this." Parsing tests are listed in `project.yml`'s test target.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Device allowlist admits the two GET paths for active owner devices | invariant | Route-level authentication by exact path, the existing deterministic device model; no competing signals. |
| `ownerOrBearer`: bearer or owner-role device only | invariant | Authorization from the authenticated principal's resolved role (Know Your Principal); fails closed for unresolved people. |
| Revoke route: an active owner-role device may revoke another device held on this machine | invariant | Authorization from the authenticated principal's record status and resolved role; the same principal check as the owner-only reads; fails closed (anything else keeps the existing self-only refusal). |
| The bearer may read `/mobile/messages` although the raw origin routes need an operator session | invariant | A fixed field allow-list (counts, fixed reason, obligation and state words, verified conversation names); no audit record field crosses. Recorded as Frontloaded Decision 6; the raw routes keep their gate. |
| Field allow-list in each summarizer | invariant | A fixed redaction contract: only listed fields leave the server. |
| Grouping of held sends, hold-reason words, insight source words | invariant | Display classification copied from the console's documented rules; gates nothing. |

## Verify the state, not its symbol

No detector, gate on agent behaviour, or LLM judgment is added. The display states:

- Held count: symbol = the origin store's held rows (`deliverySummaryInputs().held`, the same rows `status().held` lists; the durable read is bounded at 200 rows, as in the console). State claimed = replies the agent prepared that have not reached Telegram. Corroboration = the same rows the console's PIN-gated page lists, and `/health`'s held-forward refresh. Unmeasurable: status unreadable → `unavailable` with the `/health` count when readable, else "Can't tell how many messages are held" (never "No messages are held").
- Recording readiness: symbol = `activation.observations`. Unmeasurable: an observation in state `unknown` is listed as not ready with its reason words, never as ready.
- Peer held counts: symbol = each peer's own summary (its held rows, the same symbol as this machine's). A peer that did not answer is in `unread`; a peer that answered `unavailable` or `off` is listed as "can't tell" with a `null` count; neither is counted as zero, and either qualifies the headline. A held read that failed or filled its page makes the count a lower bound, said in the headline.
- No-detail fallback: symbol = `heldForward` (held forwards only, last refresh). It is worded as forwards only, never as the total held.
- Expired count: symbol = `heldForward.expiredUnreported` + `expiredHolds.totalSinceBoot`. A missing counter reads 0 (the console's rule); the line appears only when the count is above zero, so an unreadable counter can hide expiries but never invent them. Unconfirmed line: shown only when both counters are present and non-zero; otherwise absent, never "all confirmed".
- Insight lines: symbol = the engine's output, labelled by `sourceWords` (AI, plain, paused, no data) and `asOf`. Unmeasurable: a page whose data could not be read is "Paused", never a fabricated summary (the engine's own rule).
- Phone list: symbol = the device registry rows; "This phone" = id equality with the app's own stored device id.

## Maturation plan

No flag, by design: the reads are read-only and return a subset of what the owner already reads in the console, the revoke change gives an owner phone what the console's Phones panel already gives the owner, and a revert is the whole rollback. The ladder below is a set of post-ship checks, not a gate.

- **test-agent-live:** the unit, integration and e2e tests in §6 on a real server boot: a phone paired through redeem/confirm reads both routes (200), the raw routes stay 403 for it, and an owner phone removes a second phone. The app screens are checked in the simulator with seeded answers (screenshots).
- **dev-agent-live:** after release, Echo drives the three screens in the simulator app paired to Echo's own server (a device of Echo's, not the operator's phone), including removing a second throwaway phone, and records PASS/FAIL per screen. Tracked as an Echo commitment opened with the PR.
- **fleet:** the routes ride `mobilePairing.enabled` (device headers authenticate nothing when it is off; the bearer path works regardless).
- **graduation criterion:** one week after release, the `MobilePhonesMessages.read` degradation count is zero or matches console read failures in the same window, and the dev-agent-live record shows every screen passing.
- **dark-window:** none: the routes are live on release (no flag).
- **ladder:** mobilePairing

## Open questions

*(none)*

## Frontloaded Decisions

1. Purpose-built trimmed routes instead of allowlisting the raw routes (same as #2706, #2712, #2725). The raw origin routes keep their operator-session gate.
2. Messages and Insights are read-only. The footer settings stay editable only in the console (they are a config write under an operator session); the app says so in one line.
3. Owner phones only for the reads; MSP phones refused (people-and-roles owner-only default).
4. Removing another phone is allowed for an active owner phone on this machine only; no forwarding to peers from a device request (the phone lists this machine's phones, as the console does).
5. Removing this phone is allowed (unchanged server rule) behind a stronger warning in the app, which then forgets the agent.
6. The bearer may read both summaries (§3.2 records why this is acceptable for messages).
7. Insights include peers' pages (proxied-on-read), read cached-only: the phone shows an AI summary only when the console already generated one, otherwise the plain summary. No phone read spends on a model.
8. Row caps: 50 held groups and 30 readiness items (one `truncated` flag on the messages answer), 40 insight pages (`truncated` on the insights answer), 5 lines and 8 metrics per page (silent; above what the engine emits). When a `truncated` flag is set the app says "Some items are not shown here." (Contested as user-visible; decided here rather than tagged cheap.)
9. Removing another phone from a non-owner phone answers `403 owner-phone-required`, distinct from the old server's text, so the app can say which applies.

## 4. Security

- Widened device-key access: two read-only GET paths for owner phones, each a subset of what the owner reads in the console; and an owner phone may remove another phone on this machine, which the owner can already do from the console without a PIN. A stolen owner phone could remove the owner's other phones: that is a new credential-removal capability for a device, granted deliberately because the owner already has it in the console without a PIN. Its harm is bounded (a removed phone re-pairs), every removal records the requesting device in `featureEvidence` and the key ledger, and the stolen phone is itself removed the same way. Re-pairing restores a removed phone.
- No structured id, path, account, chat or message id, payload, raw error or config field is returned. Owner-visible free text is shown as the console shows it, passed through `cleanText`.
- Raw routes stay off the allowlist (tests on both sides). MSP, unresolved-person, notify-token, revoked, unsigned, replayed and tampered requests are refused (tests on both sides). A POST to the read paths is refused by the device check.
- Fan-out: each route reads at most 16 online peers at most once per 15 s behind the routes' shared 20-per-minute device bucket; peer reads time out at 5 s and count as `unread`; a peer's `?scope=local` answer never reads further peers.
- Spend: phone reads never start an LLM call (`cachedOnly`), here or on a peer.

## 5. Multi-machine posture

- Peer reads use the existing pool peer transport (`poolPeerFetch`, the same path and agent token the plans-people fan-outs use). Peer bodies are read up to 500,000 bytes (§3.1).
- Messages: **proxied-on-read**: this machine's summary plus each online peer's `GET /mobile/messages?scope=local`, each group naming its machine and each machine listed with its own state.
- Insights: **proxied-on-read**: this machine's engine (cached-only) plus each online peer's `GET /mobile/insights?scope=local`, each page naming its machine.
- Phones: the device list and removal are this machine's. machine-local-justification: physical-credential-locality — a phone's device record and key verify only on the machine it paired with; the app talks to that machine. The bearer path keeps its existing peer forwarding.
- No new durable state, no user-facing notices, no generated URLs.

## 6. Tests

- **Unit** (`tests/unit/mobile-native-phones-messages.test.ts`, plus engine `cachedOnly` cases: a fresh cache entry is served, a missing one serves the floor, and the LLM provider is never called; a truncated peer whose groups fit under the merged cap still marks the merged answer truncated; the same cause on two machines gives two distinct keys): `summarizeMessages` grouping (named conversations distinct, unnamed by cause, counts and oldest), the reply/automatic headline split and its fallback, expired and unconfirmed lines, readiness not-ready items, unknown reason words, an id-shaped or placeholder title refused, not-ok state with and without `/health` counts, peer counts and unread, caps, never ids; `summarizeInsights` source words, severity and trend clamping, caps, peer pages named, peer off vs unread, the `tab` and page id never returned, a planted credential scrubbed; the allowlist has exactly GET for the two paths, owner-only, own bucket, and none of the raw routes; the owner-only named set in `tests/unit/mobile-session-terminal.test.ts` gains the two.
- **Integration** (`tests/integration/mobile-native-phones-messages.test.ts`, production `authMiddleware` + `deviceAuthenticator`): owner phone served and trimmed (planted ids and a credential never appear), bearer served; MSP 403, demoted owner 403, removed person 403 `person-unknown`, revoked 401, unsigned 401, tampered 401, no credentials 401, notify token 403, POST 403, bucket 429. Revoke (`tests/integration/mobile-pairing-routes.test.ts`, updated): an owner phone removes another phone; an MSP phone and a pending phone cannot; a device naming an id not held here gets 404 without forwarding; self-revoke still works.
- Unit: `deliverySummaryInputs()` returns exactly the `held`, `heldForward`, `expiredHolds`, `activation` and `metrics` values `status()` returns for the same runtime.
- **E2E** (`tests/e2e/mobile-native-phones-messages-alive.test.ts`): AgentServer production boot, phone paired via redeem/confirm, both routes 200 for that phone (insights `off` or `ok` matching `/insights`), raw routes 403 for the phone, bearer reads the summaries, the phone lists devices and removes a second paired phone, which is then refused.

## 7. Agent awareness and migration parity

- `generateClaudeMd()` gains one bullet in the Mobile app routes block (after the plans-people bullet) naming the two routes and the owner-phone removal.
- `migrateClaudeMd()` inserts the same bullet after the plans-people bullet under a content-sniff guard on `GET /mobile/messages` (idempotent); a block without that bullet gets the line appended.
- `CapabilityIndex` gets a `mobilePhonesMessagesScreens` entry listing the two endpoints (no new prefix).
- No config defaults, hooks or skills change.

## 8. Rollback

Revert the commit. The routes disappear and the app shows "update the agent to see this here"; removing another phone returns to `403 a device may only revoke itself`, which the app explains. No data is written by the reads; a phone removed while the change was live stays removed (re-pair to restore).
