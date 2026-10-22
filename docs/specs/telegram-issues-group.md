---
title: Telegram issues group — bug topics in their own "<agent> Bugs" group
date: 2026-10-22
author: echo
parent-principle: "Bounded Notification Surface"
parent-principle-fit: "Issue topics spun off by the triage rule (blocks → fix now; major → own topic + session; else → feedback queue) were cluttering the operator's main topic list. Moving them to a second, optional forum group keeps the main list for conversations without losing a single issue thread."
eli16-overview: telegram-issues-group.eli16.md
approved: true
approved-by: echo
approved-via: "Justin's request in topic 127831 (2026-10-22 09:14 PDT) is the mandate; per his standing rule (2026-10-22 08:58, topic 127831) only constitution changes need his approval, and this spec changes no constitution file."
review-convergence: "2026-10-22T16:30:05.615Z"
review-iterations: 2
review-completed-at: "2026-10-22T16:30:05.615Z"
review-report: "docs/specs/reports/telegram-issues-group-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Telegram issues group

## Problem

Justin (topic 127831, 2026-10-22 09:14 PDT): "maybe it would be a good practice to
separate these 'bug' topics from our other topics to prevent them from cluttering up
the UI? Could we make the default standard to put them in their own dedicated
telegram group? Something like <agent> Bugs (in our case: 'Echo Bugs')?"

The Telegram adapter is built around ONE forum group (`messaging[telegram].config.chatId`).
Telegram topic ids (`message_thread_id`) are only unique inside one group, and every
layer above the adapter (topic→session map, commitments, relay script, history files,
origin records) keys on a bare topic number.

## Design (smallest version)

### 1. One optional config field

`messaging[telegram].config.issuesChatId?: string` — the numeric id of a second forum
supergroup (e.g. "Echo Bugs"). Absent → every code path below is a strict no-op.

### 2. A disjoint topic-number range (no change above the adapter)

Topics in the issues group get an internal topic id of
`ISSUES_TOPIC_OFFSET + message_thread_id`, with `ISSUES_TOPIC_OFFSET = 10_000_000_000`.
Telegram message ids are signed 32-bit (< 2^31 ≈ 2.1e9), so the range can never
collide with a main-group topic, and stays a safe positive integer
(< `Number.MAX_SAFE_INTEGER`). Negative ids are already taken by minted Slack
conversation ids, so they are not used. The issues group's General topic maps to
`OFFSET + 1`.

Everything above the Telegram edge (sessions, commitments, `telegram-reply.sh N`,
JSONL history, topic names) keeps working on one number, unchanged.

One new module, `src/messaging/telegramTopicSpace.ts`, owns the mapping:

- `inboundTopicId(chatId, threadId, cfg)` → internal topic id.
- `normalizeInboundThread(msg, cfg)` → rewrites `msg.message_thread_id` in place for a
  message (or a callback's message) from the issues group. Called once at each
  inbound entry point.
- `toWireParams(params, cfg)` → for an outbound Bot API call whose `chat_id` is the
  main chat and whose `message_thread_id` is in the issues range: set `chat_id` to the
  issues chat, subtract the offset, and omit `message_thread_id` for General; the same
  subtraction applies to a `reply_to_message_id` in the range (the topic-name probe
  replies to the topic's creation message).
- `isIssuesTopicId(id)`.

### 3. The translation points (the Telegram edges)

One function, `toWireParams`, does all outbound translation. It is **idempotent**: it
only acts when `chat_id` is the MAIN chat and `message_thread_id` is in the issues
range, and after it acts `chat_id` is the issues chat, so a second pass is a no-op.
Likewise `normalizeInboundThread` only maps a raw Telegram value (`< OFFSET`) from the
issues chat; a value already in range is left alone. Applying either twice can never
add the offset twice.

There is no process-wide state: each caller passes its own config. The adapter and the
lifeline use their Telegram config (fixed at construction; a change applies at
restart). The origin layer uses its live config snapshot (refreshed every few seconds),
which matters because origin preparation runs at boot before the adapter exists
(legacy-queue import). If the field is removed while running, the adapter still
translates until restart and the origin layer's `authorize` then refuses the issues
chat, so those sends are held (a recoverable hold), never misrouted.

Outbound (applied at every point a Bot API request is built or sealed):

| Point | Why it is needed |
|---|---|
| `TelegramAdapter.apiCall` | every adapter send, typing indicator, topic op |
| `TelegramLifeline.apiCall` | the lifeline's own notices and typing indicator back into the topic the user wrote in |
| `TelegramOriginService.prepareBot` (new `wireParams` option, from the boot snapshot) | requests sealed into origin records: the forward-to-lease-holder path, held-reply notices, mesh relay (`OriginMeshRelay`), imported legacy rows. The holder and recovery replay sealed bytes with their own fetch, so the translation must happen before sealing. |

Inbound (`normalizeInboundThread` runs first, before any `message_thread_id ?? 1` read):

| Point | Note |
|---|---|
| `TelegramLifeline.processUpdate` (message + callback) | the normal path; every forwarded `topicId` is then internal |
| `TelegramAdapter.processUpdate` + `processCallbackQuery` | direct-polling path |

For a message from the issues chat the field is ALWAYS set, even when Telegram omits
it (the issues group's General): `OFFSET + (thread ?? 1)`. A raw thread id `>= OFFSET`
from the wire (impossible under the 32-bit bound) is logged and left unmapped rather
than silently colliding.

Threadless message operations (no `message_thread_id` to translate), inventoried:

| Call | Chat it must use |
|---|---|
| prompt-gate edits (tap, text-reply "Answered", expiry) | the chat the prompt was sent to: stored as `relayChatId` on the pending entry from the send result (`result.chat.id`) and passed to every `editMessageWithRetry` |
| topic-name probe `deleteMessage` | `result.chat.id` of the probe send |
| dashboard edit/pin, setup greeting pin | always the main chat (unchanged) |

Other pieces:

| Point | Change |
|---|---|
| `createForumTopic` / `findOrCreateForumTopic` | option `{ space: 'issues' }`: create in the issues chat, return `OFFSET + thread`; name lookup matches only ids in the same space |
| Origin `authorize` + display (`TelegramOriginBoot`) | `issuesChatId` joins the live config snapshot; authorize admits it as a destination chat; per-conversation display override is looked up by the internal id for issues-chat sends |

**Unconfigured but issues-range id:** `toWireParams` throws (`issues-chat-not-configured`)
instead of sending an issues-range thread id to the main chat. A rollback, or a
machine whose config lacks the field, fails visibly with a named error
rather than producing a confusing Telegram rejection or a wrong-topic post. It is a refusal with a named error, not a queued hold: nothing is recorded or retried.

`importLegacyQueue` prepares each row inside its own try, so one row that cannot be
prepared does not block the rest of the queue.

Transport scope: issue topics are served by the bot transport. The operator-browser
transport (typed destinations) is unchanged and does not address issue topics.

Polling needs no change: `getUpdates` is bot-wide, so the lifeline already receives
the issues group's messages once the bot is a member/admin there.

Why not a composite `(chatId, threadId)` key everywhere: it would touch every layer that
stores a topic number (sessions, commitments, relay script, history, profiles); the
offset keeps the change to the Telegram edges.

### 4. Creating an issue topic (the agent-facing surface)

`POST /telegram/topics` accepts `"kind": "issue"`. When `issuesChatId` is configured
the topic is created in the issues group; otherwise in the main group (unchanged
behaviour). The response adds `"group": "issues" | "main"`.

### 5. Agent awareness + migration

CLAUDE.md template (`generateClaudeMd`) gains a short "Issue topics" section: when the
triage rule calls for a dedicated issue topic, create it with `"kind":"issue"`; the
topic id behaves like any other. `migrateClaudeMd` adds it to existing agents
(content-sniff guard). No config default is written: the field is optional and
absent means off.

### 6. Setting it up (operator chore = agent chore)

Bots cannot create groups. The agent creates the group from the operator's signed-in
Telegram Web in a normal Chrome profile, makes it a forum supergroup named
"<agent> Bugs", adds the bot as admin with topic rights, posts that the agent created
it, and writes `issuesChatId` into its config.

## Signal vs authority

No decision point is added. The only gate touched is origin `authorize`, which gains
one more allowed destination (the operator's own configured issues chat). Nothing is
blocked that was allowed before.

## Decision points touched

- Origin `authorize` destination allow-list — `invariant`: gains exactly one allowed chat, the agent's own configured `issuesChatId`; deterministic equality, foreign chats stay refused, nothing allowed before is refused now.
- `toWireParams` refusal of an issues-range id with no issues chat configured — `invariant`: a structural routing fact (the destination does not exist on this machine), not a judgment; the caller gets a named error and nothing is sent.

## Open questions

*(none)*

## Multi-machine

`issuesChatId` lives in the messaging config like `chatId`; each machine reads its own
config, the same as `chatId`. Topic ids are internal numbers that already replicate. A
machine without the field refuses issues-range sends (above) instead of misrouting
them. The internal id means "the configured issues group": pointing `issuesChatId` at a
DIFFERENT group later orphans existing issue topics, so the group is never replaced,
only removed. Two machines configured with different issues groups would resolve the
same id differently; like `chatId`, the value must be the same on every machine of one
agent (set once by the agent itself).

## Human-facing numbers

The agent always sees the internal id (`[telegram:10000000005 ...]` prefix) and passes it
back to `telegram-reply.sh`; operators never type topic ids. Logs show the internal id.

## Rollback

Remove `issuesChatId` from config AND remove the bot from the issues group (otherwise
its messages would again arrive with raw thread ids and be filed as main-group topics,
as they would today). Sends to existing issue topics are then refused with a named error, never misrouted.
Code rollback is a normal revert release; no data migration. After a code revert an
issues-range send goes to the main chat with a thread id Telegram does not know, so
Telegram rejects it: it fails, it does not land in a wrong topic.

## Maturation plan

- **test-agent-live:** unit tests cover the mapping, adapter, lifeline and origin sealing; the live check below runs on the development agent itself.
- **dev-agent-live:** Echo, from the release that carries it, with `issuesChatId` set to the "Echo Bugs" group: create one issue topic, send into it and receive a reply in it.
- **fleet:** the same release; the field is opt-in per agent, so agents without it see no change.
- **graduation criterion:** on Echo, an issue topic created with `kind:"issue"` lands in Echo Bugs, a message the operator sends there reaches its session, and the session's reply appears in that topic (not in the main group).
- **dark-window:** none — opt-in by config, live on release. If the criterion is not met within 7 days of the release, the reason is recorded in topic 127831.

## Acceptance

- Unit: mapping round-trips (inbound → outbound) for a normal topic, the issues General
  (field absent → OFFSET+1 → thread omitted), and a main-group topic untouched; both
  functions idempotent (applied twice = once); no-op when unconfigured; issues-range
  id with no issues chat configured throws; `reply_to_message_id` mapped.
- Unit: origin `prepareBot` seals an issues-range send with the issues chat and the real
  thread id.
- Unit: prompt-gate edit after a text reply uses the stored relay chat.
- Unit: adapter `createForumTopic({space:'issues'})` posts to the issues chat and
  returns the offset id; sends to that id go to the issues chat with the real thread.
- Unit: lifeline normalizes an issues-group message before forwarding.
- Unit: origin authorize admits the issues chat and still refuses a foreign chat.
- Integration: `POST /telegram/topics` with `kind:"issue"` returns `group:"issues"` when
  configured, `group:"main"` when not.
- Live: create "Echo Bugs", create one issue topic, send and receive a message in it.
