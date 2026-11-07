---
title: "Team roles and access: one role model across the app, server, Slack and Telegram, for one agent or a fleet"
slug: "team-roles-and-access"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "team-roles-and-access.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched); the product direction is Justin's 2026-11-06 words in topic 136110, and the lane brief gives the design decisions to this session"
lessons-engaged: "updates-never-restrict-existing-agents; decentralized-by-default; every-warning-needs-a-path-to-act; user-setup-must-be-trivial; never-require-a-purchased-third-party-service; Know Your Principal; Session Input Is a Principal; Cross-Machine Coherence; Bounded Notification; Signal vs Authority"
review-convergence: "2026-11-07T03:28:18.575Z"
review-iterations: 6
review-completed-at: "2026-11-07T03:28:18.575Z"
review-report: "docs/specs/reports/team-roles-and-access-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
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

`OrgRole` stays the only role vocabulary. This unifies who may do what in the app and on the server, under shared role names. Channel identity and what a channel lets people read stay with each channel, and Slack's action gate is unchanged (Frontloaded 12). One pure module, `src/permissions/TeamAccess.ts`, maps a role to a **tier**:

| OrgRole | Tier | Plain meaning |
|---|---|---|
| owner | owner | Everything |
| admin | admin | Maintenance and agent management. Their own conversations, and others only as granted; the owner's capabilities open read-only |
| operator, contributor, member | member | Only the conversations granted, plus their own |
| guest | guest | Read only, on conversations granted |

`operator` and `contributor` keep their meaning for Slack action ceilings. In the app they are members. **MSP is not a role.** It is `relationship: 'msp'` on an admin: the same access, with a label saying the person is from outside the organization. Guest stays because it costs one operation check and covers a client or auditor who should see one conversation and not speak in it.

**A new phone role, `team`.** A `team` phone's standing comes from the access log (§3.3), read through `resolveStanding`. Its tier comes from the log alone. A registry edit to `orgRole` has no effect on a team phone in either direction, so nothing the agent can be talked into editing can raise one. Lowering goes through the log too, as a `lower` event (§3.3).

**Existing phones do not change until conversion or the owner's first invite (§3.12).** An `owner` phone stays as it is. An `msp` phone keeps today's reach and limits until an owner's act changes them (§3.12): it is not read through tiers, and it gains nothing automatically. The owner can convert an MSP phone to an admin with one signed action in the app. This keeps "Updates never restrict existing agents", and it also never widens what an owner agreed to without asking them. Once the app has its People screen, the owner sees one prefilled offer per MSP: "Give <name> maintenance access".

**Code hygiene.** Every `=== 'msp'` and `role !== 'owner'` site is replaced by `isOwnerPerson` or `isNonOwnerPerson` helpers, so a `team` phone cannot fall through to owner behaviour (`memoryPersonId`, `conversationOwnerFor`, `senderPerson`, `approveOutcome`, the pairing message, `mspPeople`, the Slack send, and the `mspDeviceUserIds` filter in `wireMemoryPrivacy.ts`, or team phones would not count as people). A test bans the literal comparison outside `MobilePeople.ts`.

### 3.2 What actually protects what

Three layers, and each one matters:

1. **Phone routes.** Default deny, by tier.
2. **The access log.** Signed by a phone, so a session cannot forge it.
3. **Sessions.** Anything a non-owner can type into runs confined. Without this, layers 1 and 2 are decoration, because an unconfined session can read the agent's token and files.

So the rule is: **every `team` phone, at every tier, requires memory privacy**, and its own conversations always resolve to `person`, confined, even if the agent would otherwise read as one person and even if the person is in `sharedMemoryPeople`. `MemoryPlace` gains `alwaysPerson: true` for this. Team phones are excluded from the operator-key and shared-people folding.

**An unconverted `msp` phone is not behind layer 3 when privacy is off.** Its person can ask the agent for anything an owner-reach session can reach. The People read says so: "<name>'s chats run with the agent's full reach". This is today's fact made visible.

**Non-owner sends never reach an owner-reach session once team access is on.** Team access turns on with the first invite, recorded by a `team-on` event. It stays on until the owner's `team-off` (`POST /mobile/team/off`, Face ID), which removes every person and grant; revoking a phone does not turn it off. While it is on, a send into a conversation whose session has owner reach is refused `403 read-only-owner-reach`, for team admins and `msp` phones alike. Otherwise a helper could ask that session for a member's private folder. Before this applies to an MSP, the invite sheet lists affected MSP phones, because the owner's invite is what turns it on.

**`POST /sessions/:name/input`, keys and attachments stay owner-only.** They bypass attribution and the per-message check.

**Stated limit.** The agent runs as the same computer user as these files. A session the owner runs could delete log rows. The log stops a confined session from forging access, and stops confusion and casual tampering: a row without a valid signature is ignored. It does not make the agent immune to persuasion in general: see the scheduled-jobs limit in §5. It does not stop a hostile owner-reach session on the machine. Such a session could delete rows, including a latest revocation, with no visible trace, or read the machine's key and forge machine-signed rows such as a rogue `phone-bind`. Replication makes a lone deletion come back from peers, but on a one-machine agent nothing detects it. The same limit is stated in owner-authentication.

### 3.3 The access log

A new append-only file `state/team-access/log.jsonl`, separate from `mobile-msp-grants.json`, so an older build never rewrites it. A new replicated store kind `teamAccess`, on whenever native conversations are on, the same way as `appConversations`, so every machine holds it. There is no second copy of the same fact: MSP switches stay in their file for `msp` phones, and a converted person moves to the log.

Each phone-written event stores the phone's whole signed request as `signedOrigin` (the envelope reserves `origin`), plus the accepting machine's `receipt`, using the §4.6 format and crypto. The app signs requests as it does today. A new `verifyTeamAccessOrigin` reuses the device-side signature, key-window and receipt checks from `AppRecordSignatures.ts`, and binds the path and method to the event type. `verifyRecordedOrigin` itself cannot be reused, because it requires a conversation path and a `text` field. Machine-written events (`phone-bind`, `place-applied`, `lower`) carry their own domain-separated signature under the machine's pinned identity key, checked in the store's ingest the way the key ledger checks its rows.

**Everything comes from the signed body.** A request's body carries `events[]`, because one action can be several events: an invite with first grants, or a first write that also adds `owner-pin`. The phone mints each `personKey` and `eventId` in that body, and reads what it must sign, such as the owner's ids for `links` and the pinned `personKey`, from `GET /mobile/team/context`, an owner-only read, first. The fold derives events only from the body, never from fields stored beside it, and dedupes by request hash plus `eventId`, so re-appending an old grant changes nothing.

**Who a key belongs to.** The key ledger proves a key was active, not whose it is. So under the append lock, before any write's own line, the machine writes a missing binding for the signer; and once team access is on, when a phone activates, when it is reassigned or converted, and once at boot for active phones that have none, it writes `phone-bind { keyHash, deviceId, personKey, or 'owner' or 'msp' }`. Bindings are versioned: the fold reads a signer's standing from the binding in force at that event's position in the order, so an owner phone reassigned to an MSP keeps no owner standing afterwards. An MSP phone's key is bound as non-owner, so its signature on `owner-pin` counts for nothing on any machine.

**The reducer.** The fold is one deterministic algorithm, so replicas holding the same events reach the same state, in any arrival order. A late row triggers a full re-fold, which is cheap at team size.

1. Take every verified event. Each row has a monotonic `seq` from the machine that accepted it, assigned under the append lock and machine-signed with the row, so a clock moving backward cannot reorder one machine's events. Events from one machine keep their `seq` order. Across machines, merge those per-machine sequences by repeatedly taking the smallest next event by the tuple (signed time, hash, position): the receipt's `receivedAt` and the request hash and position in `events[]`, or for a machine-written event its own signed time, its own hash, and position 0. This is the order. A request is one log line, so it is atomic: all its events apply or none, so an invite's grants always follow its `person-add`.
2. Walk the owner's and machine-written events in that order, building the standing timeline: who held which role and capability at each point.
3. Walk all events in that order. An admin event is accepted only if the timeline gave the signer the needed standing at that event's time. A `signer-cut` voids only that signer's widening events (`grant`, `person-add`, raises), and only those before a later owner re-promotion. Their removals stand.
4. Per person, and per person and conversation, the last accepted event wins. There is no other tie rule.

This gives convergence, not causality: machine clocks differ, so a grant made in the seconds around an admin's removal may stand. **An admin's past grants survive the admin's removal,** because they were valid when made, and the same goes for an admin who loses a conversation. Nothing cascades unless the owner asks. Removing an admin shows the owner everything that admin granted, with one Remove all button. Remove all writes `signer-cut { personKey }`, which voids every grant by that admin, including one that arrives later from a disconnected machine, so it covers the clock case.

- An event naming an unknown person, or signed by a key this machine's ledger does not know yet, or by a machine key this machine cannot look up yet, is quarantined, and the fold reruns when the ledger or log gains rows. The ledger gains an ingest hook for this. A quarantined event is not accepted, whichever way it points. If it carries a valid machine receipt and would remove or lower access, the person's affected access is **held** until the row verifies: a temporary denial, kept apart from accepted state, and cleared when the row is either applied or dropped. A row with no valid receipt holds nothing, so an unknown key cannot lock anyone out.
- A row that fails verification outright is ignored.

Events: `team-on`, `team-off`, `conversation-own { ref, personKey }` (machine-signed when a team person creates a conversation, so every machine agrees who owns it), `phone-bind`, `owner-pin`, `privacy-required`, `person-add { personKey, name, role, relationship?, links }`, `person-set`, `person-remove`, `grant { personKey, ref, access }`, `grant-remove`, `signer-cut`, `place-applied { ref, generation, machineId }` (machine-signed, §3.5), `lower` (machine-signed, below). `phone-bind` is described below.

**Identity.** Events carry the full `OrgRole`, and the tier is derived from it, so `operator` and `contributor` survive for Slack. `personKey` is a random id minted at invite, the same on every machine. Folding the log writes a local `UserProfile` with that id and a channel `{ type: 'instar-app', identifier: personKey }`, and writes `orgRole` as a one-way copy of the log's role, so Slack on that machine agrees. The fold never reads that copy back. `person-remove` clears it. An existing person is linked by their Slack or Telegram id in `links`. Only the owner may set `links`, because they join authorization identities: an admin's invite carries none. The fold ignores a link naming the owner's id or an id already linked to someone else, and a link changes only the channel fields of a profile, apart from the `orgRole` copy above.

**State is an in-memory fold**, rebuilt at boot and updated on append, so a request costs no file read. A log whose highest `seq` is below last-good's counts as lost, and `seq` is seeded from last-good; an unreadable last-good seeds from the log. An agent that never invited anyone writes no access files at all. Each append is fsynced before the route answers, so a torn final line was never acknowledged, and boot truncates it to the last newline before any append. Any other read or parse failure means the log is unreadable. Beside the log, a small separately fsynced file, `state/team-access/confined.json`, lists every ever-confined conversation with its fixed audience (its `placeKey`, or for a person's own conversation their `personKey`), written before the event that makes one so, and it survives `team-off` and a restore. An empty one is written and fsynced before the first `team-on`, so an invite with no grants does not read as a missing file. Place resolution, the spawn refusal and the join check always read the log together with this file, not the log alone. With the log unreadable, no team phone is admitted, team access counts as on, and every conversation in that file is refused on every channel. Scheduled jobs and owner messages to anything not in that file run as today. If this file is unreadable, or missing while the log holds `team-on` or is itself unreadable or missing with any sign of past team use (a `team` device row, a last-good file holding `team-on`, a non-empty confined list, or a stored `senderRole: 'team'` row), whatever the log says, all conversation spawns are refused until the owner's restore, because a readable log may be an older one. Job checks read this list directly, because the audience reads as `open` with privacy off. The attention item names the fix: `POST /mobile/team/restore` (owner phone, Face ID) restores `log.last-good` and `confined.last-good`, written after each clean boot to `state/team-access-last-good/`, and rebuilds the confined list from the union of what remains of it and every conversation whose stored messages came from a team phone, which needs no snapshot. Those rows carry `senderRole: 'team'`, which `AppConversationStore` learns to keep; `msp` rows and Telegram group members do not count. Only if both the confined list and the log were lost, every conversation other than system and job-bound topics is treated as confined, because a read-only grantee leaves no message behind. That is the conservative answer to a double failure, and the restore screen says so. With the log intact there is no sweep, because the log and the rebuild above cover its grants. A rebuilt entry's audience is its `ownerPerson`, else a per-conversation `placeKey`. Restore merges by `eventId` every row that still parses rather than overwriting, so revocations survive. It reruns the `phone-bind` backfill, drops every resume binding for a confined conversation, and says a restore can bring back access revoked since. With no snapshot and no readable rows it starts an empty log and keeps the rebuilt list. A confined conversation with no surviving event keeps its stored audience, and nobody but the owner reaches it until a new signed grant.

**Owner pin.** `owner-pin { personKey, links }` pins the owner as a person, not a key, and is written by the owner phone's first team write. In 2a that is the first invite, and turning memory privacy on writes no access files. `links` holds the owner's Telegram and Slack ids. It may ride in any write route's `events[]`, and `phone-bind` rows may come before it. Every phone bound as `owner` has owner standing, so a second or replaced owner phone works without a new pin. If two machines pin at once the earliest wins, and the other's owner events are read as the winner's person. `GET /mobile/team/context` returns the resolved owner's existing profile id, and the pin reuses it as `personKey`, so an owner with no Telegram or Slack is not split in two. A new key is minted only when no owner profile exists, and the mint also records the old `operator` id as the same person. If several profiles claim to be the owner, the invite is refused with a plain reason. On each machine the fold matches an existing profile by `personKey`, then by those links, before creating one. `resolveMemoryOwner` and `isOwnerProfile` read the pin first. From then on no `orgRole` edit can make someone the memory owner or an owner phone.

**Who may write what.** The route checks this, and the fold checks it again, so a replicated row cannot exceed its signer's standing at that point in the log.

| Change | Owner phone | Team admin with `manageTeam` | Bearer token (the agent) |
|---|---|---|---|
| Add or change an admin, capabilities | yes, Face ID | no | no |
| Add a member or guest | yes | yes | no |
| Grant a conversation | yes | only one the admin holds by its own grant, at no more than the access it holds, to a member or guest. Never one opened by an owner capability | no |
| Remove a grant, lower a tier, remove a person | yes | members and guests | yes |
| Require memory privacy (`privacy-required`) | yes, Face ID | no | no |
| Remove all of an admin's grants (`signer-cut`) | yes | no | no |
| Turn team access off (`team-off`; `team-on` rides the first invite) | yes, Face ID | no | no |

The bearer path for removal writes a machine-signed `lower` event: it can take access away, never give it. An admin can never touch an owner or another admin.

**The agent asking.** When someone asks the agent to give access, the agent creates a typed proposal, `POST /team/proposals { personKey or name, change, expiresAt }`. It lands in the owner's People screen as Approve or Decline. Approve is the owner's signed write of exactly that change, so the text the agent wrote cannot define the action. Proposals are owner-only and never appear in an admin's Needs you. A member's confined session may call this route too: it is added to the session-token allowlist, the requester is taken from the session and never from the body, and each person may have one open proposal. A shared place's session has no single person, so there the requester reads "someone in <conversation>", with one open proposal per place. `GET /team/people` stays refused to a session token, so a member who asks "who has access?" gets a plain answer from their own session: "Only the owner can see that." 

### 3.4 Inviting someone

`POST /mobile/team/invites` (device-signed, owner, or admin with `manageTeam`) takes name, an explicit `role` (an `OrgRole` other than `owner`, which is refused; the server derives the tier, and for a linked person the app shows their current role from `GET /mobile/team/context` so the signed body always states it), optional `relationship`, and optional first grants. It checks §3.6, writes `person-add`, and returns a one-time link, which the app shares. The bearer `POST /mobile/pairing-codes` refuses `role: 'team'`. Its `msp` path stays as today.

Redeem requires the phone to declare `appCaps: ['standing']`, so an older app gets `426 app-update-required` with a plain message. A `team` phone is always code-only. The code goes to the inviter's phone, in the People screen, and they pass it on. An admin can approve only members and guests, through `GET /mobile/team/invites/:id`. An invite is bound to its `person-add` event, or for a replacement phone (§4.1) to that person's latest event. At redeem and again at activation the server re-checks that the person is still in the log at that tier and that the inviter still holds the standing, and a removal or tier change voids any open invite. `GET /mobile/device` gains `standing: { tier, relationship?, screens }`.

### 3.5 Conversations

`mayUseConversation` becomes `mayDo(person, ref, op)`, with `op` one of `read`, `send`, `upload`, `rename`, `delete`, `purge`. It is the one check, for tiers and for `msp` phones, whose answers do not change.

| | Own conversation | Granted `use` | Granted `read` |
|---|---|---|---|
| Member | all | read, send, upload | read |
| Guest | read only, on any they already own | read | read |
| Team admin | all | read, send, upload | read |

- Refusal is `404 unknown-conversation`, so a person cannot probe.
- Admin capabilities `ownerConversations` and `ownerTopics` open read only.
- An admin has no reach into a member's conversation without a grant. The owner can read everything, as today, and members are told.
- Every route with `conversationRef: true` gets a handler check, plus `POST /mobile/chat/:topicId` and `GET /telegram/topics/:id/messages`. A table test drives every flagged route with a member and a stranger's ref. List routes filter after any pool merge.

**Telegram and Slack keep their own read boundary.** Anyone in the Telegram group reads every topic there, and a Slack channel member reads that channel. No grant can narrow that. The People read flags it, and the grant sheet says so. A restricted person uses the app and is not added to the group. For a guest also in Telegram, read-only is an app rule only, and the row says so.

A person's own conversation can never be granted to someone else, in any step, because its memory is theirs. To work together, the owner starts a conversation and grants it to both people.

**History.** A grant opens the conversation's past and future, the same rule memory privacy uses for someone joining a group. The sheet says so. So a reply from the old session that lands just after a grant shows the new reader nothing the history would not, and needs no separate fence on one machine.

**A granted conversation is a shared place with its own key.** Any conversation with a live or past grant to a non-owner resolves as a `shared` place, which gives the existing `place` audience, with a per-conversation `placeKey`, never `soleReaderId`, whatever the Telegram count says. Telegram's `memoryPlaceKey` is group-wide today, so the per-topic key is computed at the inbound site and in `placeFor` for granted topics, and the app inbound site, which hard-codes `private` today, takes the same path. `memorySessionGuard` treats every Telegram topic as one place today, so a session with a per-topic key is also held to that topic: it cannot post into another. Its session is confined and loads only that place's memory. The owner loses their private memory there while it is shared, and the sheet says so. A conversation that has ever had a non-owner grant, or that a team person created, stays confined for good, even after the last grant is removed or the person is gone, because its history holds text a non-owner wrote or steered, and that must never load into an owner-reach session. The place comes from the log, never from who sent the latest message, so an owner replying in a member's own conversation stays confined too. With memory privacy off, a spawn in such a conversation is refused by the spawn entries, whatever route asked, and one attention item says why. The sheet says so. The shared folder is kept and is not merged into the owner's memory.

**A grant activates in two steps.** The grant event is written. Then the machine that serves the conversation takes a new per-conversation lock inside `SessionManager`'s spawn entries, ends any live session, drops resume bindings that no longer match, recomputes the place from the folded log, writes a machine-signed `place-applied { ref, generation }`, and releases the lock. Each conversation has an access generation: a hash of the ids of every signed event that changed who can read it, so grant, revoke and regrant of the same person are three generations, and a late-arriving event changes it too. The person can read, send, get previews and get pushes only while a `place-applied` matches the current generation. Until then People shows "Waiting for <machine>", with Remove grant as the next step if that machine is gone. On one machine this is immediate. Every generation change does this, including a revoke, so a session another reader is using ends then too. After spawning, a session re-checks the generation and ends itself on a mismatch, which closes a spawn that resolved its place just before the lock.

A new `servingMachineFor(ref)` answers which machine that is, and never answers unknown: `ownerOf` for a Telegram topic or Slack channel, then the lease holder, then this machine. An app conversation uses the lease holder, then this machine. A pending generation is retried whenever ownership or the lease changes, so a dead machine does not leave a person waiting for good.

A session started after that point, on any machine and for any reason, resolves its place from the log, because every spawn does. So a move, a failover or an ordinary session end needs no new acknowledgment.

A machine taking over a conversation pulls `teamAccess` from reachable peers before serving it. If none is reachable it serves with what it has, because an agent must work on a single machine. That leaves a stated window: a machine cut off at the moment of a grant can hold owner reach for that conversation until it next syncs.

**Revocation** takes effect on the phone's machine on the next request, and pushes stop. There is nothing to close: `events` is a cursor poll. What was already read cannot be recalled.

### 3.6 Memory privacy is required, and stays required

- At invite, native app conversations must be on (`mobilePairing.native.enabled`, which also turns on the replicated `teamAccess` log), and every machine that answers must report native on, memory privacy on, the sandbox working, and the `claude-code` framework. Otherwise `409 memory-privacy-required`, with the reason. A machine that does not answer never blocks an invite on these live checks, because a sleeping laptop must not stop a team.
- **Every machine must understand team access.** A machine on an older build could pass the checks above and still serve Telegram or Slack by its old rules, because it knows nothing of grants. So each machine reports a `teamEnforcement` version, and the pool registry keeps each machine's last known version. An invite or grant is refused while any machine with status `active`, awake or asleep, is last known to be older, and People names it and offers the update, or to mark a retired machine as gone. A newer build refuses the serving lease while its copy of the log is behind a peer it can reach. A machine that returns on an old build after a grant exists is a stated limit: it cannot be made to refuse, so the owner is told at once, and machines update themselves.
- `POST /mobile/team/memory-privacy` (owner phone, Face ID) writes an owner-signed `privacy-required` log event. Phones cannot be forwarded to a peer, which has no record of them, so the log carries it: each machine applies each `eventId` once, records that it did, sets `memoryPrivacy.enabled`, and restarts when idle. An owner who later turns privacy off is not overridden; the team phones are refused until it is back. A machine with native off cannot receive the log, so the invite's refusal names that machine, and the agent turns native on there when the owner says so. The app shows the costs before Face ID: the owner's private memory is not used in shared groups, inbound agent-to-agent sessions are refused, a Slack or Telegram channel keeps its own memory, and the restart ends live sessions.
- At every request, on both the signed and the notify-token branch, `deviceAuthenticator` refuses a team phone with `403 memory-privacy-required` if privacy is off here or the sandbox failed, and raises one attention item. A late machine is covered by this check.
- A phone reaches the one machine that holds its record, and sends work only while that machine holds the serving lease. Team phones have this same limit as every phone, and People shows it. There is no forward from a phone to a peer today, but a conversation owned by another machine is delivered through the pool, and that envelope carries no `userId` for a non-owner phone. So `InboundSenderEnvelope` gains `personKey`, and the receiving machine resolves the sender from it. Any inbound path a machine serves, including a pool one, re-checks that machine's own current privacy setting, sandbox, the person, the access generation and the audience before injecting or spawning, and refuses if any differ.
- A Codex-only agent cannot have team phones, because memory privacy has no sandbox adapter for it. The invite says so plainly. That adapter is build step 8.

### 3.7 Tiers on the server

Every `DEVICE_ALLOWLIST` entry declares `tier`. `ownerOnly: true` becomes `tier: 'owner'`, and `tier` is also checked on the notify-token branch. A test fails on an entry with no tier. In-handler owner checks stay for owner routes. For each route opened to admins, the handler check is replaced by `tierAtLeast(person, 'admin')`, listed in the PR. Every route not named below is `tier: 'owner'`. The tier is only the first of three checks: after it come a capability check (for example `manageTeam` on the write routes) and an object check (`mayDo`, or the table in §3.3). The HTTP status table is generated from this list. `msp` phones keep their current admission, proven by a status-table parity test.

| Tier | Routes |
|---|---|
| guest | `/health`, `/mobile/routes`, `/topic/list` (filtered), own device status, confirm, push, presence key, self-revoke; `GET /mobile/team/people` (own row only); conversation list and read including `/events` and `/preview`, media read, Telegram topic list and messages, all filtered by `mayDo` |
| member | adds `POST /mobile/conversations`, the send routes, upload (which needs `native.media.enabled`, as for any phone), and `PATCH` and `DELETE /mobile/conversations/:key` and media purge, which `mayDo` allows only on their own conversations |
| admin | adds `POST /mobile/team/invites`, `GET /mobile/team/invites/:id`, the grant and person write routes, `POST /mobile/agent/update` and `/restart`, `POST /mobile/team/admin-challenge`, `/mobile/machines`, `/mobile/health-issues` and its choices, `/mobile/jobs` and its enable and disable, `/mobile/resources`, `/mobile/accounts`, `/mobile/spend`, `/mobile/pace`, `/sessions` (rows the admin may not read say "Private session"), `/mobile/sessions/close/*` and `/mobile/sessions/move/*` with the admin's own Face ID, `/attention` and `/mobile/attention/*` filtered as below, `GET /mobile/devices`, the `/mobile/team/*` reads |
| owner | everything else: Files, Passwords and keys, Permission slips, Remote Desktop, Dashboard PIN, console pass, What I've learned, Messages, Insights, Plans, Promises, Proposals, Inside, Ideas, Development, Maturation, Other agents, session pane, typing, keys, attachments, new session, default, door, pairing approvals for owner phones, introducer |

Admin actions on the agent are these and no more: health quick actions, pause and resume a job, close or move a session, and new device routes for the rest: `POST /mobile/jobs/:slug/enable` and `/disable` over the existing job routes, and `POST /mobile/agent/update` and `/restart`. Close, move, update and restart need the admin's own Face ID through a new `POST /mobile/team/admin-challenge`, limited to exactly those four actions, with its own gate. It does not widen the owner's `writeGate`, which guards slips, secrets and the session door: close and move gain a separate admin branch, and it needs no dashboard PIN. `GET /mobile/sessions/controls` opens to admins for those two actions. Job pause reaches jobs by their source, as the existing routes do. Creating or editing a job stays with the owner, because jobs run with owner reach. Remote Desktop is whole-machine reach, so it stays with the owner.

**Needs you for admins** shows only items whose `category` is `monitoring`, `degradation`, `agent-health`, `infrastructure` or `system`, and never one whose `contextTopicIds` name a conversation the person may not read. An item's `topicId` is only where it was delivered, so it is not read here. An item with no conversation reference shows a fixed label, "A monitoring item needs attention", and no producer text, because category says what the problem is, not who may read its words. Anything else is owner-only, because attention text can quote conversations and approvals must not reach an admin. Sessions are a separate rule: a row the person may not read says "Private session".

**Pushes.** Every kind other than `reply` needs tier admin, and for admins goes through the same attention allowlist. `reply` pushes gain triggers for Telegram and Slack conversations with a live grant, so a member hears about replies, and `/mobile/push/notify` widens from app keys to those refs. Their preview stays "New reply" until step 7. Bearer routes do not change. The token is the agent, not a person. A phone never holds it, and a non-owner never gets the PIN.

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

The console gains a "Who can reach me" page in its People group that reads it, for the owner. The agent answers "who has access?" from it. The app gets the same rows through `GET /mobile/team/people`: owner all, admin names and tiers, member own row.

**Reach tracking runs whatever the privacy setting.** A new `ReachablePeople` tracker has its own state, `state/reachable-people.json`. It records verified senders in `MemoryInboundTracker.onInbound`, before the privacy early-return, which covers every channel and stays off the delivery path. It counts from the same config lists through `countReachablePeople`. It feeds nothing in memory privacy and never flips multi-person. Its first boot uses `baselineFromConfig`, so one person with several ids is not a second person, and the first sender on a platform with no list counts as the owner arriving there. Ids it treats as one person stay visible on the owner's People row: "Treated as you: Slack U1, iMessage ...".

An empty Telegram allowlist means anyone in the group can message the agent. That is normal for a one-person group, so it does not raise the count. The People read says "Anyone in the Telegram group can message the agent", and senders there count as they are seen.

**Second-person warning.** When memory privacy is off and someone besides the owner can reach the agent, the owner gets **one** attention item, keyed by condition, never one per person. The text gives counts only, because an MSP phone can read it until step 2: "2 people can reach this agent, and memory privacy is off, so what one person tells it can reach another. Say 'turn on memory privacy' to change this, or mark this as fine." An open allowlist reads "Anyone". `sharedMemoryPeople` are not counted. It blocks nothing. Self-heal does not apply: the fix is the owner's privacy choice, and turning it on automatically would restrict an agent.

- **Raised** through the Telegram adapter when there is one, and the local attention list when not. `POST /attention` needs Telegram, so it is not used.
- **The hold lives in the tracker,** because a re-raise reopens an item. It stores the count it last raised and raises again only for a higher count, so marking it done holds until someone new appears. Peers report their hold in the same read, so a lease move does not reopen a dismissed item.
- **Evaluated on the lease holder** at boot, hourly, and on a new sender, over the union of this machine's and peers' observed senders, less every machine's owner keys. An unreachable peer means a possible under-count and is never a reason to skip.
- **The owner always counts.** An owner who reaches the agent only by phone has no id in any list, so an active owner phone with no configured ids counts as one person. Otherwise one MSP phone would read as one person in total.
- **One more case, once per agent:** if the baseline folded a Slack id and a Telegram id into one person, each normally one human, one item asks "This agent treats a Slack account and a Telegram account as one person. If they are different people, turn memory privacy on." iMessage and WhatsApp handles are not asked about, because one person often has several.
- **Acting on it.** The agent's reference block tells it how to turn privacy on when the owner asks in their own chat: set `memoryPrivacy.enabled` on every machine and restart. This is the existing route, and the app's Face ID switch comes in step 2.

### 3.11 Audit

`logs/team-access.jsonl` records refusals, capped to one row per device, route and minute. Changes are already in the signed log, and message attribution is on the inbound log and app events. `GET /mobile/team/activity` (owner, admin read) shows plain lines: "Dana gave Sam access to 'Q4 planning'". For an admin, each line goes through `mayDo(read)`, and a conversation the admin may not read appears as "a conversation". The owner gets one attention item a day summarizing admin changes, only on days there were some. The refusal log is machine-local and retention-bounded, and Activity merges through the pool read.

### 3.12 Migration

- Every existing agent is unchanged until its owner enables team access. No row, no phone change, no widening, no restriction. Owner and `msp` phones behave as they do today.
- The only new thing an existing owner may see is the second-person item, and only if it is true.
- Restrictions begin only when an owner's first invite turns team access on, and the invite lists them: `msp` phones become read-only into owner-reach sessions and their attention and session reads are filtered, and a second machine cannot join.
- All new data is in new files.

## 4. Build order

1. **See who can reach the agent (first slice).** `ReachablePeople`, `GET /team/people`, the console's "Who can reach me" page, the second-person warning, the Registry First row. Nothing is restricted. For B2Lead this answers "who can reach this agent and what can they see", and closes the report's no-owner item.
2. **Step 2a: member and guest phones on one-machine agents, server.** Exact scope in §4.1.
3. **App People screens and member Chat** in `apps/instar-ios`, its own repository: People, Add person, grant sheet, Requests, Activity, tier-shaped tabs, 403 handling.
4. **Step 2b: team phones on multi-machine agents.** The replicated log, the reducer's cross-machine rules, `place-applied`, `servingMachineFor`, `teamEnforcement`, `personKey` on the envelopes. It gets its own review rounds right after 2a lands, before steps 5 onward, because our agents run on several machines by default.
5. **Admin maintenance:** admin routes and layout, owner capabilities, convert an MSP phone, `manageTeam`, `signer-cut`.
6. **Fleet invite and remove,** role badges.
7. **Slack conversations in the app for members.**
8. **Memory privacy on Codex,** so team phones work on a Codex-only agent (*Framework-Agnostic*). Until then the invite refuses plainly on such an agent. This is a sandbox adapter inside memory privacy. The `claude-code` checks in this spec are temporary: when another adapter ships, the admission test becomes "this framework has a sandbox adapter", not its name.

Steps 2a and 3 are useful together, not separately. A user-facing step is done only after a real run as that role on a throwaway agent, per *Live-User-Channel Proof Before Done*.

### 4.1 Step 2a scope

**Decision (hub, 2026-11-06 20:06 PST, topic 140183).** Step 2 is split. Review rounds 7 to 12 each found new items, and the hardest were all multi-machine, so one-machine agents go first and converge on their own. 2b follows directly: it gets its own rounds right after 2a lands.

**On an agent with more than one machine,** counted from the pool registry, `POST /mobile/team/invites` answers `409 team-needs-one-machine`, and the app says: "Team members work on agents running on one machine for now. Support for several machines is the next step. You can still use owner and MSP phones." Never a silent no.

**Adding a second machine is refused at the join while team access is on, or while the confined list holds any conversation or cannot be read,** in `handlePair`, before `storeRemoteIdentity`, on the machine that issues the join, with a plain reason: "This agent has had team members, so a second machine has to wait for support for several machines." `team-off` alone does not reopen the join, because app conversations replicate to a new machine and it would have no record of which ones must stay confined. So an agent that has had team members stays on one machine until 2b. Refusing only the phones would not be enough, because Telegram, Slack and `msp` phones would reach a granted conversation on the new machine under the old rules. If a second machine appears anyway, the team phones are refused `403 team-needs-one-machine`, every confined conversation is refused to non-owners on this machine, and one attention item says what happened and what to do. Fail closed until 2b.

Where §3 describes more than this section does, such as replication, `place-applied` or admin writes, this section wins for 2a.

**In 2a, the owner's phone is the only person writer,** with `conversation-own` and `phone-bind` written by the machine. Members and guests only: no team admins, no `manageTeam`, no `signer-cut`. So the log needs no cross-writer rules. It is a local signed file, folded in `seq` order, so a later removal always beats an earlier grant, and 2b keeps that order for one machine's events. The §3.3 event format, `signedOrigin`, `events[]`, `phone-bind` and `owner-pin` are built now, so 2b replicates the same rows. The bearer may still write `lower`.

Built in 2a:

- `TeamAccess.ts`, the `team` role, `resolveStanding`, literal replacement (§3.1).
- The access log with owner-only writes, `POST /mobile/team/off`, `POST /mobile/team/restore`, `GET /mobile/team/context`, `POST /mobile/team/invites`, `GET /mobile/team/invites/:id`, the grant and remove routes, `GET /mobile/team/people` own row and owner view, `GET /mobile/team/activity` (§3.3, §3.4, §3.10, §3.11). Redeem needs `appCaps`, a team phone is code-only, and the code goes to the owner's phone.
- `mayDo` and the missing conversation checks, list filters (§3.5).
- `tier` on every allowlist entry, member and guest rows only, proven by the §9 status table with team access off, on and after `team-off`, including filtered response content (§3.7).
- `alwaysPerson`, the per-conversation shared place, and the per-topic reply guard (§3.2, §3.5).
- **Grant on one machine:** run every refusal check, then write the conversation to `confined.json`, then take the per-conversation lock inside the spawn entries. A caller may shape a prompt from the audience before reaching the spawn entry, so a caller that shapes one passes the audience it shaped for, and on a mismatch the entry refuses and the caller rebuilds. Under the lock: end the live session, drop resume bindings that no longer match, clear that conversation's unclaimed rows in the outbound queues, write the event, release. There is no `place-applied`: the grant is effective when that finishes. A reply request already in flight at that instant is a stated limit of a few milliseconds. A revoke, a `lower`, a `person-remove` and `team-off` each run the same step on every affected conversation. Grants are refused on a topic pinned to a framework with no sandbox adapter.
- Privacy required at invite and on every request, both branches, and `POST /mobile/team/memory-privacy` (owner, Face ID), which sets it and restarts this machine (§3.6). `privacy-required` is 2b's replicated form of this.
- The read-only rule into owner-reach sessions, for `msp` phones too (§3.2).
- **Attention and pushes:** team phones get `reply` pushes for their conversations and nothing else. While team access is on, an `msp` phone's attention and session reads follow the admin rules in §3.7, because attention text can quote a member's conversation. The invite sheet lists this with the read-only rule, and the first invite is what turns team access on.
- `reply` push triggers for granted Telegram topics.
- **Commands.** A team phone's message is never a command. `POST /mobile/chat/:topicId` otherwise reaches `handleCommand`, where `/switch-account`, `/sessions` and `/claim` act on the whole agent, then `/new`, the hub intent classifier and the fix gate, which act on `restart` or `clean processes`. So a team-phone message is marked in its metadata, and after the memory check it skips every intercept and goes straight to delivery. Grants are refused on a person's own conversation (one with a stored `ownerPerson`, MSP-owned included; absent means the owner's, which stays grantable), whose memory is that person's and must not be read by someone else's session; on system topics such as Attention, Agent Updates and the lifeline; and on topics bound to a job, whose derived purpose feeds owner-reach job prompts. Saving a job's `topicId` onto a confined topic is refused too, and at run time a job with such a binding drops that summary and does not post there: every job post into a topic, including `JobAnomalyPusher`, and its reflection post, goes through one helper that checks the confined list and skips the post if it cannot read it, sending a failure or silence notice to the attention topic instead so it does not vanish. The grant's refusal also reads `job-topic-mappings`. Emergency stop from a team phone stops that conversation's session only, and does not pause the global queue.
- **Who said what.** A shared conversation has several speakers, so the history rebuilt at spawn uses each message's stored `senderName`, falling back to the owner's name, rather than the current sender's. Today `appInboundDispatch` labels every line with the current sender.
- **Confined sessions must be able to work.** Today an app session's context and long messages sit in `state/app-dispatch`, and its files in `app-media/session-files`, both outside what a confined session can read, and `withInboundFilesInScope` sets no place for app sessions. So 2a adds an `app:` place and copies those files into the scope folder at dispatch and in `sessionLinesFor`, including phone files sent into a Telegram topic. The copy goes by the server's own record, never by a path in a message: only attachments and long-message files recorded on that conversation's own events are copied, whatever their age, so a resumed conversation gets its older files and a member cannot name another conversation's file. This is separate from memory privacy's ten-minute inbound rule, which stays as it is for typed paths. Without this a member's chat would get no reply instructions, and long messages and files would not arrive.
- **Telegram topics and app conversations only.** Slack conversations stay out of 2a: a Slack grant is refused, and a team phone gets `404` on the Slack routes, whose stop kills every session. They come in step 7.
- **Earlier files in a confined app session.** `GET /app/media-path/:id` joins the session-token allowlist with its bind check, and answers with a copy in the scope folder. The `--file` reply option is left out of a confined session's context, because it is refused there.
- **The scoped stop** is decided from the request's trusted sender, because the Telegram sentinel runs before the memory check and its metadata.
- **A new phone for the same person.** `POST /mobile/team/invites` accepts an existing `personKey`: any `role` is ignored, it writes no `person-add`, is bound to that person's current standing, and ends in a new `phone-bind`, so their conversations and grants carry over. An invite is refused if this machine has no identity key, because it could not sign receipts.
- **Creating a team person's conversation** writes its fixed audience to `confined.json`, fsynced, before the creation is acknowledged or anything is dispatched, then `conversation-own`.
- **The grant sheet and People summary** say who else can read: an unconverted MSP reads every Telegram topic, as today.
- **Bearer `lower`:** `POST /team/people/:personKey/lower`.
- **"One machine"** means `getActiveMachines` lists no peer, asleep included. An unreadable registry counts as several machines, the strict direction. The refusal names the machine and offers to mark a retired one as gone.

**Left for later steps, known from the rounds:**

- Step 3: `POST /team/proposals` and the Requests list, which need the app screens.

- 2b: a canonical receipt when one signed request reaches two machines. Holding the lock through launch across machines rather than checking after spawn. A live session on another machine after a grant syncs, with generation checks at reply acceptance. `ownerOf` naming a dead machine until re-placed. `personKey` on `InboundSenderEnvelope` and `SenderEnvelope`. Slack's `routingKey` mapping.
- Step 5: enrolling a new phone into an existing person stays owner-only, or an admin could enroll its own phone as a member. Converting an MSP must write `conversation-own` for their conversations and map their memory person, or their chats return 404. `signer-cut` must keep a person who has an accepted owner event, and show who would be removed before confirming. The standing timeline must include admin-created people.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Tier from the log alone for `team` | invariant | Authorization must be deterministic (Know Your Principal). |
| Route admission by tier | invariant | Enumerated ceilings. Default-deny by test. |
| `mayDo` | invariant | Existing invariant, extended, fail closed. |
| Who may write the log; fold re-check | invariant | The stored signature is the proof of a person's choice. |
| Team phones require memory privacy | invariant | The promise has no meaning without confinement. Applies only after an owner invites. |
| Granted conversation is a shared place; two-step activation | invariant | Privacy boundary; fail closed. |
| Read-only into owner-reach sessions | invariant | A fixed rule; begins only through the owner's invite. |
| `msp` phones unchanged until conversion or the first invite | invariant | Updates neither restrict nor widen without the owner. |
| Admin Needs you allowlist | invariant | Fail closed to owner-only. |
| One machine only for team phones in 2a | invariant | Fail closed: a second machine knows no grants until 2b. |
| Second-person warning | invariant | A deterministic count. It holds no authority: it only tells the owner. |

## Verify the state, not its symbol

- **Tier.** Symbol: a log row. State: "the owner or an allowed admin chose this". Corroboration: `verifyTeamAccessOrigin` against the replicated key ledger, and the fold's standing check. Unmeasurable: the row is ignored, or a failed log admits no team phone. Both directions: a deleted row is not detectable on one machine (§3.2), and a valid but stale row is bounded by replication.
- **Reach.** Symbol: allowlists, phones, observed senders. State: "this person can reach the agent". A silent reader in a Telegram group is not a sender, so the row says the list is incomplete. One human with two unlinked ids can read as two, and marking it fine covers that.
- **Grant applied.** In 2a the symbol is the grant event, written under the lock after the session ended. From 2b it is a `place-applied` matching the current generation. State: the conversation's session is confined. Corroboration: it is written after the session ended and the place recomputed, and the spawn fails if confinement cannot apply. Unmeasurable: the grant stays pending.
- **Privacy required.** Symbol: `enabled` and the probe, read live, and each peer's report. State: team sessions are confined. Unknown refuses.

## Frontloaded Decisions

1. `OrgRole` is the one vocabulary. A tier is a projection. This supersedes frontloaded decision 1 of mobile-app-people-and-roles for new phones, and MSP becomes a relationship on an admin.
2. `msp` phones change only through an owner's act: converting them, or the first invite, which turns on the read-only rule and the attention filter and says so.
3. Guest exists, as read-only.
4. New admins start with no conversation access, and owner capabilities open read only. This is my reading of the brief's "what of the owner's conversations and memory it may see is owner-granted".
5. `manageTeam` defaults on for a new admin, limited to members and guests and to what the admin may delegate (§3.3). Adding teammates is agent management, and an owner can switch it off.
6. Every team phone requires memory privacy, native app conversations, and the `claude-code` framework.
7. A grant opens past and future history.
8. The dashboard stays the owner's surface, with a "Who can reach me" page. No non-owner gets a PIN or console pass, and a per-person console is not built, because the native app is the team's interface.
9. Telegram and Slack keep their own read boundaries. Instar flags them.
10. No central service.
11. Access lives in a new signed, replicated log, not the MSP grants file.
12. Authority on Slack does not change in these steps. A team phone's role comes from the log. The Slack gate stays observe-only on the `orgRole` copy, as it is today, so a registry edit still changes what that gate reports. Making the Slack gate enforce from the log is a separate decision for whoever turns enforcement on.
13. Admin mutations are the enumerated list in §3.7. Jobs cannot be created or edited, and Remote Desktop stays with the owner.

## Open questions

*(none)*

## 5. Security

- A phone cannot reach an unlisted route, and a listed route without a tier fails a test.
- The bearer token cannot raise anyone, and a registry edit changes neither a team phone's tier nor the pinned owner.
- `404` prevents probing, and list filters run after the pool merge.
- Non-owner phones pass no Telegram sender id, as today.
- Conversation titles and proposal text are display data, never instructions.
- `GET /mobile/team/context` is owner-only, because it carries the owner's channel ids.
- Stated limits: §3.2 (same computer user), §3.5 (a machine cut off at the moment of a grant).
- Stated limit inherited from memory privacy: a scheduled job that reads message logs reads a member's words with owner reach, as it reads any Slack or Telegram person's words on a privacy-on agent today. Team phones do not widen this, but they do add people to it. This sits inside the owner's role, since the owner has full access to everything (hub decision, 2026-11-06, not blocking 2a). What is weak is that nothing enforces that a job treats logged words as data: that rests on the model's behaviour, so it is a soft protection, not a boundary. The invite sheet and the member's first-run card disclose it: "Scheduled jobs run for the owner and can read messages here." Owner-reach job sessions can read the log files directly, so no route check would close it. Closing it for every non-owner sender is memory privacy's work and is in the feedback queue (fb-27cc594b-a49).

## 6. Multi-machine posture

- **Access log: unified.** Replicated store kind `teamAccess` (registration, the resolved-flags injection, and a commit-observer branch, as `mobileDeviceKeyLedger` has), always on with native conversations, verified on every machine. Single-machine survivability holds: any machine can answer from its copy.
- **Device records: unchanged, machine-local.** machine-local-justification: physical-credential-locality.
- **Writes** go to any machine and replicate. Revoking is effective at the phone's machine on arrival, and the owner's screen shows a machine that has not caught up.
- **Reach tracking: machine-local operational state,** read through `?scope=pool`, which reports missing machines. Each machine sees only inbound it served, so the pool read is the complete view, and the warning is evaluated over it.
- **Refusal log: machine-local operational record,** bounded.
- **Privacy setting:** checked across machines at invite, and by each machine on every inbound it serves (§3.6). A machine joining later takes the setting from the join, not from an old `privacy-required`.
- **Notices:** attention items go through the lease holder, one voice.

## 7. Agent awareness and migration parity

- `generateClaudeMd()` and the reference files gain a "Team roles and access" block and the Registry First row "Who can reach this agent?" → `GET /team/people`, with `migrateClaudeMd()` under a content guard.
- New route prefixes go in `CapabilityIndex.ts` and `WriteDomainRegistry.ts`. `state/team-access/` and `state/team-access-last-good/` are denied in `BLOCKED_PATH_PREFIXES`, so an ordinary backup restore cannot roll them back, and `/mobile/team/restore` is the only restore path.
- No config default changes. No hook changes. No feature flag for step 1, because nothing is restricted. The reference block also says how to turn memory privacy on for an owner who asks.

## 8. Rollback

Step 1 is a plain revert. From step 2 on, older builds since v1.3.1631 refuse a `team` phone, and they never rewrite the access log. Refusing the phones is not enough, though: Telegram, Slack and `msp` phones would still reach a granted conversation under the older place rules. So a hand downgrade, to any build, needs the owner to run `team-off`, archive every once-shared or member-owned conversation and drop its resume bindings first, the same kind of procedure as MSP phones. Instar updates move forward only, so this applies only to a hand downgrade. A person converted from `msp` is `team`, so a rollback cannot restore their older reach. Conversation places fall back to their prior key, and shared folders stay on disk.

## 9. Tests

- Unit: tier map; a registry `orgRole` edit changing nothing for a team phone in either direction; incremental folding equal to fresh rebuild, including promotions and late events; an `msp` phone with no `orgRole` untouched; a stale `place-applied` refused after revoke and regrant of the same person; a banned-literal test; every allowlist entry has a tier; notify-token tier; `mayDo` for each tier, op and ref form; log fold with bad signature, fields changed beside the signed body, a re-appended old grant, standing exceeded, the same events in shuffled orders, expected-state fixtures for the reducer, an admin's grant surviving the admin's removal in both clock directions, `signer-cut` voiding a late grant and leaving that admin's removals standing, and ending at a re-promotion, `conversation-own` agreeing across machines, a pending generation retried after a machine dies, a removal and regrant in one request, a removal after a grant with equal timestamps and with the clock moved backward, a quarantined grant, a quarantined removal holding access and clearing both ways, an unknown key with no receipt holding nothing, an MSP-signed `owner-pin`, a link naming the owner or another person ignored, an invite voided by removal between mint and redeem and between redeem and confirm, a pool inbound refused by a machine that turned privacy off, a grant racing a spawn and a resume under the lock, a session that spawned on an old generation ending itself, `servingMachineFor` for each kind of conversation, an invite naming `owner` refused, a member keeping access across a move and an ordinary session end, an owner phone reassigned to an MSP losing owner standing, replicated and after a reboot, a grant whose `eventId` sorts before its `person-add`, an `operator` role surviving the fold, the admin challenge refused for any other action, a member message delivered through the pool attributed by `personKey`, a second owner phone with owner standing, two concurrent pins, an older machine blocking an invite, one request with several events, `owner-pin` matching an existing profile on a second machine, `privacy-required` before any invite, applied once and not re-applied after the owner turns privacy off; a per-topic session refused on another topic; an admin with `read` cannot grant `use`; owner pin beats `orgRole`; `alwaysPerson`; place with grants; `ReachablePeople` with privacy off.
- Integration (HTTP): a status table across owner, `msp` with no `orgRole`, admin, member, guest and removed person on every route, run with team access off, on, and after `team-off`, so parity is only asserted where it is promised; bearer cannot raise; admin limits; invite refusals; `426` from an older app; two-step grant; second-person item once, updated in place, suppressed for shared people.
- E2E: production init path, `/team/people` 200 with real wiring; a member reaches a granted conversation and gets `404` on another.
- Live, direct confined-session isolation: a real session proving a member cannot get another member's fact, or the owner's, in a granted conversation. This says nothing about the scheduled-jobs limit in §5.
- 2a: every slash command and every intercept word such as `restart` sent from a team phone arrives as plain text; a member's long message and file reach a confined session, proved with a real session; a resumed conversation gets an older file; a revoked conversation stays confined; an owner reply in a member's own conversation stays confined, including after that person is removed; `team-off` clearing the `msp` limits and not the join refusal; a spawn in a once-shared conversation refused with privacy off; a torn final line truncated at boot with the next append clean, an unreadable log refusing confined conversations and leaving others alone, the confined list unreadable with a readable log, an orphaned confined entry keeping its audience, a first invite with no grants leaving spawns working, and the owner's restore; a backup restore leaving the access files alone; a never-team agent writing no access files, and a corrupt file on it restricting nothing; a log rolled back below last-good read as lost; a grant refused on a job topic and on a person's own conversation; a job refused on a confined topic and an existing binding dropped at run time; a restore to before a conversation's first grant keeping it confined and the join refused; a replaced phone keeps its person; team access staying on after the last phone is revoked; an untagged attention item showing only the fixed label; a path to another conversation's file named in a message copies nothing; a team phone's stop leaves other conversations and the queue alone; history in a shared conversation names each speaker.

## Maturation plan

- **test-agent-live:** each step on a throwaway agent, with the simulator or a real phone.
- **dev-agent-live:** Echo, with a test member on a test phone.
- **fleet:** step 1 has no flag and ships live, so the warning is visible on its own. From step 2 there is no new flag: team phones ride `mobilePairing.native.enabled`, which is dark on the fleet today. An owner who wants a team turns it on through their agent. Graduating that switch fleet-wide belongs to the app work and is not needed for a team to start.
- **graduation criterion:** a real team of at least three people uses one agent for a week with no conversation reaching someone without a grant, and no message attributed to the wrong person.
- **ladder:** mobilePairing.native
- Step 1 has no switch and restricts nothing, and team phones ride this ladder.
- **dark-window:** if no team phone is paired within 30 days of step 3, record why on the Maturation board with a new date.

## Left behind

Listed in docs/specs/reports/team-roles-and-access-convergence.md.
