---
title: "Team roles and access: one role model across the app, server, Slack and Telegram, for one agent or a fleet"
slug: "team-roles-and-access"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "team-roles-and-access.eli16.md"
status: "draft"
---

## 1. Problem statement

Operator request (topic 136110, 2026-11-06 about 18:32 PST, recorded verbatim in the lane brief): "We need to continue to work towards an Instar agent being appropriate for an entire team not just for a single person". And: "that doesn't mean an entire team will have Admin access. In fact, the app should start supporting user roles that align with our user role infrastructure. This should also align with the MSP support that we've been working on. In other words and owner should have full access to everything all in MSP would have Admin type access to perform maintenance and agent management while other users might have access only to certain conversations, but not to all conversations." And: "The Instar app should have the goal of being the only interface needed for entire team to work with a single agent or a fleet of agents with various roles and access".

The Thursday B2Lead report (2026-11-05) says "For a team: not yet", and lists with no owner: "No warning to the owner when a second person reaches an agent with privacy off".

Today a phone is either the owner's (everything) or an MSP's (all Telegram topics, sessions and alerts, none of the maintenance screens). There is no way to give a person access to only some conversations, and an MSP cannot do the maintenance the role exists for, because every maintenance route is `ownerOnly`.

## 2. What exists (instar main 49207b959)

- **People.** `UserManager`, `state/users.json`, `UserProfile { id, name, channels, permissions, telegramUserId?, slackUserId?, orgRole? }`. Replicated through the `user-record` store, keyed on the sorted channel set; a profile with no channels has no cross-machine key (`deriveUserRecordKey` returns null).
- **Org roles.** `OrgRole` = guest, member, contributor, operator, admin, owner. `deriveRole(permissions, orgRole)` is the one resolver. `RolePolicy` gives each role an action ceiling (T0 to T4) and a floor only the owner reaches. Used by the Slack gate, which is observe-only unless `enforcing` is set.
- **Phones.** `DeviceRecord.role` is `owner` or `msp`, `userId` names the person (`MobilePeople.ts`). A role this build does not know fails closed as `person-unknown`. `deviceAuthenticator` admits only `DEVICE_ALLOWLIST` routes, and `ownerOnly: true` refuses non-owners. Device records are machine-local, with a pool read and a forwarded revoke with an outbox.
- **MSP switches.** `MspGrantStore`, `state/mobile-msp-grants.json`: `ownerConversations`, `slack`, per person, settable only by an owner phone's signature. The bearer token is refused on purpose.
- **Shared conversation check.** `mayUseConversation(person, ref, machineId, appOwner)`, one function called by every route that names a conversation and by reply pushes. For an MSP, every `telegram:*` ref is yes.
- **Routes open to any phone today, with no conversation check:** `GET /attention`, `GET /sessions`, `GET /telegram/topics`, `GET /topic/list`, `GET /telegram/topics/:id/messages`, `POST /mobile/chat/:topicId`. Attention pushes go to every phone.
- **Memory privacy.** `MemoryAudience.ts`: the place decides the audience (`owner`, `person`, `place`, `none`, `open`, `system`). An app conversation with one device person is private. All Telegram topics share one group audience, with sole-reader proof. A session outside the owner's private place runs sandboxed with a limited key. Off unless the owner sets `memoryPrivacy.enabled`. Active `msp` phones count toward multi-person. The per-message check ends a live session whose audience no longer matches.
- **Dashboard.** PIN unlocks the agent's token, so a PIN holder has the agent's whole read surface. An owner phone's Face ID gets a one-use console pass; an MSP phone does not.
- **Fleet in the app.** The app holds one paired identity per agent (`AgentStore`), and the Fleet screen reads each. There is no central service, and each agent has its own registry and owner. `mobile-pairing-introducer` adds another agent from a phone the owner already uses.

## 3. Proposed design

### 3.1 One role model

`OrgRole` stays the only role vocabulary, and `deriveRole` stays the only way a profile's role is read. This spec adds one pure module, `src/permissions/TeamAccess.ts`, that maps a role to a **tier**, the thing the app, server and pushes act on:

| OrgRole | Tier | Plain meaning |
|---|---|---|
| owner | owner | Everything |
| admin | admin | Maintenance and agent management. Conversations and memory only as the owner opens them |
| operator, contributor, member | member | Only the conversations granted, plus their own |
| guest | guest | Read only, on conversations granted |

`operator` and `contributor` keep their meaning for Slack action ceilings; in the app they are members. **MSP is not a role.** It is `relationship: 'msp'` on an admin: the same access, a label that says the person is outside the organization. A legacy device with `role: 'msp'` resolves to tier admin, relationship msp. The guest role is kept because it costs one check (`access: 'read'`) and covers the real case of a client or auditor who should see one conversation and not speak in it.

`resolveStanding(input)` returns `{ tier, relationship?, userId, name, capabilities, conversations }` or `unknown`. It is pure, and every surface calls it:

- phones, through `deviceAuthenticator`, once per request;
- the People read (§3.8);
- the Slack gate keeps `deriveRole` and `RolePolicy`, which read the same `orgRole`.

**Two places cannot disagree upward.** The raw `orgRole` can be written by the bearer token, a Slack admin registration, or the CLI, so anything that can talk the agent into a write could raise it. So for a phone, the effective tier is the **lower** of the signed access record (§3.3) and `deriveRole(profile)`. Registry edits can only lower a phone's standing; raising it needs the owner's signature. When an owner raises someone in the app, the same write also sets `orgRole`, so Slack and the app agree. The People read shows a mismatch in plain words ("Slack says admin. App access is still member.").

Phones: `DeviceRecord.role` gains `'team'`, meaning "read this person's standing". `owner` and `msp` keep working unchanged. Owner authority on a phone still comes only from a pairing whose code the owner alone received. Older builds read `team` as an unknown role and refuse the phone, which is the safe direction.

### 3.2 What each tier may do on the server

Every `DEVICE_ALLOWLIST` entry declares `tier: 'owner' | 'admin' | 'member' | 'guest'`, the lowest tier that may reach it. `ownerOnly: true` becomes `tier: 'owner'`. A unit test fails if any entry has no tier, so a new route cannot default open. Refusal is `403 tier-required`, or `403 owner-phone-required` for owner routes as today so existing apps keep their message.

Routes that show conversation content take the existing `conversationRef` check as well. This spec adds it where it is missing: `POST /mobile/chat/:topicId` and `GET /telegram/topics/:id/messages`. List routes (`/telegram/topics`, `/topic/list`, `/mobile/conversations`) filter rows through the same check after any pool merge.

| Route group | Owner | Admin | Member | Guest |
|---|---|---|---|---|
| Own phone status, confirm, push token, self-revoke | yes | yes | yes | yes |
| Conversation list, read | all | per §3.4 | granted and own | granted |
| Send, attach | all | per §3.4 | granted with `use`, and own | no |
| Create a conversation | yes | yes | yes | no |
| Needs you (attention) and its push | yes | yes | no | no |
| Sessions list | yes | names only for conversations it may not use: "Private session" | no | no |
| Session pane, typing, controls | yes | only for a conversation it may use | no | no |
| Machines, health issues and quick actions, Schedule, Resources | yes | yes | no | no |
| Accounts | yes | names and state | no | no |
| Spend, Pace, Promises, Plans, Insights, Inside, Proposals, Ideas, Development, Maturation, Other agents | yes | read | no | no |
| What I've learned | yes | their own only | their own only | no |
| Phones | all | all, read | own | own |
| People and access | manage | read, and manage members if `manageTeam` | own row | own row |
| Files, Passwords and keys, Permission slips, Dashboard PIN, console pass | yes | no | no | no |
| Remote Desktop | yes | only with `desktop` | no | no |
| Approve a waiting phone | yes | members and guests, with `manageTeam` | no | no |

Files stay owner-only because the browser reaches memory files. Secrets and permission slips are `credential-access` and `grant-authority` floor actions, which `RolePolicy` keeps for the owner. Emergency stop stays open to every tier that can send, as today.

Bearer-token routes do not change. The token is the agent itself, not a person. A phone never holds it, and a non-owner never gets the PIN.

`GET /mobile/device` gains `standing: { tier, relationship?, screens: [...] }`, so the app hides what the person cannot use. This is for tidiness only. The server enforces.

### 3.3 The access record, and who may change it

`MspGrantStore` is generalized in place, in the same file, so existing MSP switches need no migration and there is no second store for the same fact. A row gains optional fields:

```ts
interface AccessRow {
  ownerConversations: boolean; slack: boolean;      // existing
  tier?: 'admin' | 'member' | 'guest';              // absent on a legacy MSP row: admin
  relationship?: 'msp';
  ownerTopics?: boolean;                            // absent: see §3.4
  manageTeam?: boolean; desktop?: boolean;
  conversations?: Record<string, { access: 'read' | 'use'; grantedAt: string; grantedBy: string }>;
  setAt: string; setByDevice: string; rev: number;
}
```

No row, or an unreadable file, grants nothing. A `team` phone with no row is refused `403 no-access`.

**Who may change what:**

| Change | Owner phone | Admin phone with `manageTeam` | Bearer token (the agent) |
|---|---|---|---|
| Set someone to admin, change capabilities | yes, with Face ID | no | no |
| Add or remove a member or guest | yes | yes | no to add, yes to remove |
| Grant a conversation | yes | only one the admin may use, only to a member or guest | no |
| Revoke a grant, lower a tier, remove a person | yes | members and guests | yes |

The bearer token may take access away and never give it. Nothing that can talk to the agent can raise anyone, which is the same reasoning as the MSP switches. When a person asks the agent to give someone access, the agent offers it to the owner as a prefilled Approve or Decline in the app, through the existing attention path. Owner authority is unchanged by any of this: only the owner may change an admin.

Face ID uses the existing owner presence challenge, bound to the exact person and change. If the owner's phone has no presence key, the raise is refused with a plain reason and the app shows how to set it up.

An admin can never raise anyone to admin, never touch an owner or another admin, and never grant a conversation it cannot use itself. These are checked on the server. The owner gets one attention item per day summarizing changes made by admins, with a link to the Activity list.

### 3.4 Conversations

A conversation reference is the existing form: `<uuid>` for app, `telegram:<topic>`, `slack:<team>:<channel>[:<thread>]`. `mayUseConversation` stays the one check and gains:

- **Member, guest:** yes for conversations they own; yes for a ref in `conversations`, and `use` is required to send. Everything else no. Refusal is `404 unknown-conversation`, so a member cannot probe.
- **Admin:** as MSP today, with one new switch. `ownerTopics` opens Telegram topics. **Absent means on for a row or phone that existed before this change, and new invites write `false`.** This honours "Updates never restrict existing agents": an MSP paired before this change keeps exactly what it has, and the owner can close it. New admins start with no conversation access, as the operator's words say.
- **Admin reaching a member's conversation:** no, unless a per-conversation grant says so. The owner may read everything, as today.

Telegram and Slack keep their own read boundary. A person in the Telegram group reads every topic there, and a Slack channel member reads that channel; no Instar grant can narrow that. So the People read flags a member or guest who also appears in the Telegram allowlist ("Sam is in the Telegram group, so Sam can read all topics there"), and the grant sheet says the same. For a restricted person the app is the door, and they are not added to the group.

From the app, a member sees a Slack conversation only through a per-conversation grant. Slack sends from the app carry the person's own Slack id and standing, as MSP sends do today.

**History.** A grant opens the whole conversation, past and future, the same rule memory privacy uses for someone joining a group. The grant sheet says so.

**Revocation** takes effect on the next request. An open `events` stream for that conversation is closed, and pushes stop. Messages the person already read cannot be recalled.

### 3.5 Memory privacy

Goal: a member never sees another member's private facts, and a member's session never has owner reach.

1. **Members require memory privacy.** Inviting a member or guest is the owner's opt-in, so requiring it restricts nobody who did not ask. `POST /mobile/pairing-codes` for a member or guest answers `409 memory-privacy-required` unless `memoryPrivacy.enabled` is true and the sandbox probe passed. The app offers the owner one Face ID step to turn it on. MSP and admin phones do not require it, as today.
2. **It stays required.** `deviceAuthenticator` refuses a member or guest phone with `403 memory-privacy-required` whenever privacy is off or the sandbox is not working, and raises one attention item to the owner. Fail closed: their conversations stop until it is back.
3. **A granted conversation is a shared place with its own key.** `MemoryPlace` input gains the granted readers. Any conversation with a live grant to a non-owner resolves as `shared` with a per-conversation `placeKey`, never `soleReaderId`, whatever the Telegram reader count says. Without this, a Telegram topic in a group proved to have one human reader would keep owner reach while a member reads it. The session there is confined and loads only that place's memory. The owner loses their private memory in that conversation while it is shared, and the grant sheet says so.
4. **Changing a grant changes the audience.** A grant write ends the live session for that place straight away. The existing per-message check is the backstop. When the last grant is removed the conversation returns to its earlier place; the shared place's folder is kept and is not merged into the owner's memory.
5. **Own conversations** stay private: `person` audience, one folder per person. The GDPR export and erase already cover it.
6. **Counting.** Active `team` phones count toward multi-person, as `msp` phones do.
7. **Blanket owner switches under privacy.** With memory privacy on, `ownerConversations` becomes read-only. A non-owner send into an owner conversation is refused `403 read-only-under-privacy`, because that session has owner reach and could reach a member's private folder. With privacy off, behaviour is as today. Reading stays open: it shows what the owner chose to show.
8. **The owner can read everything,** as today. The invite and the member's first screen say so plainly.

### 3.6 Fleet

Each agent stays independent: its own registry, access rows and owner. There is no central service, and none is required (*No Feature May Require a Purchased Service*, *Decentralized by default*). A fleet is what one phone holds.

- **Standing is per agent.** The app shows the person's tier on each agent, and the Fleet screen shows each agent only for what the tier allows. An MSP with admin on ten client agents sees ten agents' health, with no crossing of data, because every read is signed separately to that agent.
- **Inviting across agents.** The owner picks a person and several agents they own in the app. The app calls each agent with that agent's own signed request and gets one link per agent. The person's app takes the links in one flow. Each agent's owner approval still applies; the existing introducer path means a phone already trusted by the owner needs no second code, for the owner's own phones only. A non-owner's phone always gets a code.
- **Removing across agents** is the same fan-out, and the screen reports each agent's result plainly. An agent that could not be reached stays listed as "not removed yet", and the app retries.

Person identity is not shared between agents. The same human is a separate profile on each, and the app only groups them by the owner's choice at invite time.

### 3.7 What each role sees in the app

The tab bar and lists come from `standing.screens`.

- **Owner:** today's app, plus People under More, and Activity under People.
- **Admin:** Home (what needs attention), Chat (own, plus what is opened), Work (Sessions, Schedule, Promises, Plans), Capacity (Machines, Accounts, Spend), More (the read pages in §3.2, Phones, People). An "MSP" badge shows on their row in People for everyone with access to People.
- **Member:** Chat only, with a list of own and granted conversations, and More with What I've learned, their own row, and Sign out. No Home tab. A first-run card says who can see what.
- **Guest:** Chat only, read-only: no composer, a line says "You can read this conversation".
- **Fleet screen:** agents the person belongs to, with a role badge on each. A member's row shows unread count, not machine health.

People screen, for those who can see it: each person, their tier, how they reach the agent (phone, Slack, Telegram, others), what they can see in one line, and any warning. Tapping a person opens: role, the switches, the conversation list with Add and Remove, and Remove person. Add person asks name and role, picks conversations, and produces the link to send. Every warning has a button that fixes it, per *Every warning needs a path to act*.

### 3.8 The People read, and the second-person warning

`GET /team/people` (bearer) and `GET /mobile/team/people` (phone, tier per §3.2) return one row per person who can reach the agent. A row merges the registry, active phones, access rows, Slack and Telegram allowlists and observed senders. Each row has `reach`, `tier`, `sees` in plain words, and `warnings`. An unnamed observed sender appears as "Someone on Slack (U123)". The phone route trims rows for an admin to names, tiers and reach, and gives a member only their own.

A `?scope=pool` read merges peers, tagged by machine, using the existing pool read. A peer that does not answer marks the result incomplete and names the machine; the page never shows a partial list as complete.

**Second-person warning.** When memory privacy is off and a person other than the owner has reached the agent, the owner gets one attention item: "A second person can reach <agent>, and memory privacy is off, so what one person tells it can reach the other." It has a button to turn privacy on and a Keep as is choice. It fires once per new person, is suppressed for people in `sharedMemoryPeople`, and it blocks nothing. This closes the B2Lead "no owner" item. Its reading comes from `MemoryPrivacy.isMultiPerson()`, which already computes this with privacy off. Self-heal does not apply: the fix is the owner's privacy choice, and no agent repair exists, so a first-detection notice is correct here. It is an informational decision item, not a monitor of a recoverable fault.

### 3.9 Audit

`logs/team-access.jsonl`, append-only, one line per change or refusal: time, actor (device id, person, tier), action, target person, target conversation, before and after, and for refusals the route and reason. Refusals are capped to one row per device, route and minute. Message attribution already exists through `senderUserId` on the inbound log and `senderName` on app events. Retention follows the other operational logs, and the file is machine-local.

`GET /mobile/team/activity` (owner, admin read) shows it in plain lines: "Dana gave Sam access to 'Q4 planning'".

### 3.10 Migration

- **Every existing agent is unchanged.** No row is added and no phone changes. Owner phones stay owners. An `msp` phone keeps today's reach, because absent `ownerTopics` means on, and gains the admin maintenance screens: that adds access, and the MSP role was defined as maintenance. The owner is told once, through an attention item on the first agent where an MSP phone exists, with a button to close it.
- **No restriction is on by default.** Member phones exist only after an owner invites one. Slack enforcement stays off. Memory privacy stays off until the owner turns it on.
- **No file rewrite.** All new fields are optional, read with defaults.
- **Older apps** on a member phone get `403` on screens they do not know to hide. Invite links require the app version that reads `standing`; older versions are told to update during pairing.

## 4. Build order

Each step is one PR, ships working, and is useful alone.

1. **See who has access (first slice).** `TeamAccess.ts` with the tier map and `resolveStanding`; `tier` on every `DEVICE_ALLOWLIST` entry, behaviour-identical, proven by a parity test against today's `ownerOnly`; `GET /team/people` and the owner phone read; the second-person warning; `standing` on `GET /mobile/device`. Nothing is restricted. For B2Lead this answers "who can reach this agent and what can they see", and closes the report's no-owner warning item.
2. **Member and guest phones.** `team` device role, access row, grants routes, `mayUseConversation` changes, the missing conversation checks, list filters, attention and push limits, memory rules in §3.5, audit.
3. **App People screens and member Chat** (`apps/instar-ios`): People, Add person, grant sheet, Activity, tier-shaped tabs.
4. **Admin maintenance.** Open the admin rows of §3.2, `ownerTopics`, read-only owner conversations under privacy, admin app layout.
5. **Admin manages members,** and pool forwarding of grant writes to the machine holding the phone (§6).
6. **Fleet invite and remove,** and role badges on the Fleet screen.
7. **Slack conversations in the app for members,** with per-conversation grants.

Live proof before calling each user-facing step done, per *Live-User-Channel Proof Before Done*: a real paired test phone or the simulator, on a throwaway agent, driven as that role.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Tier from role, lower of signed row and registry | invariant | Authorization must be deterministic (Know Your Principal). A wrong answer is a security fault, not a judgment call. |
| Route admission by tier | invariant | Enumerated ceilings, like `RolePolicy`. Default-deny by test. |
| `mayUseConversation` | invariant | Existing invariant, extended. Fail closed, `404`. |
| Who may change access | invariant | The signature is the only proof of the owner's choice; bearer can only lower. |
| Member requires memory privacy | invariant | The promise "a member never sees another member's private facts" has no meaning without the boundary. Applies only after the owner invites a member. |
| Granted conversation is a shared place | invariant | Privacy boundary; fail closed like the rest of `MemoryAudience`. |
| Second-person warning | judgment-candidate, exempt | Signal only. It blocks nothing and is read from an existing deterministic count; there is no arbiter because the owner decides. |

## Verify the state, not its symbol

- **Tier.** Symbol: `tier` on the access row and `orgRole` on the profile. State: "the owner chose this level for this person". Corroboration: the row is written only by a route that verified an owner or admin device signature, and each write is in the audit log. Unmeasurable (unreadable file, unknown tier): no access.
- **Reach in the People read.** Symbol: allowlists, phones, observed senders. State: "this person can reach the agent". Telegram group membership cannot be listed in full, so the row says "Telegram: can't list everyone in the group" rather than implying a complete list. An incomplete pool read says which machine is missing.
- **Second-person warning.** Symbol: `isMultiPerson()`. State: two humans can reach the agent. A detection error keeps the last value, and the item says only what was seen. Both directions are possible: one human with two unlinked ids may raise it, which the Keep as is choice covers, and a silent reader in a Telegram group is not a sender, so the Telegram caveat above applies.
- **Privacy required.** Symbol: `memoryPrivacy.enabled` and the probe result, read live. State: member sessions are confined. Corroboration: the spawn fails if the sandbox cannot apply, which is the existing boundary. A failed or unknown probe refuses member phones.

## Frontloaded Decisions

1. `OrgRole` is the one vocabulary; a tier is a projection, not a second model. This supersedes frontloaded decision 1 of mobile-app-people-and-roles ("role lives on the phone, not as a new OrgRole"): the phone's role remains valid data, and MSP is a relationship on an admin, which keeps that spec's point that MSP is not an org rank.
2. Phone authority is the lower of the signed record and the registry. Only a signature raises.
3. Guest exists, as read-only.
4. New admins start with no conversation access. Existing MSPs keep theirs until the owner closes it.
5. `manageTeam` defaults on for a new admin, limited to members and guests and to conversations the admin can use. `desktop` defaults off. The operator's words give an admin agent management, and adding teammates is agent management; the limits keep it from reaching the owner's space.
6. Members require memory privacy, checked at invite and at every request.
7. A grant opens past and future history.
8. The dashboard stays the owner's surface, with a read-only People page. No non-owner gets a PIN or console pass. The native app is the team's interface, which is the operator's stated goal, so a per-person console is not built.
9. Telegram and Slack keep their own read boundaries; Instar flags them and does not pretend to narrow them.
10. No central service. A fleet is what one phone holds, with signed fan-out.
11. Reuse the MSP grants file rather than add a new store.

## Open questions

*(none)*

## 5. Security

- A member phone cannot reach any unlisted route, and a listed route without a tier fails a test.
- Bearer cannot raise anyone. An agent talked into a registry edit can only lower a phone.
- `404` on refused conversations prevents probing. List filters run after the pool merge.
- Sender attribution is unchanged: non-owner phones pass no Telegram sender id.
- Pushes: reply pushes use `mayNotify`; attention pushes now require tier admin. The notify read token follows the same tier.
- Grant text from a person, such as a conversation title, is display data, never instructions.
- Stated limit, as in owner-authentication: an agent running as the same computer user as these files could edit them directly. This stops mistakes, confusion and persuasion, not a hostile agent on its own machine. The audit log and the change alert make such an edit visible.

## 6. Multi-machine posture

- **Access rows: machine-local, on the machine that holds the person's phones.** machine-local-justification: physical-credential-locality. A row is consulted only when a phone's key verifies, which happens only on the machine holding that device record (mobile-device-keys §4). If a member re-pairs on another machine, access starts empty there: fail closed toward less access.
- **Writes reach the right machine.** The owner's phone may be on a different machine from the member's. A grant or revoke for a person whose phone is on a peer is forwarded through the same forward-and-outbox path revoke uses, and the People screen shows "waiting for <machine>" until the peer confirms (build step 5). Until step 5 ships, the routes answer `409 person-on-other-machine` and name the machine; nothing is silently saved on the wrong one.
- **Person ids** are `{ machineId, userId }` wherever stored, as `ownerPerson` already is. A phone-only person gets a channel `{ type: 'instar-app', identifier: <random id> }`, so `deriveUserRecordKey` works and the registry replicates them.
- **People read:** proxied on read (`scope=pool`), operational state, reports missing peers.
- **Audit log:** machine-local operational record, bounded (*Decision Provenance*, Cross-Machine Coherence boundary). Activity merges through the pool read.
- **Memory privacy setting** must be on across machines, per its own spec. A member phone is checked on the machine it signs to, which is the machine that spawns or forwards its session. A forwarded send to a peer with privacy off is refused by the existing per-message path, and the read of `enabled` on that peer is part of the pool health warning in People.
- **Notices:** the second-person item uses the attention store, which is gated to one voice by the lease holder.

## 7. Agent awareness and migration parity

- `generateClaudeMd()` and the reference files gain a "Team roles and access" block: tiers, who can change what, that the agent can remove access but never give it, how to offer the owner an approval, and the Registry First row "Who has access?" → `GET /team/people`.
- `migrateClaudeMd()` adds it behind a content guard.
- New route prefixes are classified in `CapabilityIndex.ts`, with a write domain in `WriteDomainRegistry.ts`.
- No config default changes. No hooks change. There is no feature flag for step 1, because nothing is restricted. Steps 2 onward are live only through an owner action.

## 8. Rollback

Step 1 is a plain revert. From step 2 on, a revert must not turn `team` phones into owners, and it cannot: every build since 1.3.1627 refuses an unknown role with `person-unknown`. Older apps and builds see a member phone as refused, which is the safe direction. Access-row fields are ignored by older builds; a write by an older build drops them, which removes access and does not raise it. Conversation places revert to their prior key, and shared-place folders stay on disk.

## 9. Tests

- Unit: tier map, every `OrgRole`; `resolveStanding` both sides of every rule, including lower-of; a raised `orgRole` with no signed row stays low; `DEVICE_ALLOWLIST` every entry declares a tier; parity of `tier: 'owner'` with the old `ownerOnly` set; `mayUseConversation` for each tier and ref form; store defaults and corrupt file; place resolution with grants.
- Integration (HTTP): owner, MSP, member, guest, unknown across a table of routes, asserting status and that rows are filtered; bearer cannot raise; admin limits; `memory-privacy-required` at invite and per request; second-person item fires once and is suppressed for shared people.
- E2E: production init path, `/team/people` returns 200 with real wiring; a member phone reaches its granted conversation and gets `404` on another.
- Live: a real session proving a member cannot get another member's fact, or the owner's, in a granted conversation.

## Maturation plan

- **test-agent-live:** each step on a throwaway agent with real phones or the simulator.
- **dev-agent-live:** Echo, with a test member on a test phone.
- **fleet:** no flag. The steps ship live and do nothing until an owner invites someone.
- **graduation criterion:** a real team of at least three people uses one agent for a week with no conversation reaching someone without a grant, and no message attributed to the wrong person.
- **dark-window:** if no member phone is paired within 30 days of step 3, record why on the Maturation board with a new date.

## Left behind

*(filled at convergence)*
