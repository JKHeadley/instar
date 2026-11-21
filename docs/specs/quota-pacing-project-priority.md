---
title: "Quota pacing, step 4: project priority (the owner's one tap) and each project's share of each account (read-only signal)"
slug: "quota-pacing-project-priority"
author: "echo"
parent-principle: "Signal vs. Authority"
eli16-overview: "quota-pacing-project-priority.eli16.md"
status: "draft"
approved: true
approved-by: "Echo, under the repository standard 'Approval Only Where Required' (2.0 Rule 82, CLAUDE.md Standards: the operator approves only constitution and protected-list changes). This spec touches no constitution file and no path in .github/CODEOWNERS. Request origin: Justin, topic 141385, 2026-11-17 10:19 PST; restated topic 144201, 2026-11-19. (GET /attribution/trace has no lineage rows for either message: both predate the ledger.)"
parent-spec: "quota-pacing-forecast.md (step 1: identity key, cycle resets, pool fan-out, `subscriptionPool.pacing`); quota-pacing-spend-by-account.md (step 3, PR #3491: served account, `served_identity`, `served_basis` on every raw ledger row); work-door-project-rows.md (the owner's project taps from the phone); cos-owner-pause-record.md (the owner-only lifecycle event and the Telegram ask pattern); chief-of-staff-topic.md (bound projects, the conversation tree)"
lessons-engaged:
  - "P2 Signal vs Authority: priority is the owner's stated preference; nothing in this step reads it to hold, shed, swap, place or spend, and a priority tap does not even renew the Chief of Staff check-in"
  - "P20 Verify the State, Not Its Symbol: `by: 'owner-tap'` is written only behind a proof the agent cannot produce (the phone's presence key, the owner's Telegram tap); the console PIN is not such a proof, so the console cannot set priority. A project's share counts an account only on step 3's confirmed bases"
  - "P24 Never Silently Cut the Data: usage with no conversation, no project, a broken tree or no proven account is its own labelled bucket; a window older than a machine's oldest raw row is marked incomplete"
  - "Mobile-Complete Operator Actions: the owner sets priority in one tap from the phone, and an owner request in Telegram becomes one button"
origin: "Justin, topic 141385, 2026-11-17 10:19 PST (token pacing plan; step 4 'Priority on a project: high, normal or low, one tap to set'; step 3 'spend by account, and each project's share of each account'), and topic 144201, 2026-11-19: 'a continuous effort to optimize our use of tokens for all accounts'. Restarted in topic 144201 on 2026-11-21. Step 3 (PR #3491) left the per-project share out, so this step carries it."
single-run-completable: true
---

# Quota pacing, step 4: project priority and each project's share of each account

## Problem

Steps 1 to 3 measure the accounts: how full each one is, where it will land at reset (step 1), and which account really served each request (step 3). Steps 5 and 6 will suggest changes, such as moving a conversation to another model or provider, or starting and stopping an autonomous run. Two facts they need do not exist:

1. **Which work matters more.** A bound project has a goal and a done list, but nothing says the owner cares more about one project than another. A suggester choosing which work to slow down when an account runs tight would have to guess, and guessing the owner's priorities is exactly what the agent must not do.
2. **Which project the quota went to.** The usage ledger records the conversation (`topic_id`, Telegram only) and, after step 3, the account that served each row. No read joins the two with the Chief of Staff's projects, so nobody can say "of the work recorded on Dawn's Claude account this week, 40% was the Android rebuild and 12% was conversations in no project".

## Goal

- The owner sets a project's priority to **high**, **normal** or **low** with one tap in the Instar app, or with one button the agent sends when the owner asks for it in Telegram. The agent never sets it.
- Every Work door project row shows its priority and whether the owner actually set it.
- A read reports each project's recorded usage on each account and each project's share of each account's recorded usage, with every unattributable part shown as its own bucket.
- Both are signals. Nothing in this step consumes them.

## Non-goals

- No shedding, swapping, holding, re-placing or re-ordering of any work by priority. The quota scheduler, placement, the swap brakes and the Chief of Staff loop do not read priority in this step. Consumers arrive in step 5 (the background assessment) and step 6 (the owner's daily card), each with its own spec, floor and arbiter.
- No change to the Work door's sort order (by state, as today).
- No priority on `/projects` multi-spec pipeline records (`InitiativeTracker`, `kind: 'project'`). Priority belongs to the projects the owner sees and taps on the Work door, which are Chief of Staff bound conversations. A pipeline project bound to a Chief of Staff conversation (`binding.initiativeId`) is covered through that conversation.
- No console (dashboard) write. The console shows the priority; setting it there waits for a console owner proof stronger than the PIN (fb-0ac4fffb-148), exactly as Pause, Mark checked and Finish do (`work-door-project-rows` Frontloaded Decision 6).
- No agent path to set priority, and no agent-originated proposal flow (that is step 6's card).
- No re-keying of the replicated usage rollups (step 3's decision stands; reads fan out over raw events).
- No chart. The Work row chip and the read route are the surface.

## Build slices

- **Slice 1, priority (§1 to §3):** depends only on `main`. This is the run this spec completes.
- **Slice 2, project shares (§4):** reads step 3's `served_identity`, `served_account_id` and `served_basis` columns, so it is built on `main` after PR #3491 merges, as its own PR under this spec. Slice 2 is a named second run, tracked on this project's Work Board card with #3491 as its dependency; it is not a mid-run stop of slice 1. The `conversation_key` column (§4.1) has no step 3 dependency and ships in slice 1, so the history slice 2 reads has already started accumulating when slice 2 lands.

## Design

### 1. The record: an owner-only `owner-priority` lifecycle event

Priority is stored as an immutable `binding-lifecycle` record in the existing `chief-of-staff-record` store, next to `owner-pause` and `owner-item-check` (`src/core/ChiefOfStaffStore.ts`), because that store is already the agent-wide, replicated, order-independent home of every owner decision about a project.

- **Shape:** `{ recordType: 'binding-lifecycle', conversationKey, event: 'owner-priority', priority, bindingHlc, by: 'owner-tap', at, who, messageRef, askId, via }`. Key `lifecycle:<conversationKey>:<hlc>`, as for every lifecycle event. `priority` and `via` join `KNOWN_FIELDS`.
- **Who:** the validator accepts it only with `by: 'owner-tap'` and `via` in `app | telegram`. `messageRef` is `instar-app:<deviceId>` for the app (only the phone route writes that prefix) and the cited attribution marker for Telegram. `askId` is the tap's own nonce (`app-<16 hex>` for the app, the ask id for Telegram). The route decides `via` and `messageRef` from the proof it verified, never from the body.
- **Forward compatibility of the value:** the validator accepts `priority` as any lower-case word sequence of letters and digits joined by `-` (`^[a-z0-9]+(-[a-z0-9]+)*$`), at most 200 characters, the bound the store already uses for an unknown lifecycle event name; that grammar is the published contract every later build's levels follow, and the fold, not the validator, decides what it means. A record is never rejected for a level this build does not know, because a rejected record stalls the whole peer stream on that machine (the reason `cos-owner-pause-record` made unknown lifecycle events stored and ignored). A level outside `high | normal | low` folds to `level: 'unrecognized'` with the raw word kept, shown as "Set to a level this version doesn't know"; it is never read as normal.
- **Older builds:** a build without this change stores `owner-priority` as an unknown lifecycle event (counted in `GET /chief-of-staff` `unknownLifecycleEvents`) and ignores it. The journal applier writes the received bytes unchanged, so the record reads in full once that machine updates (`work-door-project-rows` §Multi-machine posture documents this path).
- **Fold:** `foldProjectPriority(entries)` (pure, new, in `ChiefOfStaffStore.ts`): per `conversationKey`, the newest valid `owner-priority` event by record HLC wins; an `askId` already seen is ignored. Priority belongs to the conversation, not to one binding version: a goal or done-list edit, a close and a reopen all keep it, because the owner chose how much the work matters, not how its done list is worded. `bindingHlc` is kept for audit only.
- **Not set is neither "unknown" nor "normal":** with no event, the fold answers `{ level: 'normal', set: false }`. A consumer must treat `set: false` as "the owner has not said", never as the owner choosing normal. The row and the read carry `set` on every priority.
- **Durable before 200**, through the loop's existing `durable()` wait, as every owner tap.
- **No check-in.** Unlike the other Chief of Staff taps (`cos-owner-pause-record` §3.2), a priority tap does not write a check-in on any surface. A check-in renews the owner's check-in lease, which lets the Chief of Staff resume restarting and redirecting work, and this step must change no work. The owner's other taps and the app's check-in button are unchanged.

### 2. The owner's one tap

**Phone (Face ID), the primary surface.** One new action on the phone write gate (`src/server/mobilePermissionsRoutes.ts`), shaped like `project-pause`:

- Challenge: `POST /mobile/permissions/challenge { action: 'project-priority', target: <key>, value: 'high' | 'normal' | 'low' }`. Action line: `project-priority <key> <level>`. `ProjectAction` widens to include it, so it shares `projectTap`, the audit trail (`state/mobile-permission-actions.jsonl`) and the refusal shapes; `projectTapPort.apply` routes it to `loop.appPriority` and skips the check-in for this kind only.
- The device allowlist entry in `src/server/mobilePairingRoutes.ts` (`/^\/mobile\/work\/projects\/(pause|done-item|finish)$/`, `ownerOnly`, the existing `owner-presence` bucket) gains `priority`. The bucket is the existing shared limit for every owner Face ID tap; this step adds no limit of its own.
- Precheck at the challenge and again before writing (`appTapPrecheck` gains kind `priority`): the conversation has a confirmed binding (404 `no-project`); the level is one of the three (400 `bad-value`); the switch is on (503 `project-priority-off`). A finished project can still have its priority changed (it is kept for a reopen).
- Write: `POST /mobile/work/projects/priority { key, value, challenge, presenceSig }` → `loop.appPriority({ conversationKey, level, deviceId, tapId })` writes the event with `via: 'app'`. The answer carries the fresh project row, so the phone redraws from the server.
- Every proven tap is recorded, even when the fold already shows that level (a decision made before replication arrives is never dropped).

**Telegram (when the owner asks in chat).** When the owner writes in Telegram "make the Android rebuild high priority", the agent calls `POST /chief-of-staff/projects/:key/priority-ask { level, marker }`, where `marker` cites that owner message (`[source: telegram <topic>/<message> <date>]`). The same deterministic floor as the pause ask (`src/core/cosOwnerPauseSource.ts`) must hold, or 422 with the named reason and nothing is sent; the agent fixes a 422 by finding the message itself and never asks the owner to point at it. The loop sends the owner one message quoting their own words with one button, "Set to high"; only their tap on it writes the event, with `via: 'telegram'`. The ask itself changes nothing.

- **Its own ask store and callback.** Priority asks live in their own file, `state/cos-priority-asks.json` (at most one open priority ask per project; a newer one replaces the older and removes its button), never in the pause-ask store, so a priority ask can never cancel a pending pause button or the reverse. The callback data is `cos:pr:<hex>` (the level lives in the stored ask, not in the callback), routed by `ownerTap` beside the existing `^cos:(p|r):` routes.
- **Outlived asks.** At tap time an ask is ignored and cleared when an `owner-priority` event for that project has a record HLC physical time later than the ask's `sentAt` (a newer priority decision, from the phone or another ask, already exists). Pause and resume events do not count. The comparison is between two machines' wall clocks (NTP-synced across the fleet), exactly as the pause ask's; under skew an ask can be wrongly treated as outlived (the owner sees "That action no longer applies." and the agent asks again) or an older ask can survive (its tap is still the owner's own decision, recorded as their newest by HLC). Both leave an owner decision recorded and visible on the row.
- **Recheck at tap.** Immediately before the journal write, the callback rechecks the switch, the Chief of Staff and the confirmed binding; a button tapped after the feature was turned off answers "That action no longer applies.", clears the ask and writes nothing (and, like every priority tap, no check-in).
- Runs on the Telegram callback machine (`not-callback-machine` elsewhere), as the pause ask. On an agent with no Telegram configured the ask route answers `503 telegram-off`.
- **Other channels:** the marker format names Telegram messages only, so an owner request made in Slack or an app conversation cannot become a button. There the agent tells the owner the project's row in the Instar app has the control. Nothing is lost: the owner's phone is the primary surface on every channel.

**The console** shows the priority chip on every row and, in place of a control, the words "Set it in the Instar app". The console operator session is unlocked by the dashboard PIN, which any session holding the agent's Bearer token can read, so it cannot prove the owner chose (`cos-owner-pause-record` §3.2, `work-door-project-rows` Frontloaded Decision 6).

**What the agent may do:** read priority, show it, and send a priority ask that carries the owner's own Telegram request. It may not set, change or clear priority, and it proposes no priorities of its own in this step. The new event is written only behind the two proofs above. Existing PIN routes that the agent could reach with the PIN it can read (`POST /chief-of-staff/projects` to bind, and the console `unpark` and `confirm-done` tap) are not changed by this step and never write or accept a priority; a test proves the PIN tap route refuses a priority action. Their own PIN proof is already under review in fb-0ac4fffb-148.

### 3. Where priority shows

- `GET /work/projects` and `GET /mobile/work/projects` rows gain `priority: { level: 'high' | 'normal' | 'low' | 'unrecognized', set: boolean, at: string | null, via: 'app' | 'telegram' | null, words: string }` and `actions.priority: { allowed: boolean, values: ['high', 'normal', 'low'] }` (`allowed` is true only on the owner's phone read and only while the switch and the Chief of Staff are on, so the row never offers a control the write would refuse). `words` is server-owned: "High priority", "Low priority", "Normal priority", "Set to a level this version doesn't know" for `unrecognized`, and "Normal (not set)" when `set` is false. Only the owner's phone gets project rows with names today; a member's or guest's phone gets nothing new. `PROJECTS_SCHEMA_VERSION` stays 1 (the fields are additive; a client detects them by `actions.priority`).
- `GET /chief-of-staff/projects/:key` carries the same `priority` object.
- The Chief of Staff note is unchanged in this step.

### 4. Each project's share of each account: `GET /usage/projects`

#### 4.1 A conversation key on every new ledger row (slice 1)

The ledger records `topic_id`, set from `session.telegramTopicId` only (the one `recordBinding` call, `AgentServer.ts`, in the `setClaudeSessionBoundSink` sink; invocation rows write null). A new nullable column `conversation_key` is added to `session_bindings` and to the raw `usage_events` table with a guarded, idempotent `ADD COLUMN`.

- **Source of the key.** The routes file's `conversationRefForSession` (`routes.ts`: `telegram:<id>` from the topic id; a Slack session resolved through the app conversations registry's `resolveByKey`, which gives the canonical `slack:<teamId>:<channelId>[:<threadTs>]` key; an app session through `channels.getChannelForSession` and `registry.resolve`, which gives `app:<conversationKey>`) is moved unchanged into a shared module, `src/core/conversationRefForSession.ts`, and used by both the routes and the ledger sink, so the ledger key is byte-identical to the key the Chief of Staff binds. Before that lookup, the sink takes `session.memoryPlaceInput.memoryPlaceKey` only when it is `app:`-prefixed, because the app dispatcher sets it at spawn (`appInboundDispatch.ts`), before the app channel is registered. A Slack session's `memoryPlaceKey` is `slack:<channelId>` with no team id, which never matches the key the Chief of Staff binds, so Slack always goes through the registry lookup; a unit test proves a Slack session whose `memoryPlaceKey` is `slack:C…` still records the canonical key.
- **Late app registration.** An app channel is registered only after `spawnInteractiveSession` returns, and the binding sink can fire before that. Normally `memoryPlaceKey` already carries the key. As a backstop, when the key is null at binding time, the app dispatcher's channel registration calls `ledger.setBindingConversationForTmux(tmuxSession, key)`, which resolves the open binding's Claude session id through the session manager's tmux-to-session record (the same `claudeSessionId` the binding sink received), which sets the open binding's key and, in the same transaction, fills `conversation_key` on that session's already-ingested rows where it is still null. A test pins both orders.
- **Write sites.** Every write site that sets `topic_id` from the binding (transcript rows, Codex rollout rows, and `promoteCopiedRow` for copied history) sets `conversation_key` from the same binding; invocation rows stay null, as their `topic_id` does.
- **Snapshot and restore.** `session_bindings` is in the hourly backup snapshot. `writeSnapshot` builds the snapshot's tables from the base DDL and then copies every live column, so the snapshot builder applies the same `ADD COLUMN` (as it already does for `checkpoints.extra`), and `importSnapshotIfEmpty` adds `conversation_key` to its explicit binding column list, feeding each row as `{ conversation_key: null, ...r }` (as the checkpoints restore already does for `extra`), so a snapshot written before the upgrade still restores. Round-trip tests cover a snapshot with the column and one written before it.
- **Replication.** `session_bindings` also replicates to peers as `pool_bindings`. The new column is deliberately **not** carried there: `/usage/projects` reads each machine's own raw rows through the fan-out, never `pool_bindings`, and widening the replicated shape would be a replication change. `applyPeerRow` keeps its explicit column list, so an older or newer peer is unaffected.
- **Old rows.** Old rows, and rows from a machine on an older build, have `conversation_key` null. A non-null `topic_id` then gives `telegram:<topic_id>` at read time with `conversationBasis: 'from-topic-id'`. That mapping is exact (the column only ever held the Telegram topic id), so it is not a guess. Rows with neither are `conversationBasis: 'none'`.
- **Codex.** Codex rollout rows get a conversation only through a binding recorded under the rollout's session id, which today exists only when the Codex hook reporter posts that same id. Whether that link holds in practice is checked at the test-agent rung. Either way, the answer breaks the `no-conversation` bucket down by framework, so a missing Codex link shows as "Codex: no conversation recorded", named, never as an unexplained gap.

#### 4.2 From conversation to project (slice 2)

The read folds the Chief of Staff union (`foldBindingState`, `foldTreeState`) once per request. A conversation belongs to a project when it is itself a confirmed bound project, or when its parent chain in the tree reaches one (a sub-topic). The walk stops on a repeated key; a cycle, or a parent link to a key the tree does not hold, puts that conversation in its own `unresolved-tree` bucket, never in "not in a project". The walk is bounded by the number of distinct keys in the tree, so it needs no hop limit.

The mapping is the current tree, named in the answer (`projectMapping: 'current-tree'`): a conversation moved under another project moves its past usage with it, and earlier parentage cannot be recovered from this report (the tree keeps only its newest parent link). Usage from days before the project's binding was confirmed (`binding.confirmedAt`) is counted for the project and also shown as `beforeBinding`, at day resolution (§4.4), so a project's share is never inflated silently by the conversation's earlier history. A scheduled job that runs inside a topic counts toward that topic's project; only a job's rows with no conversation land in the `job` bucket.

#### 4.3 Which account (slice 2)

Rows are bucketed by step 3's stored basis, never by the account a session was only tagged with:

| Step 3 `served_basis` | Grouped by | Shown as |
|---|---|---|
| `ledger-verified`, `enrollment-confirmed` | `served_identity` | the login, `confirmed: true` |
| `identity-unconfirmed` (every Codex row today), `ledger-unverified` | `served_account_id` | that account, `confirmed: false` |
| `no-transcript` with a binding account | the binding's `account_id` | that account's `bindingOnly` slice, `confirmed: false` |
| `no-transcript` with no binding account (a hand-started session) | basis | `unidentified`, `no-transcript` |
| `slot-changed`, `enrollment-drifted`, `unknown-root`, `ambiguous-root`, `off`, `before-attribution` | basis | `unidentified`, per basis |

Each account entry carries its own `shares`, which sum to 1 within that entry; an unconfirmed entry's shares are labelled unconfirmed and are never mixed into a confirmed login's.

#### 4.4 The answer (slice 2)

`GET /usage/projects?window=cycle|rolling&since=&until=`. Default `window=cycle`: each account entry covers that account's own current weekly cycle, from step 1's weekly (`sevenDay`) `resetsAt` for that login (the separate Fable window is not a cycle boundary here), rounded down to the UTC day (the entry states its start and end, and the reset day itself is approximate by up to a day). An account whose cycle step 1 cannot tell, or a machine with step 1 off, falls back to the last 7 days for that account, labelled `window: 'rolling-7d'`. `rolling` takes `since`/`until`, at most 31 days, and then every account uses that one interval. `projects[]`, which compares one project's spend across accounts, always uses one common interval named in the answer (`projects.interval: { since, until }`): the rolling interval when one is given, else the last 7 whole UTC days, so a project's split across accounts never mixes a one-day cycle with a six-day one.

- **Which rows count.** Exactly step 3's row selection for `/usage/accounts`, through the same shared selection function, never a copy: transcript rows with status `counted`, invocation rows `counted` or `paired` (a paired request is counted once, through its transcript row and its served fields); invocation rows held, in disagreement or ambiguously paired land in `no-conversation` under `no-transcript`. A reconciliation test proves each account entry's total equals `/usage/accounts` for the same interval and machines, including a paired request and a `no-transcript` invocation with no binding account.
- **What a peer returns.** Each machine (the holder included) runs one grouped query over its own raw rows and answers grouped sums keyed by `(conversation_key, topic_id, job_slug, framework, served_identity, served_account_id, account_id, served_basis, UTC day)` with requests, tokens by part and list-equivalent cost, plus its `earliestRowTs` (its oldest raw row) and its query time. No raw rows cross machines. The query scans one UTC day per statement and yields to the event loop between days, so a long window never holds a machine's main thread for the whole scan. A week of grouped sums is typically a few thousand rows of about 150 bytes; the fan-out's per-peer size limit for this route is 2 MB, and a larger answer is refused whole as `too-large` in `sources`.
- **The holder merges** all machines' groups, maps conversations to projects (§4.2), buckets accounts (§4.3), applies each account's window at day resolution and computes the shares. Because the groups carry the day, `beforeBinding` is exact to the day: days before the day of `confirmedAt` are before, the confirmation day and after are after.
- **Buckets add up.** Within each account entry every row lands in exactly one bucket: a project; `not-in-a-project` (a conversation with no project); `unresolved-tree`; `job` (a scheduled job's rows with no conversation, by job slug); `no-conversation` (everything else, such as internal model calls, broken down by framework). The shares of one entry sum to 1, so "unknown" is visible as its own slice and never hidden in a project.
- **Share** is `shareOfObservedCost`: the project's list-equivalent cost divided by that account's total recorded list-equivalent cost in its window, with tokens and requests beside it, and `null` with a reason when the total is 0. It is a share of what this agent recorded, not of the provider's weekly percentage: list price is not quota, and use of the same login outside the agent (the web app, the phone, other machines) is invisible. Both caveats travel with every account. Step 3's `costPerPoint` could later turn a share into points; that is left to step 5.
- **Schema `usage-projects/1`:** `{ schema, generatedAt, projectMapping, accounts: [{ key, kind: 'login' | 'account' | 'unidentified', confirmed, window, totals, shares: [{ bucket, requests, tokens, costList, shareOfObservedCost, beforeBinding? }] }], projects: [{ key, title, priority, totals, byAccount: [{ account, costList, shareOfObservedCost, shareOfProject, confirmed }] }], conversationBasis: { conversationKey, fromTopicId, none }, sources: [{ machineId, status, reason?, earliestRowTs?, queryMs? }], complete, incompleteReasons }`.
- **Incomplete is said, never zero.** `complete` is true only when every machine in the pool's membership list returned a validated answer covering the window. Any other fan-out status (`unreachable`, `deadline`, `too-large`, `invalid-body`, `http-error`, `omitted-cap`) makes it false with that machine and status in `incompleteReasons`; so do: a machine on an older build (a 404 maps to `unsupported`); a machine with the switch off (its 503 `project-priority-off` maps to `off`); a machine's `earliestRowTs` is later than the window's start (`retention-incomplete`: raw rows can be cut before 90 days by the row ceiling); or step 3's served account is off on a machine (`served-account-off`, those rows are `unidentified`). A missing machine's usage is never counted as zero, and a consumer can refuse to act on an incomplete answer.
- **Needs:** the usage ledger and the Chief of Staff on the machine answering the request; without the Chief of Staff it answers `503 chief-of-staff-off`. Peers are asked through a per-machine form of the route (`?scope=local`, never fanned out further, as step 1's), which needs only the ledger; a peer's 503 `usage-ledger-off` or `project-priority-off` is a named entry in `incompleteReasons`.
- **Conversations no key covers:** the Chief of Staff also accepts `imessage:` and `whatsapp:` keys, which `conversationRefForSession` never produces today. Usage in such a bound project lands in `no-conversation`, and the project's own entry says "usage from this channel is not recorded yet", so it is never read as zero use.
- **Access:** the same rule as the existing `/usage/*` routes (agent Bearer, not on any phone allowlist). Project titles are the Chief of Staff titles the owner already sees on the Work door.

### 5. Switch and rollout

- **One switch:** `subscriptionPool.pacing.projectPriority.enabled`, resolved through `resolveDevAgentGate()` (`explicit ?? !!developmentAgent`) and left out of config defaults, so it is on for Echo (a development agent) and dark on the fleet, and an explicit `false` turns all of this step off. It is registered in `src/core/devGatedFeatures.ts` and given a ladder in `src/data/feature-ladders.json`.
- **When off:** the priority tap route and the ask answer `503 project-priority-off`; the challenge route refuses `project-priority` before Face ID; rows carry no `priority` and no `actions.priority`; `GET /usage/projects` answers `503 project-priority-off` (the only off code, everywhere; its detail says the usage-by-project read shares this step's switch). Priority events already written stay in the journal (append-only, replicated owner history) and show again when the switch is turned back on. The column migration and the `conversation_key` writes run regardless once the code is present: they are additive, one string from data in hand, and keeping them continuous avoids a hole in the history if the switch is flipped. The one switch deliberately covers both halves; step 5's spec may give the share read its own gate if it needs the read while priority is off.
- **Needs:** priority needs the Chief of Staff (`chiefOfStaff.enabled`); without it the routes answer `503 chief-of-staff-off`, as the other project taps.
- **Ladder metrics** read only unified sources, so no machine-local measurement state is added: priority taps and levels from the replicated fold (`foldProjectPriority` over the union), and `conversationBasis`, `complete` and per-source `queryMs` from `GET /usage/projects` (fanned out to every machine). The phone write outcomes come from each machine's existing permission audit trail, read through the same pool fan-out as the other phone-write measures.

### 6. Agent awareness and clients

- **Awareness entry**, one file `src/data/awareness/project-priority.md`: "Each project the owner sees on the Work door has a priority, high, normal or low, set only by the owner: a tap in the Instar app, or the button I send in Telegram when they ask for it there. Read it from `GET /work/projects` (`priority`); `set: false` means the owner has not said, not that they chose normal. Never set it for them. When they ask in Telegram, send `POST /chief-of-staff/projects/KEY/priority-ask` with their own message as the marker; their tap on the button sets it. Asked anywhere else, point them to the project's row in the Instar app. To say which projects used which account, read `GET /usage/projects` and lead with the account ('of the work I recorded on Dawn's Claude account this week, most went to the Android rebuild'); name the not-in-a-project and no-conversation slices and say plainly when the answer is incomplete. It is a share of recorded work, not of the account's weekly percentage. Priority is a preference, not an instruction: don't hold, shed, add or move work because of it." It reaches existing agents through the feature-notes rebuild, so no `migrateClaudeMd` step is needed.
- **CapabilityIndex:** the `workProjects` entry lists the new route and challenge action; a `usageProjects` entry sits beside step 3's `/usage/accounts`.
- **Console (this repository):** the Work page (`dashboard/console/projects.js`, `projects-model.js`) shows the priority chip on every row with "Set it in the Instar app". Built in slice 1.
- **Phone and Mac apps (another repository):** the iPhone and Mac Work screens live in `EchoOfDawn/instar-desktop-apps` (checked out at `apps/instar-ios`), Android in `apps/instar-android`. They are built from this contract by the app projects that own those screens: the Apple app rebuild (topic 145973) and the Android app (topic 142909). The slice 1 PR body carries the full contract (fields, route, challenge action, refusal codes). At merge, a Work Board card for the app slice is filed under this project with this spec as its link and the two owning topics named; it closes only when an app release with the priority control is installed on the owner's phone, which the graduation criterion checks through a real tap in the audit trail. The app slice is on this step's completion list. A client meeting a server without these routes gets 404 and rows without `actions.priority`, and shows no control.
- **WriteDomainRegistry:** the existing `POST /mobile/work/projects/` and `POST /chief-of-staff/` entries already cover the new write routes (both write the `chief-of-staff-record` stream); their notes are amended to name the priority write.

## Maturation plan

- **test-agent-live:** before merge, a throwaway agent with the Chief of Staff on and two bound projects (one with a sub-topic): a user-role session drives the owner phone path (device-signed, presence key enrolled) to set High on one project and Low on the other, sees both rows redraw with `set: true`, confirms the Chief of Staff check-in lease did not change, is refused with a non-owner phone and on the console PIN tap route, and answers a priority ask's button while a pause ask for the same project stays open. With the switch off, every route answers 503 and rows carry no priority. For slice 2, the same agent with seeded ledger rows on two homes shows each project's share of each account, the sub-topic's usage under its project, a conversation in no project, a cycle in the tree as `unresolved-tree`, a peer that does not answer as `complete: false`, and one real Codex topic session's rows (to learn whether the Codex binding link holds).
- **dev-agent-live:** on from merge on Echo's machines through the dev gate. First use: Justin's Work page shows "Normal (not set)" on every project until he taps.
- **graduation criterion:** a review on the maturation board, filed at merge, after two weekly resets on Echo: at least one real owner priority tap recorded from a phone and visible on the row (a zero count is not a pass); no unexpected failures on the priority routes (coded refusals such as `project-priority-off`, `chief-of-staff-off`, `no-project` and `not-callback-machine` are correct answers, not failures); the `none` share of `conversationBasis` among the period's rows, with anything over 10% traced to a named cause; per-source query times; and whether the project shares read as sensible against what Justin knows was worked on. It decides on judgment from that evidence, never on a timer.
- **fleet:** default-on for every agent is the last rung: two independent graduation readings that agree, then a reviewed pull request that changes the shipped default.
- **dark-window:** none on Echo (live from merge); a reminder at 4 weeks after merge if the review has not happened.
- **ladder:** subscriptionPool.pacing.projectPriority

## Safety and side effects

- **Authority:** none. No scheduler, placement, swap, shedding, loop or model-choice code reads priority or the shares in this step, and a priority tap does not renew the Chief of Staff check-in. A structural test fails the build if any file other than an exact list (`src/core/ChiefOfStaffStore.ts`, `src/server/workProjectsRoutes.ts`, `src/server/workProjectActions.ts`, the `/chief-of-staff/projects/:key` read in `src/server/routes.ts`, the new `src/server/usageProjectsRoutes.ts`, and their tests) imports `foldProjectPriority` or the `usage-projects` reader, and if the route strings `/usage/projects` or `priority` field reads appear under `src/scheduler/` or the subscription pool's placement and swap modules. It cannot see every possible read (an HTTP call from elsewhere, or a re-fold of raw records), so it is a tripwire for the common path, not a proof; each later consumer's spec is the real gate.
- **Who can write:** only the owner, through two proofs the agent cannot produce: the phone's presence-signed tap, and the owner's own tap on a Telegram ask that quotes their own message. The validator refuses any `owner-priority` record not marked `by: 'owner-tap'` with `via` `app` or `telegram`. A process with shell access that writes the journal directly is out of scope, as in `cos-owner-pause-record` §3.6.
- **Ledger write path:** one more string column, set from data in hand at binding time, plus one guarded backfill update per late-registered app session. No new file reads. The migration is additive, guarded and idempotent; the snapshot builder and restore column list are updated with it; rollups and the replicated binding shape are unchanged; old rows are not rewritten.
- **Read cost:** `/usage/projects` is one grouped query per machine, scanned a UTC day at a time with a yield between days, over at most 31 days, bounded by the fan-out's existing per-peer timeout, overall deadline, size check and rate limit; per-source query time is reported. The project mapping is one fold of the already-loaded union.
- **Privacy:** project titles, conversation keys, account slot ids and identity hashes; never emails, tokens or message text. The Telegram ask shows the owner their own message, as the pause ask does.
- **Unknown is not zero:** not set is `set: false`; an unknown level is `unrecognized`; usage with no conversation, no project, a broken tree or no proven account is its own bucket; a machine that did not answer, or whose raw rows do not reach back to the window's start, makes the answer `complete: false`.

## Tests (three tiers)

- **Unit:**
  - Validator: `owner-priority` accepted only with `by: 'owner-tap'` and `via` `app` or `telegram`; an unknown level word accepted and folded to `unrecognized`; a value outside `UNKNOWN_EVENT_RE` or over 200 characters rejected; `priority` and `via` in `KNOWN_FIELDS`.
  - Fold: newest by HLC wins regardless of arrival order; a repeated `askId` ignored; priority survives a goal edit, a close and a reopen; no event gives `{ level: 'normal', set: false }`.
  - Action line and precheck: `project-priority <key> <level>`; `no-project`, `bad-value` and `project-priority-off` refused before a challenge is issued; a finished project accepted; the apply path writes no check-in.
  - Validator: `tier-2` accepted and folded to `unrecognized`.
  - Telegram ask: the marker floor's 422 reasons; a button tapped after the switch was turned off writes nothing and leaves the check-in lease unchanged; its own store and `cos:pr:` callback, so a pause ask and a priority ask for one project are both open and each tap writes only its own event; an ask outlived by a newer `owner-priority` event is ignored and cleared, while a newer pause event does not outlive it.
  - Conversation key: Telegram, Slack (canonical `slack:<team>:<channel>` key equal to the key a Chief of Staff binding uses), app (equal to the bound `app:` key), none; the late app registration backfill in both orders; snapshot write and restore with the column.
  - Project mapping: self-bound conversation; sub-topic under a project; a cycle and a dangling parent give `unresolved-tree`; usage before `confirmedAt`'s day shown as `beforeBinding`; a job inside a topic counts toward its project.
  - Shares: every row in exactly one bucket, each account entry's shares summing to 1; the basis table (each step 3 basis to its row); unconfirmed entries kept apart; `from-topic-id` for old rows; `null` share on a zero total; a missing peer, an older peer, a switched-off peer and a retention-cut peer each make `complete: false` with their reason, as do an `omitted-cap` peer and a malformed peer answer; each account entry's total reconciles with `/usage/accounts`; `projects[]` uses one common interval while account entries use their own cycles; the cycle window per account and its rolling fallback.
  - The no-consumer tripwire.
- **Integration:** the phone challenge and write over the real gate (owner phone accepted; non-owner phone, bad signature and replayed challenge refused; the allowlist reaches the route); the ask route; `GET /work/projects` rows with and without a priority, and the console read showing the chip with no control; `GET /usage/projects` holder and proxied, one peer down, one peer on an older build; every route 503 with the switch off and with the Chief of Staff off; the migration idempotent on an existing database.
- **E2E (feature is alive):** the production init path in `server.ts` wires the priority fold into the Work read, the tap port, the ask route and the ledger's conversation-key source; on a development agent with no config key, a seeded owner tap shows on the row and (slice 2) `GET /usage/projects` answers 200, not 503.

## Measure of success

- **Correctness** is the unit tests: who may write, the fold, the mapping, and buckets that add up.
- **Usefulness on Echo within two weekly resets:** Justin has set a priority on at least one project from his phone; at least 90% of the period's ledger rows carry a conversation key or a topic id, or the rest is traced to a named cause (such as the Codex binding link); every account's shares are shown with their unattributed slices; and the largest project slice per account matches what Justin recognises as that week's main work.
- **Readiness for step 5:** the step 5 spec can read priority and shares from published, versioned answers (`usage-projects/1`, the row's `priority`) without touching this step's code.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Who may set priority | invariant; basis: external-constraint; evidence: the phone's presence key signs one exact action line over a single-use challenge (`mobile-native-permissions` §3.3); the Telegram ask writes only on the owner-verified callback on a message quoting the owner's own logged words (`cos-owner-pause-record` §3.2); the console PIN is readable by any Bearer holder, so the console is excluded; the validator refuses any record not `by: 'owner-tap'` with `via` app or telegram | Owner only; the agent may read and ask, never write. |
| A priority tap writes no check-in | invariant; basis: irreversible-consequence; evidence: a check-in renews the check-in lease, without which the Chief of Staff takes no action (`work-door-project-rows` §3 Words), so a check-in can restart or redirect work, which this signal-only step must never cause | The owner's other taps still check in. |
| Three levels and their words | invariant; basis: enumerable-domain; evidence: the owner's own plan names high, normal and low; a future level folds to `unrecognized`, never to normal, and is never rejected (a rejection stalls a peer stream) | Display and record vocabulary. |
| Not set reads as `normal` with `set: false` | invariant; basis: enumerable-domain; evidence: a project the owner never rated has exactly one honest description, "the owner has not said"; `set` lets every consumer tell it apart from a chosen normal | |
| Priority belongs to the conversation and survives binding edits, close and reopen | judgment-candidate; floor: only the owner's newer tap changes it, and every row shows when and how it was set; arbiter: the graduation review, from whether any priority looked stale to the owner | How much a project matters is not a property of its done list's wording. |
| A priority ask is outlived only by a newer priority decision | invariant; basis: enumerable-domain; evidence: the ask asks one thing, the priority; a pause decision does not answer it, and both possible errors under clock skew leave an owner decision recorded and visible on the row | Own store, own callback. |
| Project share uses the current conversation tree; a cycle or dangling parent is `unresolved-tree` | judgment-candidate; floor: the answer names the mapping, shows pre-binding usage separately and never folds a broken tree into "not in a project"; arbiter: the graduation review | The tree keeps only its current parent link. |
| Account bucketing by step 3 basis, shares by recorded list-equivalent cost, every row in exactly one bucket | invariant; basis: enumerable-domain; evidence: the step 3 basis set is closed and each maps to one row of the §4.3 table; the bucket set (project, not in a project, unresolved tree, job, no conversation) is closed and exhaustive, so each entry's shares sum to the whole | Signal only. |
| `from-topic-id` for old rows | invariant; basis: external-constraint; evidence: `topic_id` is written only from `session.telegramTopicId` (`AgentServer.ts`, the one `recordBinding` call), so `telegram:<topic_id>` is the exact conversation key | Not a guess. |
| Cycle window by default, rolling 7 days as fallback, 31-day maximum, 2 MB per-peer answer | judgment-candidate; floor: the window used is named on every account, a larger answer is refused whole and makes the read `complete: false`, never cut; arbiter: the graduation review, from per-source query times and `too-large` counts | The 31 days bounds main-thread scan work on every machine at once; the 2 MB is about ten times a typical week's grouped answer. |
| The 10% `none` line in the graduation review | judgment-candidate; floor: it only asks for a named cause, it blocks nothing; arbiter: the graduation review | Starting value. |

## Multi-machine posture

- **Priority events:** unified, replicated. They ride the `chief-of-staff-record` store and its order-independent fold, written on whichever machine the phone reaches and folded identically by every machine. An older build stores and ignores them and reads them in full after it updates.
- **Telegram priority ask store** (`state/cos-priority-asks.json`): machine-local on the Telegram callback machine, like the existing pause-ask store. machine-local-justification: physical-credential-locality — an ask is a button on a message the Telegram bot sent, and only the machine polling with that bot token receives its callback; the write the tap produces is replicated like any other.
- **Ledger `conversation_key`:** unified, proxied on read. Each machine records its own rows; `GET /usage/projects` fans out to every machine at request time through the existing bearer pool fan-out and names any machine that did not answer or whose history does not reach back far enough.
- **Ladder metrics:** read from the replicated fold and the fanned-out read; no machine-local measurement state.
- **Switch:** unified by default; it resolves from the agent-wide development flag, so every machine agrees unless an operator sets one differently, and a machine with it off answers `project-priority-off`, which makes the read `complete: false` with reason `off`.

## Frontloaded Decisions

1. Priority is an owner-only `owner-priority` lifecycle event in the existing Chief of Staff store, not a new store and not a field on the binding, so it replicates and folds like every other owner decision.
2. It covers the Work door's bound projects only; `/projects` pipeline records reach it through their bound conversation.
3. Two proofs may set it: the phone's Face ID tap and the owner's tap on a Telegram ask quoting their own message. The console shows it but cannot set it (its PIN is not an owner proof). The agent never sets it and proposes nothing on its own in this step.
4. A priority tap writes no check-in.
5. Not set is `normal` with `set: false`; an unknown level is `unrecognized`, never normal, never rejected.
6. Priority is per conversation and survives binding edits, close and reopen.
7. Priority asks have their own store and `cos:pr:` callback; only a newer priority decision outlives one.
8. The share counts accounts by step 3's basis table, maps conversations through the current Chief of Staff tree, divides recorded list-equivalent cost, uses closed buckets that add up, and carries a named `complete` flag.
9. A `conversation_key` column on `session_bindings` and the raw events (snapshot and restore updated, replication and rollups unchanged), taken from the shared `conversationRefForSession`, with exact `telegram:<topic_id>` mapping for old rows.
10. Two build slices: slice 1 (priority, the column, the console chip) now; slice 2 (`/usage/projects`) on `main` after PR #3491 merges, as a tracked second run.
11. One dev-gated switch, `subscriptionPool.pacing.projectPriority.enabled`; the app screens are a tracked hand-off to the app projects (topics 145973 and 142909), on this step's completion list.
12. Who approves: Echo, under the repository's Approval Only Where Required standard; no constitution file or CODEOWNERS path is touched.

## Left behind

- Any use of priority at all: steps 5 and 6.
- A console control, once the console has an owner proof stronger than the PIN (fb-0ac4fffb-148).
- A priority ask from Slack or app conversations (the marker format names Telegram messages only).
- Re-parenting history for the conversation tree, so past usage could stay with the project it was under at the time.
- Turning a share into weekly points through step 3's `costPerPoint`: step 5.
- A share line on each Work row (the read is the agent's today).
- Codex shares stay `confirmed: false` until a Codex identity check exists (step 3's left-behind).

## Open questions

*(none)*
