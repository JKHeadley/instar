---
title: "Message origin on every platform: Telegram, Slack and native app conversations"
slug: "message-origin-all-platforms"
author: "Echo"
parent-principle: "Telegram Message Origin Is Mandatory; Its Display Is Optional"
parent-spec: "docs/specs/telegram-message-origin.md"
eli16-overview: "docs/specs/message-origin-all-platforms.eli16.md"
source-topic: "operator request, 2026-11-03 12:10 PST"
status: "approved for implementation"
approved: true
approval-source: "Justin, 2026-11-03 12:10 PST operator request (verbatim in Problem statement): the goal is his; this design implements it without new authority beyond the Slack refusal his \"ALWAYS required to be recorded\" asks for, with an operator-set exception. Not covered and not approved here: WhatsApp/iMessage (ACT-023), the app display and toggle (ACT-179), the constitution wording change."
review-convergence: "2026-11-03T20:53:33.988Z"
review-iterations: 3
review-completed-at: "2026-11-03T20:53:33.988Z"
review-report: "docs/specs/reports/message-origin-all-platforms-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Message origin on every platform

## Problem statement

Justin (2026-11-03 12:10 PST): "agent messages should show which machine, harness/door (Claude code, codex, native Instar, etc), and model that generated each message. This should be on by default and the user should be able to hide it in an app configuration screen ... OR they should be able to just ask the agent to change it. Regardless this metadata should ALWAYS be required to be recorded with every message sent to the user for any platform (telegram, slack, native, etc)."

What exists today (verified in source, `src/messaging/telegram-origin/`):

- **Telegram** records, for every bot send, a signed origin record before the message leaves (`TelegramOriginService.prepareBot`). The record carries `machine`, `harness` and `model`, each an `OriginEvidence` `{value, status: observed|configured|unknown|not-applicable, sourceEventRef, observedAt, reason}`. For a session reply the evidence comes from the session's origin credential (`X-Instar-Origin-Session`, issued at spawn by `OriginSessionRegistry`) and the runtime observer (`RuntimeOriginObserver`, which reads the session's transcript for the model). A recording failure holds the message. A footer (`originFooter`) shows the evidence in the Telegram text; `messageOrigin.display` (machine/harness/model bits, default on) and the topic-profile field `messageOriginDisplay` hide it per agent or per topic.
- **Native app conversations** (`POST /app/session-reply`, `app-reply.sh`): the reply is appended to the app conversation store. Nothing records which machine, harness or model wrote it.
- **Slack** (`/slack/session-reply`, `/slack/reply/:channelId`, `slack-reply.sh`, and every other `SlackAdapter` send): nothing records origin.
- **Phone history reads** (`GET /mobile/chat/app/:key/messages`, `GET /mobile/chat/slack/:id/messages`, a device's read of `GET /telegram/topics/:id/messages`) return no origin on agent rows, so the app cannot show it, and no read tells the app what the agent's display setting is.

## Proposed design

### 1. One evidence model, reused

`src/messaging/messageOrigin.ts` (new, platform-neutral):

- `MessageOriginEvidence` v1: `{ v: 1, producerKind: 'session' | 'server-automation' | 'unknown', machineId, machine, harness, harnessName, model, recordedAt }`. `machine`, `harness`, `model` are the existing `OriginEvidence` type, unchanged. `machine.value` is the machine's display name (`machineEvidence`: the identity registry's nickname, which by default is derived from the hostname and is renameable; a registry fallback of the form `Machine <id prefix>` is an id, so it reads `unknown`).
- `originEvidenceFromProducer(producer)` maps an existing `TelegramOriginProducer` to this shape. Nothing is re-derived. `sourceEventRef` values are not copied (they can name transcript events); each becomes a coarse label (`machine-identity`, `session-credential`, `session-launch`) or null, so a replicated record carries no session or transcript reference.
- `validateMessageOriginEvidence`: strict and bounded (closed key set, closed status set, printable single-line strings with length caps, a known value only with `observed`/`configured`). It runs on every record read from disk or received from another machine; an invalid record is treated as absent.
- `deviceOriginRow(evidence | null, display, reason)`: the phone row (§4).

No second recorder is invented: Telegram keeps its store; app and Slack store the same evidence beside their own message records.

### 2. Where the evidence comes from

One helper, `resolveReplyOrigin`, used by `/app/session-reply` and both Slack reply routes. The **session** is identified by the conversation bind token, which these routes already verify (`verifyConversationBind` returns `boundBy: session:<tmuxName>` from a MAC-checked token), never by a header a caller can choose.

When the route has a bind gate but the verdict carries no `boundBy` (bind auth not constructed), rung 1 cannot be matched to a session and rung 2 has no session to read, so the reply records rung 3.

1. **Origin credential matches the bound session.** (The credential lookup is bounded to 1.5 s; a slower or failing lookup falls to rung 2. The ladder never throws: any error records rung 3.) If `X-Instar-Origin-Session` verifies (existing `OriginSessionRegistry`) AND its binding's session is the bound session (the state record for `binding.sessionId` has `tmuxSession === tmuxName`), the producer comes from a new `TelegramOriginService.sessionProducer(token)` (the body of `runWithSessionToken`, lifted out so both share it). Harness `observed`, model from `RuntimeOriginObserver` exactly as for Telegram. Any throw from it (`origin-observer-not-bound`, `session-no-longer-authorized`, a credential for another session) falls to rung 2 and is never a refusal.
2. **The bound session's launch record.** The running state record whose `tmuxSession` is the bound name. Harness = its launch framework (a legacy record with none reads `unknown`, reason `session-framework-unrecorded`), model = its launch model when that is a concrete model id (not one of the tier words `fast`, `balanced`, `capable`, `default`, `escalated`, `opus`, `sonnet`, `haiku`; otherwise `unknown`, reason `session-model-is-a-tier`), both status `configured`, `sourceEventRef: "session-launch"` (a bare label, never the session id, because the record replicates), reason `session-launch-record`. This is what makes a Slack-only or app-only agent useful: the origin runtime boots only where Telegram is configured.
3. **Neither:** harness and model `unknown`, reason `no-session-evidence`, `producerKind: 'unknown'`.

`/slack/reply/:channelId` (the legacy raw-destination route, no bind token) uses rung 1 only when the credential verifies, else rung 3. A header naming a session is never accepted as evidence.

Machine is always `observed`: it is the recording server's own identity. Server sends outside a reply route (sentinel notices, presence lines, the app's "📱 … (from the app)" mirror and its file uploads) are `server-automation` with harness and model `unknown`, reason `unbound-author-call`, matching Telegram's `runAsUnboundAutomation`.

`app-reply.sh` and `slack-reply.sh` add the `X-Instar-Origin-Session` header exactly as `telegram-reply.sh` does (including its `ior1_`-prefix-checked refresh from the tmux environment after a server restart). Like the bind and API tokens they already send, it travels on curl's command line; no new exposure class.

### 3. Where it is recorded (in the send path)

**App conversations.** The agent `message` / `media-message` event gains `agentOrigin: MessageOriginEvidence`, written in the same `app.store.append` as the reply, so a reply cannot be stored without its origin. `validateAppEvent` keeps the field only on `role: 'agent'` events, only when it validates, and only when `agentOrigin.machineId` equals the event's `machineId`. The field rides the existing store replication. (The existing `origin` field on operator events is the phone's signature and is untouched; the new field has a different name on purpose.) The field is information: nothing reads it to decide anything.

**Slack.** A ledger, `SlackOriginLedger` (`<stateDir>/state/slack-origins.jsonl`, mode 0600, not in the backup include list, under the git-ignored state directory), written at the adapter's outbound chokepoints:

- `SlackAdapter.formattedApiCall` for `chat.postMessage`, `chat.postEphemeral` and `chat.update`, and `FileHandler.uploadFile` for `files.completeUploadExternal`. (`SlackLiveSender`, the live-test harness, posts as a separate test identity, not as the agent, and is out of scope.)
- Before the API call: an intent row `{v:1, kind:'intent', id, method, channel, threadTs, origin, at}`, appended and fsynced. After Slack accepts: a receipt row `{v:1, kind:'receipt', id, ts}` (an upload or an ephemeral has no message `ts` and gets a receipt without one).
- The evidence comes from an `AsyncLocalStorage` scope the reply route opens around **only** its adapter send call, bound to the reply's own channel and thread, and admitting exactly one call (the reply route makes one `chat.postMessage`). A second call inside the scope, a call to any other target, or any call with no scope is recorded as server-automation.
- **Refusal (decision point).** Every Slack send needs its intent row. If the append fails, the call is refused before it reaches Slack (`SlackOriginRecordingError`), for session and automation sends alike, because the operator's rule is "always recorded". Only an I/O failure refuses: evidence that does not validate is recorded as `unknown`, never a refusal.
- **Ledger unavailable.** If the file cannot be opened or appended, the ledger is `unavailable`: sends are refused and reported, and each later send retries the write (at most one retry per 5 s), so nothing is latched off for the life of the server and recovery needs no restart. Opening or rebuilding never throws to the adapter or the server: an unreadable or torn line is skipped.
- **Pre-recorded reachability notice.** Each time an intent is written for a conversation (channel + thread) that has no reserve in this process incarnation, the ledger also writes one reserve row bound to that conversation, carrying deterministic-automation evidence for one fixed text: "A message to this conversation was not sent because I could not record which machine and model wrote it. Ask me again if you were expecting a reply." When a `chat.postMessage` to that conversation is refused, the adapter spends that reserve, at most once per incarnation and at most once per conversation per 15 minutes, to send the fixed text there; its receipt carries the channel and the reserve id. Reserves written by an earlier incarnation are never reused. The notice path takes no caller text and never triggers another notice. A refused `chat.postEphemeral`, `chat.update` or file share sends no notice (a notice would publish an ephemeral refusal, an edit was not "a message not sent", and a refused share already reports `mirror: "failed"` to the phone that sent it). With no reserve for that conversation the refusal is silent in Slack and reported (`SlackAdapter.originNotice`). - The reply route answers `503 {error: "origin-recording-unavailable", notSent: true}` (an explicit branch ahead of its generic 500), `slack-reply.sh` prints `NOT SENT`, and the adapter reports `SlackAdapter.originRecording` through `DegradationReporter`. The notice does not call `onMessageLogged`, so it never cancels the presence standby as if it were an answer.
- Off switch, read live: top-level `messageOrigin.recording.slackFailClosed: false`, an operator exception under which a failed append is reported and the send proceeds unrecorded. The agent sets it only on a verified operator's instruction, never on its own initiative; the CLAUDE.md text says so.
- A receipt write failure is reported (the message already left); its history row reads `recorded: null`, reason `unlinked`.
- Posts and revisions are kept apart: the index maps `(channel, ts)` to the evidence of the post that created that message; an edit (`chat.update`) is recorded as a revision row and never replaces the creation evidence.
- Receipts are self-contained (channel, thread, method, `ts` and the evidence), so the index never depends on an intent row. The index has one rule, used both live and at boot: the receipts in the retained files. Rotation (at 8 MiB, to one `.1` generation) is synchronous with appends in one process and is followed by a rebuild from the retained files, so the live index after rotation equals the index a restart would build, and evidence that left retention leaves the live index too. Unreceipted intents are kept for `unlinked` detection by the same rule. `coversSince` is the oldest retained intent time (null before the first intent); history compares it with the time inside the Slack `ts`.

Recording failure policy across platforms: Telegram holds (existing, unchanged); app records in the same write as the reply (no reply without origin); Slack refuses any send it cannot record and keeps the agent reachable with the pre-recorded notice.

**Telegram.** Unchanged.

**WhatsApp and iMessage.** Not covered by this change. Neither is visible in the Instar app, and each has its own reply route and script; covering them is the same pattern (chokepoint ledger + reply-route scope), tracked as ACT-023 (due 2026-11-17).

### 4. What the phone receives

Every agent row of the three device history reads carries exactly:

```json
"origin": {
  "recorded": true,
  "machine": { "value": "Mac Studio", "status": "observed" },
  "harness": { "value": "Claude Code", "id": "claude-code", "status": "observed" },
  "model":   { "value": "claude-opus-5-5", "status": "observed" },
  "display": { "enabled": true, "machine": true, "harness": true, "model": true }
}
```

`recorded` has three values; only `true` and `false` are claims:

- `true`: a record was found and validated.
- `false` (`reason: "not-recorded"`): this machine wrote the message and holds no record for it (an app event written by this machine before this change).
- `null`: this machine cannot tell. Reasons: `other-machine` (written by or held on another machine: an app event from another machine with no record, which an older peer may have dropped; a Slack message not in this machine's ledger, since the Slack connection moves with the serving lease), `not-found` (a Telegram message with no record in this machine's store: sent by another machine, or before origin recording existed), `not-retained` (older than the oldest retained Slack record, or a Telegram record that was archived), `lookup-timeout`, `lookup-failed` (the store answered with an error), `ambiguous` (two records for one message), `unlinked` (a Slack send whose receipt failed: an unreceipted intent for the same channel within 60 s of the row).

When `recorded` is not `true`, every `value` is `null` and every `status` is `unknown`. `status` is passed through, so the app labels `configured` and `unknown` honestly. `display` is this machine's **current** effective setting (§5), always rebuilt locally, never passed through from a peer. Never included: tokens, session ids, source refs, paths, digests, channel ids.

Joins:

- **App:** from `agentOrigin`. A pool read's peer rows pass their `origin` through `validateDeviceOriginRow`; a peer row without one reads `null`, `other-machine`.
- **Slack:** the ledger index by `(channel, ts)`. A miss reads `null` (`not-retained` when the row is older than `coversSince` or `coversSince` is null, otherwise `other-machine`); Slack rows never read `false`.
- **Telegram:** a new batched read-only store method, `lookupOriginEvidence({transport: 'bot-api', chatId, messageIds})`, one worker call per page, served by a new index `telegram_origin_platform_receipts(transport, chat_id, message_id, origin_id)` (created idempotently at store open), so each page is an index lookup on at most 100 keys, returning only the producer evidence parsed from each matching record's envelope (no attempts, no children, no archive reads). The chat is the agent's main chat, or the issues chat with the real thread id for an issues topic. A call is bounded to 750 ms; on timeout the rows read `null`, `lookup-timeout`, and on a store error `lookup-failed`; with no origin store on this machine they read `not-found`. A miss reads `null`, `not-found` (the Telegram store is per machine, and messages from before origin recording have none). Device reads always join; Bearer reads join only with `includeOrigin=1`, which the pool fan-out sets, so peers answer with their own joins; on a pool key collision the row whose origin is `recorded: true` keeps its origin.

### 5. The setting

- **Agent default:** the existing `messageOrigin.display` on the single enabled Telegram messaging entry when there is one; otherwise a top-level `messageOrigin.display` with the same four bits. Absent means all on. One resolver (`agentDisplaySetting`) is used by the history reads, the Slack footer and the dashboard route, read live through `LiveConfig`.
- **Asking the agent:** the agent changes the agent default the way it already does for Telegram, by setting those bits in its own `.instar/config.json`; `LiveConfig` picks the change up without a restart. No new route or authority.
- **Per conversation:** Telegram topics keep the existing topic-profile `messageOriginDisplay` override. App and Slack conversations use the agent default only (the topic-profile store and its agent write lane are Telegram-bound today). Asking the agent to hide origin in an app or Slack conversation therefore changes the agent default, which also hides the Telegram footer; the CLAUDE.md text says so.
- **The phone's own toggle** hides origin on that phone only (not the Telegram or Slack footers); a paired device cannot write the agent's settings. Building the app's display and toggle is app work, tracked as ACT-179 (due 2026-11-10).
- **Dashboard:** the existing display-settings route uses the same resolver: on an agent with no enabled Telegram entry it reads and writes the top-level setting (and updates the in-memory config), so its defaults section works everywhere.
- **Slack text:** a session reply through the reply route carries a one-line origin footer in Slack (`agent · machine · harness · model`, in italics), built from the `MessageOriginEvidence` by `slackOriginFooter` under the agent display bits. The labels are outgoing content under the parent's disclosure contract: they are operator-owned names (agent, machine nickname) and fixed harness and model ids that the operator can hide, and the composed footer passes the deterministic credential wall (`detectOutboundCredential`) before it is attached; a footer that trips it is dropped. It is not sent through the LLM tone review, which would read model ids as jargon in every reply. Every label is escaped for Slack mrkdwn (`&`, `<`, `>`, `*`, `_`, `~`, backtick) and appended as already-formatted mrkdwn whatever the formatter mode, so a nickname can never become a mention or formatting. A label that fails validation drops the footer; it never fails the send. The footer is added after the outbound review and is not part of the logged text, so the app's history shows the authored text plus the `origin` block. Automation notices carry no footer.

### 6. Health

The authenticated `/health` gains `messageOrigin: { app: {recorded}, slack: {intents, receipts, refused, intentFailures, receiptFailures, notices, noticeUnavailable, coversSince} | null }` counters since boot (`slack: null` when Slack is not configured).

### 7. Agent awareness and migration

- CLAUDE.md template (`generateClaudeMd` in `src/scaffold/templates.ts`): the message-origin section gains a paragraph on app and Slack recording, the device row and where the setting lives; `migrateClaudeMd` adds it to existing agents by content sniff.
- Relay scripts: `app-reply.sh` and `slack-reply.sh` change. Their installers' prior-shipped digest sets and the template SHA history the drift verifier checks gain the previous shipped digests, so existing copies are replaced on update.
- No config migration: absent settings mean "on" and "fail closed".

### 8. Tests and proof

- Unit: evidence validator (both sides of every field rule), ladder rungs, device row for each `recorded`/reason, display resolution, ledger intent/receipt/rotation/index/`coversSince`/unlinked, refusal in both session and automation scope on an injected write failure (pass-through only with `slackFailClosed: false`), recovery after the write works again, the reserved notice (sent once, not for ephemeral or update, not reused after restart, absent reserve reported), app event validation (operator row, machine mismatch, malformed).
- Integration, through the production device authenticator (`createRoutes` with a paired device): app reply records `agentOrigin` and the device read returns the exact row; Slack history row carries `origin`; Telegram device read joins through the store; a Bearer read without `includeOrigin` is unchanged; refusal answers 503 `notSent`.
- E2E alive: the production boot path serves the three reads with `origin` on agent rows (200, not 503).
- Live proof before claiming done: one app reply and one Slack reply from a real session, read back from the phone route.

## Maturation plan

- **test-agent-live:** a throwaway agent with Slack and app conversations: one app reply and one Slack reply from a real session, each read back from the phone routes with `recorded: true`; one injected unwritable ledger producing the 503, the fixed notice, and recovery on the next send after 5 s.
- **dev-agent-live:** Echo for one week: `GET /health` → `messageOrigin` shows intents equal to receipts plus refusals, `intentFailures` 0 on a healthy disk, and every app reply recorded; the app (once ACT-179 lands) shows the rows.
- **fleet:** ships on for every agent in the release (the operator asked for "on by default" and "always recorded"); the Slack refusal's operator exception (`messageOrigin.recording.slackFailClosed: false`) and a release revert are the levers.
- **graduation criterion:** one week on the development agent with no unexplained Slack refusal and no `unlinked` rows outside an injected failure; then the constitution wording change is put to Justin.
- **dark-window:** none. This is mandatory recording the operator asked to have on by default; nothing here ships dark.

## Decision points touched

- **Slack refusal when the origin intent cannot be written** — `invariant`. The operator's rule is that origin is always recorded; "no record, no send" mirrors the Telegram hold under the same standard; there is nothing to judge (the local append landed or not); reachability is kept by the pre-recorded notice; it is reported loudly; and its only exception is an operator-set switch.
- **Evidence ladder rung selection** — `invariant`. Each rung is a verifiable fact (credential verified for the bound session, a running launch record for the bound session, or neither); the result is labelled evidence, never a gate.
- **Display bits** — `invariant`. Presentation only: which labels are shown follows the operator's stated setting deterministically, and recording never depends on it.

## Not covered by this change

WhatsApp and iMessage recording (ACT-023) and the app's own display and phone-only hide toggle (ACT-179). An approval of this spec does not mean "every platform done".

## Relation to the parent standard

"Telegram Message Origin Is Mandatory; Its Display Is Optional" names Telegram. Justin's request extends the rule to every platform. This spec implements the extension in code and does not edit `docs/STANDARDS-REGISTRY.md`, because a constitution change is Justin's to approve. Proposed wording for him: retitle to "Message Origin Is Mandatory; Its Display Is Optional" and replace "every Telegram message" with "every message an agent sends to a user, on any platform".

## Frontloaded Decisions

1. Evidence shape: reuse `OriginEvidence`; add `MessageOriginEvidence` v1.
2. Session identity from the verified bind token; ladder = matching origin credential, then the bound session's launch record (`configured`), then unknown. No caller-chosen session header.
3. App storage: `agentOrigin` on the agent event in the same write, validated on read and replication.
4. Slack: chokepoint ledger for postMessage, postEphemeral, update and file uploads; every send needs its intent row; a refused send gets a pre-recorded reachability notice, a 503 on the reply route and a degradation report; an operator-set live off switch.
5. Unbound server sends: `server-automation`, unknown harness and model.
6. Device row: exact shape in §4, three-valued `recorded`, current local display.
7. Setting: Telegram entry when present, else top-level `messageOrigin.display`; Telegram topic overrides unchanged; app and Slack use the agent default.
8. Slack session replies get the origin footer under the same display bits; automation notices do not.
9. WhatsApp and iMessage are tracked separately (ACT-023), not covered here.
10. Telegram's store, footer and signing are unchanged apart from the new read-only batched lookup.

## Multi-machine posture

- App `agentOrigin`: replicated with the event (existing app store replication).
- Slack ledger: proxied-on-read through the machine that sent the message. Every Slack read already names the machine that lists the conversation (`machine` parameter, refused elsewhere with `wrong-machine`). The Slack connection moves with the serving lease, so a message another machine sent is honestly `null`, `other-machine`, on this one.
- Telegram: each machine's store; pool reads fan out with `includeOrigin=1` and merge per §4.

## Rollback

Revert the release. Recorded fields are additive: older code drops `agentOrigin` on read (the app store validator keeps known fields only) and never reads the Slack ledger. The Slack refusal alone can be turned off live with `messageOrigin.recording.slackFailClosed: false`. No state repair.

## Open questions

*(none)*
