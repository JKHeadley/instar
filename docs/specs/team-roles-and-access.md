---
title: "Team roles and access: one role model across the app, server, Slack and Telegram, for one agent or a fleet"
slug: "team-roles-and-access"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "team-roles-and-access.eli16.md"
status: "draft"
lessons-engaged: "updates-never-restrict-existing-agents; decentralized-by-default; every-warning-needs-a-path-to-act; user-setup-must-be-trivial; never-require-a-purchased-third-party-service; Know Your Principal; Session Input Is a Principal; Cross-Machine Coherence; Bounded Notification; Signal vs Authority"
---

## 1. Problem statement

Operator request (topic 136110, 2026-11-06 about 18:32 PST, recorded verbatim in the lane brief): "We need to continue to work towards an Instar agent being appropriate for an entire team not just for a single person". And: "that doesn't mean an entire team will have Admin access. In fact, the app should start supporting user roles that align with our user role infrastructure. This should also align with the MSP support that we've been working on. In other words and owner should have full access to everything all in MSP would have Admin type access to perform maintenance and agent management while other users might have access only to certain conversations, but not to all conversations." And: "The Instar app should have the goal of being the only interface needed for entire team to work with a single agent or a fleet of agents with various roles and access".

The Thursday B2Lead report (2026-11-05) says "For a team: not yet", and lists with no owner: "No warning to the owner when a second person reaches an agent with privacy off".

Today a phone is either the owner's (everything) or an MSP's (all Telegram topics, sessions and alerts, none of the maintenance screens). There is no way to give a person access to only some conversations, and an MSP cannot do the maintenance the role exists for, because every maintenance route is owner-only.

## 2. What exists (instar main 49207b959, read from code)

- **People.** `UserManager`, `state/users.json`, `UserProfile { id, name, channels, permissions, telegramUserId?, slackUserId?, orgRole? }`. The `user-record` replicated store is dev-gated, omits `orgRole`, and has no live apply path, so the registry is effectively per machine.
- **Org roles.** `OrgRole` = guest, member, contributor, operator, admin, owner. `deriveRole(permissions, orgRole)` is the one resolver, and returns `member` when nothing is set. `RolePolicy` ceilings bind only the Slack gate, which is observe-only unless `enforcing` is set.
- **Phones.** `DeviceRecord.role` is `owner` or `msp`, and `userId` names the person (`MobilePeople.ts`). Since v1.3.1631 an unknown role fails closed as `person-unknown`. `deviceAuthenticator` admits only `DEVICE_ALLOWLIST` routes. `ownerOnly: true` refuses non-owners, and many routes also check `person.role === 'owner'` in the handler. The notify-token branch returns before the rule lookup. `POST /mobile/pairing-codes` is bearer-only and accepts `role: 'msp'`; the owner's code hand-over is the consent. `approveOutcome` makes only `msp` phones code-only. Device records are machine-local. `forwardRevoke` is a one-shot fan-out with no outbox.
- **MSP switches.** `MspGrantStore`, plain JSON, `ownerConversations` and `slack`, written only through an owner phone's signed request. No signature is stored. `set()` rebuilds rows from known fields and deletes all-false rows.
- **Conversation check.** `mayUseConversation(person, ref, machineId, appOwner)` answers one yes or no. Routes call it by hand. The allowlist's `conversationRef` flag is read by nothing. For an MSP, every `telegram:*` ref is yes.
- **Open to any phone with no conversation check:** `GET /attention`, `GET /mobile/attention/:id`, `GET /sessions`, `GET /telegram/topics`, `GET /topic/list`, `GET /telegram/topics/:id/messages`, `POST /mobile/chat/:topicId`. `POST /sessions/:name/input` (owner phones) types straight into tmux, outside the inbound path.
- **Pushes.** Only `reply` is gated, and `reply` fires only from app conversations. `notice` and attention reach every phone.
- **Memory privacy.** The place decides the audience (`MemoryAudience.ts`). `privateAudience` returns `open` unless the agent is multi-person, and `sharedMemoryPeople` and operator keys can hold the count at one. `resolveMemoryOwner` falls back to `orgRole`. `isMultiPerson`, `observeSender` and `onInbound` all do nothing when privacy is off, and `onInbound` then returns `deliver`. Only `claude-code` has the sandbox adapter. Turning it on needs a boot, on each machine.
- **Signed, replicated records already exist.** `mobile-native-conversations` §4.6 and §4.8: a phone's signed request is stored whole as `origin`, with the accepting machine's `receipt`. `verifyRecordedOrigin` re-checks it on any machine against the replicated `MobileDeviceKeyLedger`. `appConversations` and `mobileDeviceKeyLedger` are replicated store kinds, always on with native conversations.
- **Dashboard.** The PIN unlocks the agent's token, so a PIN holder has the agent's whole read surface.
- **Fleet in the app.** One paired identity per agent, no central service, each agent with its own owner.

## 3. Proposed design

### 3.1 One role model

`OrgRole` stays the only role vocabulary. One pure module, `src/permissions/TeamAccess.ts`, maps a role to a **tier**:

| OrgRole | Tier | Plain meaning |
|---|---|---|
| owner | owner | Everything |
| admin | admin | Maintenance and agent management. Conversations only as the owner opens them, read-only |
| operator, contributor, member | member | Only the conversations granted, plus their own |
| guest | guest | Read only, on conversations granted |

`operator` and `contributor` keep their meaning for Slack action ceilings. In the app they are members. **MSP is not a role.** It is `relationship: 'msp'` on an admin: the same access, with a label saying the person is from outside the organization. Guest stays because it costs one operation check and covers a client or auditor who should see one conversation and not speak in it.

**A new phone role, `team`.** A `team` phone's standing comes from the access log (§3.3), read through `resolveStanding`. Its tier is the lower of the log and any explicit `orgRole` on the profile, so the registry can lower a team phone and can never raise it. Lower-of applies only to `team` phones, and an absent `orgRole` caps nothing.

**Existing phones do not change.** An `owner` phone stays as it is. An `msp` phone keeps exactly today's reach and limits: it is not read through tiers, and it gains nothing automatically. The owner can convert an MSP phone to an admin with one signed action in the app. This keeps "Updates never restrict existing agents", and it also never widens what an owner agreed to without asking them. Once the app has its People screen, the owner sees one prefilled offer per MSP: "Give <name> maintenance access".

**Code hygiene.** Every `=== 'msp'` and `role !== 'owner'` site is replaced by `isOwnerPerson` or `isNonOwnerPerson` helpers, so a `team` phone cannot fall through to owner behaviour (`memoryPersonId`, `conversationOwnerFor`, `senderPerson`, `approveOutcome`, the pairing message, `mspPeople`, the Slack send, and the `mspDeviceUserIds` filter in `wireMemoryPrivacy.ts`, or team phones would not count as people). A test bans the literal comparison outside `MobilePeople.ts`.

### 3.2 What actually protects what

Three layers, and each one matters:

1. **Phone routes.** Default deny, by tier.
2. **The access log.** Signed by a phone, so a session cannot forge it.
3. **Sessions.** Anything a non-owner can type into runs confined. Without this, layers 1 and 2 are decoration, because an unconfined session can read the agent's token and files.

So the rule is: **every `team` phone, at every tier, requires memory privacy**, and its own conversations always resolve to `person`, confined, even if the agent would otherwise read as one person and even if the person is in `sharedMemoryPeople`. `MemoryPlace` gains `alwaysPerson: true` for this. Team phones are excluded from the operator-key and shared-people folding.

**An unconverted `msp` phone is not behind layer 3 when privacy is off.** Its person can ask the agent for anything an owner-reach session can reach. The People read says so: "<name>'s chats run with the agent's full reach". This is today's fact made visible.

**Non-owner sends never reach an owner-reach session once a team phone exists.** With at least one active `team` phone, a send into a conversation whose session has owner reach is refused `403 read-only-owner-reach`, for team admins and `msp` phones alike. Otherwise a helper could ask that session for a member's private folder. Before this applies to an MSP, the invite sheet lists affected MSP phones, because the owner's invite is what turns it on.

**`POST /sessions/:name/input`, keys and attachments stay owner-only.** They bypass attribution and the per-message check.

**Stated limit.** The agent runs as the same computer user as these files. A session the owner runs could delete log rows. The log stops persuasion, confusion and casual tampering: a row without a valid signature is ignored. It does not stop a hostile owner-reach session on the machine. Such a session could delete rows, including a latest revocation, with no visible trace, or read the machine's key and forge machine-signed rows such as a rogue `phone-bind`. Replication makes a lone deletion come back from peers, but on a one-machine agent nothing detects it. The same limit is stated in owner-authentication.

### 3.3 The access log

A new append-only file `state/team-access/log.jsonl`, separate from `mobile-msp-grants.json`, so an older build never rewrites it. A new replicated store kind `teamAccess`, on whenever native conversations are on, the same way as `appConversations`, so every machine holds it. There is no second copy of the same fact: MSP switches stay in their file for `msp` phones, and a converted person moves to the log.

Each phone-written event stores the phone's whole signed request as `signedOrigin` (the envelope reserves `origin`), plus the accepting machine's `receipt`, using the §4.6 format and crypto. The app signs requests as it does today. A new `verifyTeamAccessOrigin` reuses the device-side signature, key-window and receipt checks from `AppRecordSignatures.ts`, and binds the path and method to the event type. `verifyRecordedOrigin` itself cannot be reused, because it requires a conversation path and a `text` field. Machine-written events (`phone-bind`, `place-applied`, `lower`) carry their own domain-separated signature under the machine's pinned identity key, checked in the store's ingest the way the key ledger checks its rows.

**Everything comes from the signed body.** The phone mints `personKey` and `eventId` and puts them in the body. The fold derives each event only from that body, never from fields stored beside it, and dedupes by the hash of the signed request, so re-appending an old grant changes nothing.

**Who a key belongs to.** The key ledger proves a key was active, not whose it is. So when a phone activates, and once at boot for phones already active, the machine writes `phone-bind { keyHash, deviceId, personKey or 'owner' }`. `owner-pin` names the owner's key. An MSP phone's key is bound as non-owner, so its signature on `owner-pin` counts for nothing on any machine.

**Order.** The fold is a deterministic reducer over a total order: the receipt's signed `receivedAt`, then `eventId`. A late row triggers a full re-fold, which is cheap at team size. So replicas holding the same events reach the same state, in any arrival order.

- Per person, and per person and conversation, the last event wins. On a tie, removal or the lower access wins.
- Owner events are folded first. An admin event then counts only if the admin held the needed standing in the owner-only state at that event's time. So an owner's removal beats that admin's concurrent grant.
- An event naming an unknown person, or signed by a key this machine's ledger does not know yet, is quarantined, and the fold reruns when the ledger or log gains rows. The ledger gains an ingest hook for this. **A quarantined removal or lowering is honoured at once,** because the safe direction needs no proof. A quarantined grant has no effect.
- A row that fails verification outright is ignored.

Events: `phone-bind`, `owner-pin`, `person-add { personKey, name, tier, relationship?, links }`, `person-set`, `person-remove`, `grant { personKey, ref, access }`, `grant-remove`, `place-applied { ref, rev, machineId }` (machine-signed, §3.5), `lower` (machine-signed, below). `phone-bind` is described below.

**Identity.** `personKey` is a random id minted at invite, the same on every machine. Folding the log writes a local `UserProfile` with that id and a channel `{ type: 'instar-app', identifier: personKey }`, and sets `orgRole`, so Slack on that machine agrees. An existing person is linked by their Slack or Telegram id in `links`.

**State is an in-memory fold**, rebuilt at boot and updated on append, so a request costs no file read. An unreadable log means no team phone is admitted: fail closed.

**Owner pin.** The first event on any agent is `owner-pin`, written by the owner phone's first invite. `resolveMemoryOwner` and `isOwnerProfile` read the pin first. From then on no `orgRole` edit can make someone the memory owner or an owner phone. If the owner has no profile, one is created.

**Who may write what.** The route checks this, and the fold checks it again, so a replicated row cannot exceed its signer's standing at that point in the log.

| Change | Owner phone | Team admin with `manageTeam` | Bearer token (the agent) |
|---|---|---|---|
| Add or change an admin, capabilities | yes, Face ID | no | no |
| Add a member or guest | yes | yes | no |
| Grant a conversation | yes | only one the admin owns or holds by its own grant, at no more than the access it holds, to a member or guest. Never one opened by an owner capability | no |
| Remove a grant, lower a tier, remove a person | yes | members and guests | yes |

The bearer path for removal writes a machine-signed `lower` event: it can take access away, never give it. An admin can never touch an owner or another admin.

**The agent asking.** When someone asks the agent to give access, the agent creates a typed proposal, `POST /team/proposals { personKey or name, change, expiresAt }`. It lands in the owner's People screen as Approve or Decline. Approve is the owner's signed write of exactly that change, so the text the agent wrote cannot define the action. Proposals are owner-only and never appear in an admin's Needs you.

### 3.4 Inviting someone

`POST /mobile/team/invites` (device-signed, owner, or admin with `manageTeam`) takes name, tier, optional `relationship`, and optional first grants. It checks §3.6, writes `person-add`, and returns a one-time link, which the app shares. The bearer `POST /mobile/pairing-codes` refuses `role: 'team'`. Its `msp` path stays as today.

Redeem requires the phone to declare `appCaps: ['standing']`, so an older app gets `426 app-update-required` with a plain message. A `team` phone is always code-only. The code goes to the inviter's phone, in the People screen, and they pass it on. An admin can approve only members and guests, through `GET /mobile/team/invites/:id`. `GET /mobile/device` gains `standing: { tier, relationship?, screens }`.

### 3.5 Conversations

`mayUseConversation` becomes `mayDo(person, ref, op)`, with `op` one of `read`, `send`, `upload`, `rename`, `delete`, `purge`. It is the one check, for tiers and for `msp` phones, whose answers do not change.

| | Own conversation | Granted `use` | Granted `read` |
|---|---|---|---|
| Member | all | read, send, upload | read |
| Guest | cannot create | read | read |
| Team admin | all | read, send, upload | read |

- Refusal is `404 unknown-conversation`, so a person cannot probe.
- Admin capabilities `ownerConversations` and `ownerTopics` open read only.
- An admin has no reach into a member's conversation without a grant. The owner can read everything, as today, and members are told.
- Every route with `conversationRef: true` gets a handler check, plus `POST /mobile/chat/:topicId` and `GET /telegram/topics/:id/messages`. A table test drives every flagged route with a member and a stranger's ref. List routes filter after any pool merge.

**Telegram and Slack keep their own read boundary.** Anyone in the Telegram group reads every topic there, and a Slack channel member reads that channel. No grant can narrow that. The People read flags it, and the grant sheet says so. A restricted person uses the app and is not added to the group. For a guest also in Telegram, read-only is an app rule only, and the row says so.

**History.** A grant opens the conversation's past and future, the same rule memory privacy uses for someone joining a group. The sheet says so.

**A granted conversation is a shared place with its own key.** Any conversation with a live grant to a non-owner resolves as `shared` with a per-conversation `placeKey`, never `soleReaderId`, whatever the Telegram count says. Telegram's `memoryPlaceKey` is group-wide today, so the per-topic key is computed at the inbound site and in `placeFor` for granted topics. Its session is confined and loads only that place's memory. The owner loses their private memory there while it is shared, and the sheet says so. When the last grant is removed the conversation returns to its earlier place. The shared folder is kept and is not merged into the owner's memory.

**A grant activates in two steps.** The grant event is written, then the machine running that conversation ends its live session, recomputes the place from the folded log, and writes a machine-signed `place-applied`. The person can read only after that event exists. Until then People shows "Waiting for <machine>". On one machine this is immediate.

A machine taking over a conversation pulls `teamAccess` from reachable peers before serving it. If none is reachable it serves with what it has, because an agent must work on a single machine. That leaves a stated window: a machine cut off at the moment of a grant can hold owner reach for that conversation until it next syncs.

**Revocation** takes effect on the phone's machine on the next request, and pushes stop. There is nothing to close: `events` is a cursor poll. What was already read cannot be recalled.

### 3.6 Memory privacy is required, and stays required

- At invite, native app conversations must be on (`mobilePairing.native.enabled`, which also turns on the replicated `teamAccess` log), and every installed machine must report memory privacy on, the sandbox working, and the `claude-code` framework. Unknown counts as no. Otherwise `409 memory-privacy-required`, with the reason.
- `POST /mobile/team/memory-privacy` (owner phone, Face ID) turns it on across machines, forwarding the signed request, then each machine restarts. The app shows the costs before Face ID: the owner's private memory is not used in shared groups, inbound agent-to-agent sessions are refused, and a Slack or Telegram channel keeps its own memory.
- At every request, `deviceAuthenticator` refuses a team phone with `403 memory-privacy-required` if privacy is off here or the sandbox failed, and raises one attention item. A forward to a peer last known to have privacy off is refused at the sender.
- A Codex-only agent cannot have team phones, because memory privacy has no sandbox adapter for it. The invite says so plainly. That adapter is memory privacy's own work, so it goes to the feedback queue.

### 3.7 Tiers on the server

Every `DEVICE_ALLOWLIST` entry declares `tier`. `ownerOnly: true` becomes `tier: 'owner'`, and `tier` is also checked on the notify-token branch. A test fails on an entry with no tier. In-handler owner checks stay for owner routes. For each route opened to admins, the handler check is replaced by `tierAtLeast(person, 'admin')`, listed in the PR. Every route not named below is `tier: 'owner'`. `msp` phones keep their current admission, proven by a status-table parity test.

| Tier | Routes |
|---|---|
| guest | `/health`, `/mobile/routes`, own device status, confirm, push, presence key, self-revoke; conversation list and read, media read, Telegram topic list and messages, all filtered by `mayDo` |
| member | adds create and send, upload |
| admin | adds `/mobile/machines`, `/mobile/health-issues` and its choices, `/mobile/jobs`, `/mobile/resources`, `/mobile/accounts`, `/mobile/spend`, `/mobile/pace`, `/sessions` (rows the admin may not read say "Private session"), `/mobile/sessions/close/*` and `/mobile/sessions/move/*` with the admin's own Face ID, `/attention` and `/mobile/attention/*` filtered as below, `/mobile/devices`, `/mobile/team/*` reads |
| owner | everything else: Files, Passwords and keys, Permission slips, Remote Desktop, Dashboard PIN, console pass, What I've learned, Messages, Insights, Plans, Promises, Proposals, Inside, Ideas, Development, Maturation, Other agents, session pane, typing, keys, attachments, new session, default, door, pairing approvals for owner phones, introducer |

Admin actions on the agent are these and no more: health quick actions, pause and resume a job, close or move a session, and two new device routes, `POST /mobile/agent/update` and `POST /mobile/agent/restart`, each with the admin's Face ID. Creating or editing a job stays with the owner, because jobs run with owner reach. Remote Desktop is whole-machine reach, so it stays with the owner.

**Needs you for admins** shows only items from an allowlist of maintenance sources. Anything else is owner-only, because attention text can quote conversations and approvals must not reach an admin.

**Pushes.** Every kind other than `reply` needs tier admin, and for admins goes through the same attention allowlist. `reply` pushes gain triggers for Telegram and Slack conversations with a live grant, so a member hears about replies. Bearer routes do not change. The token is the agent, not a person. A phone never holds it, and a non-owner never gets the PIN.

`RolePolicy` ceilings do not apply to the app. A member's action limit is the sandbox and the limited session key, not a tier number. A request like "deploy this" from a member reaches a confined session that cannot do it.

### 3.8 What each role sees in the app

Tabs come from `standing.screens`. The server enforces. The app shows a plain "You don't have access to this" on `403 tier-required` rather than "Not signed in".

- **Owner:** today's app, plus People under More, with Requests and Activity inside it.
- **Admin:** Home, Chat, Work (Sessions, Schedule), Capacity (Machines, Accounts, Spend), More (Phones, People).
- **Member:** Chat, and More with their own row and Sign out. A first-run card says who can see what, including that the owner can read their chats.
- **Guest:** Chat with no composer: "You can read this conversation".
- **Fleet screen:** agents the person belongs to, with a role badge each.

The People screen lists each person, tier, how they reach the agent, what they can see in one line, and any warning. Tapping a person opens the role, switches, conversations with Add and Remove, and Remove person. Every warning has a button or a clear next step.

### 3.9 Fleet

Each agent stays independent. There is no central service and none is required. A fleet is what one phone holds.

- Standing is per agent. An MSP with admin on ten client agents sees ten agents' health, and every read is signed separately to that agent.
- **Inviting across agents.** The owner picks a person and several agents they own. The app calls each agent's invite route with that agent's own signature, and the person's app takes the links in one flow, with one code per agent.
- **Removing across agents** is the same fan-out, retried by the app. Each agent's result is shown, and an unreached agent stays listed as "not removed yet".
- Person identity is not shared between agents.

### 3.10 The People read, and the second-person warning

`GET /team/people` (bearer) returns one row per person who can reach the agent, merged from the registry, active phones, the access log, Slack and Telegram allowlists, and observed senders. Each row has `reach`, `tier`, `sees` in plain words, and `warnings`. An unnamed sender appears as "Someone on Slack (U123)". `?scope=pool` merges peers and names any machine that did not answer, and the page never shows a partial list as complete. Telegram group membership cannot be listed in full, so a row says "Telegram: can't list everyone in the group".

The dashboard gains a People tab that reads it, for the owner. The agent answers "who has access?" from it. The app gets the same rows through `GET /mobile/team/people`: owner all, admin names and tiers, member own row.

**Reach tracking runs whatever the privacy setting.** A new `ReachablePeople` tracker has its own state, `state/reachable-people.json`. It records verified senders in `MemoryInboundTracker.onInbound`, before the privacy early-return, which covers every channel and stays off the delivery path. It counts from the same config lists through `countReachablePeople`. It feeds nothing in memory privacy and never flips multi-person. Its first boot uses `baselineFromConfig`, so one person with several ids is not a second person. Ids it treats as one person stay visible on the owner's People row: "Treated as you: Slack U1, iMessage ...".

An empty Telegram allowlist means anyone in the group can message the agent. That is normal for a one-person group, so it does not raise the count. The People read says "Anyone in the Telegram group can message the agent", and senders there count as they are seen.

**Second-person warning.** When memory privacy is off and someone besides the owner can reach the agent, the owner gets **one** attention item, keyed by condition, never one per person. The text gives counts only, because an MSP phone can read it until step 2: "2 people can reach this agent, and memory privacy is off, so what one person tells it can reach another. Say 'turn on memory privacy' to change this, or mark this as fine." An open allowlist reads "Anyone". `sharedMemoryPeople` are not counted. It blocks nothing. Self-heal does not apply: the fix is the owner's privacy choice, and turning it on automatically would restrict an agent.

- **Raised** through the Telegram adapter when there is one, and the local attention list when not. `POST /attention` needs Telegram, so it is not used.
- **The hold lives in the tracker,** because a re-raise reopens an item. It stores the count it last raised and raises again only for a higher count, so marking it done holds until someone new appears.
- **Evaluated on the lease holder** at boot, hourly, and on a new sender, over the union of this machine's and peers' observed senders from `GET /team/people?scope=pool`. An unreachable peer means a possible under-count and is never a reason to skip.
- **One more case, once per agent:** if the baseline folded a Slack id and a Telegram id into one person, each normally one human, one item asks "This agent treats Slack U1 and Telegram 42 as one person. If they are different people, turn memory privacy on." iMessage and WhatsApp handles are not asked about, because one person often has several.
- **Acting on it.** The agent's reference block tells it how to turn privacy on when the owner asks in their own chat: set `memoryPrivacy.enabled` on every machine and restart. This is the existing route, and the app's Face ID switch comes in step 2.

### 3.11 Audit

`logs/team-access.jsonl` records refusals, capped to one row per device, route and minute. Changes are already in the signed log, and message attribution is on the inbound log and app events. `GET /mobile/team/activity` (owner, admin read) shows plain lines: "Dana gave Sam access to 'Q4 planning'". The owner gets one attention item a day summarizing admin changes, only on days there were some. The refusal log is machine-local and retention-bounded, and Activity merges through the pool read.

### 3.12 Migration

- Every existing agent is unchanged. No row, no phone change, no widening, no restriction. Owner and `msp` phones behave as they do today.
- The only new thing an existing owner may see is the second-person item, and only if it is true.
- Restrictions begin only when an owner invites someone, and the invite says what changes.
- All new data is in new files.

## 4. Build order

1. **See who can reach the agent (first slice).** `ReachablePeople`, `GET /team/people`, the dashboard People tab, the second-person warning, the Registry First row. Nothing is restricted. For B2Lead this answers "who can reach this agent and what can they see", and closes the report's no-owner item.
2. **Member and guest phones, server.** `TeamAccess.ts`, access log and `teamAccess` kind, `team` role, invite routes, `mayDo`, tiers on the allowlist, read-only rule, `alwaysPerson`, shared place and two-step grants, privacy requirement and its turn-on route, pushes, literal replacement, audit.
3. **App People screens and member Chat** in `apps/instar-ios`, its own repository: People, Add person, grant sheet, Requests, Activity, tier-shaped tabs, 403 handling.
4. **Admin maintenance:** admin routes and layout, owner capabilities, convert an MSP phone, `manageTeam`.
5. **Fleet invite and remove,** role badges.
6. **Slack conversations in the app for members.**

Steps 2 and 3 are useful together, not separately. A user-facing step is done only after a real run as that role on a throwaway agent, per *Live-User-Channel Proof Before Done*.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Tier from log, lower-of for `team` | invariant | Authorization must be deterministic (Know Your Principal). |
| Route admission by tier | invariant | Enumerated ceilings. Default-deny by test. |
| `mayDo` | invariant | Existing invariant, extended, fail closed. |
| Who may write the log; fold re-check | invariant | The stored signature is the proof of a person's choice. |
| Team phones require memory privacy | invariant | The promise has no meaning without confinement. Applies only after an owner invites. |
| Granted conversation is a shared place; two-step activation | invariant | Privacy boundary; fail closed. |
| Read-only into owner-reach sessions | invariant | A fixed rule; begins only through the owner's invite. |
| `msp` phones unchanged until converted | invariant | Updates neither restrict nor widen without the owner. |
| Admin Needs you allowlist | invariant | Fail closed to owner-only. |
| Second-person warning | invariant | A deterministic count. It holds no authority: it only tells the owner. |

## Verify the state, not its symbol

- **Tier.** Symbol: a log row. State: "the owner or an allowed admin chose this". Corroboration: `verifyTeamAccessOrigin` against the replicated key ledger, and the fold's standing check. Unmeasurable: the row is ignored, or a failed log admits no team phone. Both directions: a deleted row is not detectable on one machine (§3.2), and a valid but stale row is bounded by replication.
- **Reach.** Symbol: allowlists, phones, observed senders. State: "this person can reach the agent". A silent reader in a Telegram group is not a sender, so the row says the list is incomplete. One human with two unlinked ids can read as two, and marking it fine covers that.
- **Grant applied.** Symbol: `place-applied`. State: the conversation's session is confined. Corroboration: it is written after the session ended and the place recomputed, and the spawn fails if confinement cannot apply. Unmeasurable: the grant stays pending.
- **Privacy required.** Symbol: `enabled` and the probe, read live, and each peer's report. State: team sessions are confined. Unknown refuses.

## Frontloaded Decisions

1. `OrgRole` is the one vocabulary. A tier is a projection. This supersedes frontloaded decision 1 of mobile-app-people-and-roles for new phones, and MSP becomes a relationship on an admin.
2. `msp` phones change only when the owner converts them. No automatic widening or narrowing, except the read-only rule the owner's own invite turns on.
3. Guest exists, as read-only.
4. New admins start with no conversation access, and owner capabilities open read only. This is my reading of the brief's "what of the owner's conversations and memory it may see is owner-granted".
5. `manageTeam` defaults on for a new admin, limited to members and guests and to what the admin may delegate (§3.3). Adding teammates is agent management, and an owner can switch it off.
6. Every team phone requires memory privacy, native app conversations, and the `claude-code` framework.
7. A grant opens past and future history.
8. The dashboard stays the owner's surface, with a People tab. No non-owner gets a PIN or console pass, and a per-person console is not built, because the native app is the team's interface.
9. Telegram and Slack keep their own read boundaries. Instar flags them.
10. No central service.
11. Access lives in a new signed, replicated log, not the MSP grants file.
12. Admin mutations are the enumerated list in §3.7. Jobs cannot be created or edited, and Remote Desktop stays with the owner.

## Open questions

*(none)*

## 5. Security

- A phone cannot reach an unlisted route, and a listed route without a tier fails a test.
- The bearer token cannot raise anyone, and a registry edit cannot raise a team phone or change the pinned owner.
- `404` prevents probing, and list filters run after the pool merge.
- Non-owner phones pass no Telegram sender id, as today.
- Conversation titles and proposal text are display data, never instructions.
- Stated limits: §3.2 (same computer user), §3.5 (a machine cut off at the moment of a grant).

## 6. Multi-machine posture

- **Access log: unified.** Replicated store kind `teamAccess` (registration, the resolved-flags injection, and a commit-observer branch, as `mobileDeviceKeyLedger` has), always on with native conversations, verified on every machine. Single-machine survivability holds: any machine can answer from its copy.
- **Device records: unchanged, machine-local.** machine-local-justification: physical-credential-locality.
- **Writes** go to any machine and replicate. Revoking is effective at the phone's machine on arrival, and the owner's screen shows a machine that has not caught up.
- **Reach tracking: machine-local operational state,** read through `?scope=pool`, which reports missing machines. Each machine sees only inbound it served, so the pool read is the complete view, and the warning is evaluated over it.
- **Refusal log: machine-local operational record,** bounded.
- **Privacy setting:** checked across machines at invite and at forward (§3.6).
- **Notices:** attention items go through the lease holder, one voice.

## 7. Agent awareness and migration parity

- `generateClaudeMd()` and the reference files gain a "Team roles and access" block and the Registry First row "Who can reach this agent?" → `GET /team/people`, with `migrateClaudeMd()` under a content guard.
- New route prefixes go in `CapabilityIndex.ts` and `WriteDomainRegistry.ts`, and the new state files in the backup manifest.
- No config default changes. No hook changes. No feature flag for step 1, because nothing is restricted. The reference block also says how to turn memory privacy on for an owner who asks.

## 8. Rollback

Step 1 is a plain revert. From step 2 on, older builds since v1.3.1631 refuse a `team` phone, and they never rewrite the access log. Builds before v1.3.1631 have no such check, and a hand downgrade to one needs team phones revoked first, the same procedure as MSP phones. Instar updates move forward only. A person converted from `msp` is `team`, so a rollback cannot restore their older reach. Conversation places fall back to their prior key, and shared folders stay on disk.

## 9. Tests

- Unit: tier map; lower-of, including no `orgRole` and an `msp` phone untouched; a banned-literal test; every allowlist entry has a tier; notify-token tier; `mayDo` for each tier, op and ref form; log fold with bad signature, fields changed beside the signed body, a re-appended old grant, standing exceeded, the same events in shuffled orders, an owner removal concurrent with an admin grant, a quarantined grant, a quarantined removal honoured at once, an MSP-signed `owner-pin`; an admin with `read` cannot grant `use`; owner pin beats `orgRole`; `alwaysPerson`; place with grants; `ReachablePeople` with privacy off.
- Integration (HTTP): a status table across owner, `msp` with no `orgRole`, admin, member, guest and removed person on every route; bearer cannot raise; admin limits; invite refusals; `426` from an older app; two-step grant; second-person item once, updated in place, suppressed for shared people.
- E2E: production init path, `/team/people` 200 with real wiring; a member reaches a granted conversation and gets `404` on another.
- Live: a real session proving a member cannot get another member's fact, or the owner's, in a granted conversation.

## Maturation plan

- **test-agent-live:** each step on a throwaway agent, with the simulator or a real phone.
- **dev-agent-live:** Echo, with a test member on a test phone.
- **fleet:** step 1 has no flag and ships live, so the warning is visible on its own. From step 2 there is no new flag: team phones ride `mobilePairing.native.enabled`, which is dark on the fleet today. An owner who wants a team turns it on through their agent. Graduating that switch fleet-wide belongs to the app work and is not needed for a team to start.
- **graduation criterion:** a real team of at least three people uses one agent for a week with no conversation reaching someone without a grant, and no message attributed to the wrong person.
- **dark-window:** if no team phone is paired within 30 days of step 3, record why on the Maturation board with a new date.

## Left behind

*(filled at convergence)*
