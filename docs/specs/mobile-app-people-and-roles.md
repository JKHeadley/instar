---
title: "Each paired phone belongs to one named person, with a role (owner or MSP)"
slug: "mobile-app-people-and-roles"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-app-people-and-roles.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched); product choices are Justin's 10:04 and 10:29 PST decisions in topics 136110/136774"
review-convergence: "2026-11-03T18:58:46.228Z"
review-iterations: 4
review-completed-at: "2026-11-03T18:58:46.228Z"
review-report: "docs/specs/reports/mobile-app-people-and-roles-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

## 1. Problem

Operator decision (2026-11-03 10:04 PST, topic 136110): "we should support multiple roles. We can start out with the MSP role. But also, generally, we should assign each app to a specific person ... we should have very strong infrastructure for identifying an official user for an Instar agent." The operator will soon run an Instar agent for a client as their MSP (managed service provider). Both the operator and the client, who owns the agent, must use the Instar iPhone app with that same agent.

Today every paired phone is treated as the agent's owner (feedback fb-9bdc36bc-23d):

- `POST /mobile/chat/:topicId` injects every app message with `fromUserId` = the Telegram owner's id and `fromFirstName` = `threadline.ownerName`, and mirrors it into the topic as "📱 <ownerName> (from the app)". The agent therefore believes the owner said everything any phone sent, and the owner's Telegram identity carries the owner's authority downstream (commands, standing authorization, operator binding).
- App conversations (`/mobile/chat/app/:key`) and Slack sends (`/mobile/chat/slack/:id`) also use `appOwnerName(config)` as the sender. The Slack send speaks into Slack as the owner (`mobilePairing.slackOwnerUserId`).
- Every active phone can list and read every app conversation and every Slack conversation the owner has.

## 2. What exists (instar main ab7d4c5c0)

- **User registry** (`src/users/UserManager.ts`, `state/users.json` under the state dir; `instar user add|list`): `UserProfile { id, name, channels, permissions, telegramUserId?, slackUserId?, orgRole? }`. It is the agent's one list of known people, resolved from authenticated channel ids ("Know Your Principal"), never from names in message content.
- **Roles** (`src/permissions/SlackPrincipalResolver.ts` `deriveRole(permissions, orgRole)`): an explicit valid `orgRole` wins, else the highest role named in `permissions`, else `member`. `OrgRole` = guest | member | contributor | operator | admin | owner. `RolePolicy` maps roles to ceilings for Slack.
- **Telegram owner**: `TelegramAdapter.getOwnerUserId()`; the owner's display name is `config.threadline.ownerName`.
- **Phones** (`src/core/MobileDeviceKeys.ts` `DeviceRegistry`, `state/mobile-devices.json`): `DeviceRecord { id, deviceName, label, pairedAt, status, publicKey, fingerprint, host, approvedAt, approvedVia, ... }`. No person and no role.
- **Pairing** (`src/server/mobilePairingRoutes.ts`): bearer `POST /mobile/pairing-codes` mints a one-time link (`PairingCodeStore`, process memory, hashes only); public `POST /mobile/pairing-codes/redeem` registers the phone's Secure Enclave key as a pending device and sends a 6-digit / word code to the owner's private Telegram chat (or shows it to a dashboard PIN session when there is no Telegram owner); the phone confirms with that code. A device then signs every request; `deviceAuthenticator` admits only `DEVICE_ALLOWLIST` routes and sets `req.instarPrincipal = { kind: 'device', deviceId }`.
- **App conversations** (`AppConversationStore`, replicated event log; `CreatedEvent { title }`): no creator recorded.

## 3. Design

### 3.1 The phone's person and role

`DeviceRecord` gains two optional fields:

- `userId?: string` — the `UserProfile.id` of the person this phone belongs to. Absent means the agent's owner.
- `role?: 'owner' | 'msp'` — this phone's role with this agent. Absent means `owner`.

Absent fields mean owner, so every phone paired before this change stays the owner's phone with exactly today's behaviour. This is the migration: a read-time default, no file rewrite, nothing for `PostUpdateMigrator` to patch.

Why the owner default is the right backward-compatible reading (Know Your Principal): before this change the only way a phone became active was a confirmation code delivered to the owner's private channel (the owner's private Telegram chat, or a dashboard session unlocked with the PIN), recorded as `approvedVia`. That proves the owner's channel approved each phone, not which person holds it, so "owner" for an older phone is a compatibility assumption the owner can correct, not proven identity. Older history rows without `senderName` are likewise legacy attribution to the owner. The owner can reassign any of them with the reassign route below (§3.2), and the dashboard's Phones card shows each phone's person so a mislabelled phone is visible.

A new pure module `src/core/MobilePeople.ts` resolves a device to its person:

```ts
type AppRole = 'owner' | 'msp';
interface DevicePerson { role: AppRole; userId: string | null; name: string; telegramUserId: number | null }
devicePerson(device, people): DevicePerson
```

`people` is a small lookup built from the existing `UserManager` (read-only use: `getUser`, `listUsers`) plus the Telegram owner id and `threadline.ownerName`. Rules:

- role `owner` (or absent): name = the registered owner's profile name when `userId` is set and resolves, else `threadline.ownerName`, else `Operator`. `telegramUserId` = the Telegram owner id.
- role `msp`: the profile named by `userId`. Name = profile name; `telegramUserId` = the profile's `telegramUserId` or null. If the profile no longer exists (removed from the registry), the phone is treated as **unassigned**: it is refused on every route except `GET /mobile/device`, `POST /mobile/device/confirm`, and self-revoke, with `403 person-unknown`. A phone never falls back to the owner's identity.

### 3.2 Pairing a phone for a named person

`POST /mobile/pairing-codes` (bearer only, as today) accepts two optional body fields: `userId` and `role`.

- Neither field: the owner's phone, as today.
- `role: "msp"`: `userId` is required and must name a registered person (`UserManager.getUser`). That person must not be the owner (derived role `owner`, or `telegramUserId` equal to the Telegram owner id). Otherwise `400 bad-person` with a plain detail.
- `role: "owner"` with a `userId`: the person must be the owner as defined above (`400 bad-person` otherwise).
- Any other role value: `400 bad-role`.

The person and role are stored with the code in `PairingCodeStore` (memory only, beside `label`). Redeem copies them onto the pending device. The one-time link and the phone's flow are unchanged.

The confirmation code still goes only to the owner (private Telegram chat, or the dashboard PIN session). The owner's consent is the identity anchor: no phone gets access to the agent unless the owner relays a code the owner alone received. The code message now names who the phone is for: "Your code to pair a phone for Justin (MSP) with <agent> is …". The dashboard approvals row and `GET /mobile/devices` rows carry `personName` and `role`.

`POST /mobile/devices/:id/person` (bearer only; a device is refused 403) assigns an existing **owner** phone to a person as an **MSP phone only** (`role: "msp"` with a registered non-owner `userId`), under the same validation. This assigns a phone paired before this change. An MSP or unassigned phone is never moved to another person this way (`409 repair-needed`): the other person may hold owner grants (§3.5), so a sideways move could raise access without the owner; such a phone is revoked and paired again for its new person. It can never raise a phone to owner: `role: "owner"` answers `400 owner-needs-pairing`. Owner authority on a phone comes only from a pairing whose confirmation code the owner alone received (mobile-device-keys §2.2: the bearer token alone never activates a phone), so a phone becomes an owner phone only by being paired again as one. Lowering is safe with the bearer alone, because the bearer holder can already revoke any phone.

### 3.3 Messages carry the phone's person

- `POST /mobile/chat/:topicId`: the injected message uses the device person: `fromFirstName` = person name. `fromUserId` = the owner's Telegram id for an owner phone, exactly as today. An MSP phone passes **no** sender id, even when its profile has a `telegramUserId`: the device path is accepted as `senderTrusted`, and any id it carries counts downstream as a proven Telegram sender (operator auto-bind, standing-authorization evidence, command authority). The MSP is named in the session's sender tag and the mirror line only, so an MSP phone never carries Telegram authority it did not prove through Telegram. The mirror line reads "📱 <person name> (from the app)". The owner's Telegram identity is never attached to an MSP's message.
- `POST /mobile/chat/app/:key`: the dispatch `ownerName` is the device person's name.
- The authenticated person travels as structured data, not only as a display name: the inbound core's `MobileInboundTrust` and the app-conversation dispatch both carry `sender: { deviceId, role, userId, machineId }` beside the name, and the inbound message log records it (`via: 'mobile-device'`, `deviceId`, `senderRole`, `senderUserId`). Downstream authority for an MSP is exactly "no Telegram sender id": nothing downstream grants authority from a name, so two people with the same name cannot be confused for authority purposes.
- The stored app message records who sent it: `MessageEvent`/`MediaMessageEvent` gain optional `senderName`, `senderRole` and `senderPerson: { machineId, userId }` (MSP only), written at accept time from the device person and replicated with the event. History rows use the stored `senderName`. An older event without the field keeps the legacy owner attribution (before this change every phone was treated as the owner's); that is a compatibility default, not established identity (§3.1). No read ever guesses a sender from the current device registry.

The emergency-stop and pause intercept do not depend on the sender id, so an MSP's "stop everything" still stops the session.

### 3.4 What the MSP may not do (owner-only)

Operator decision (2026-11-03 10:29 PST, topic 136774): "That works, but the owner should be able to give the MSP access if they want to." These limits are the default; §3.5 is the owner's switch that opens them.

1. **Slack**: the Slack send speaks as the owner's Slack identity, so only the owner's phone may use Slack.
2. **The owner's own app conversations**: `CreatedEvent` gains an optional `ownerPerson: { machineId, userId }` (the creating phone's person when it is an MSP phone, namespaced by the machine whose registry the `userId` belongs to; absent for owner phones and every older event). An MSP phone may use only app conversations whose `ownerPerson` equals its own `{ this machine, its userId }`. Registry ids are local to each machine, so a bare id could name different people on different machines; the machine namespace makes a match mean "the same registry entry", and anything else fails closed (the MSP does not see it; the owner still does). The owner's phone may use every app conversation, including the MSP's, because the owner is the agent's principal.
3. **Other phones**: an MSP phone's `GET /mobile/devices` (local and `scope=pool`) lists only its own phone. Only the bearer token may mint links, reassign, or revoke another phone, and a phone may still revoke only itself.

**One shared check, called by every route that names a conversation.** `MobilePairingService.mayUseConversation(deviceId, ref)` takes the conversation reference in any of the forms the device routes use (`<uuid>` / `app:<uuid>`, `slack:<team>:<channel>[:<thread>]` or a Slack durable id, `telegram:<topicId>`), and answers:

- owner phone: always yes;
- MSP phone: `telegram:*` yes; `slack:*` only with the owner's `slack` grant (§3.5); an app conversation yes when its `ownerPerson` is `{ this machine, the phone's userId }`, or when it is the owner's (no `ownerPerson`) and the owner granted `ownerConversations`; another MSP's conversation or an unknown one: no.

A "no" answers `404 unknown-conversation` (the same as a missing conversation, so an MSP cannot probe for the owner's conversation ids), except the Slack routes, which answer `403 owner-only` so the app can explain it. The check is called by: app `GET /mobile/conversations` (rows filtered after the local+pool merge by the same check: each app row carries `ownerPerson`, re-validated from peer rows like every other field, and Slack rows are shown to an MSP only while the owner's `slack` grant is on), `PATCH`/`DELETE /mobile/conversations/:key`, `POST /mobile/chat/app/:key`, `GET /mobile/chat/app/:key/messages`, `GET /mobile/chat/app/:key/events`, `GET /mobile/chat/app/:key/preview/:messageId` (device and notify-token principals alike), both Slack routes, and the media routes `POST /mobile/media/uploads` (its target conversation), `GET /mobile/media/:sha256` (its `ref`), and `POST /mobile/media/purge` (every key in the batch; any refused key refuses the batch). A test enumerates `DEVICE_ALLOWLIST` and fails when a route that takes a conversation reference is not covered by the check.

**Unassigned phones are refused centrally.** `deviceAuthenticator` resolves the device's person once per request, on BOTH of its branches: a device signature and the notification read token (mobile-push §2.2, which opens only the attention read and the reply preview). `person-unknown` answers `403 person-unknown` on the token branch always, and on every `DEVICE_ALLOWLIST` route except `GET /mobile/device`, `POST /mobile/device/confirm`, and `POST /mobile/devices/:id/revoke` (self). The resolved person rides on the request principal, so routes never resolve it again.

**Push follows the same check.** A reply push for an app conversation (`MobilePushService`, `kind: 'reply'`) goes only to phones that may use that conversation (`mayNotify` → `deviceMayUseConversation`); any other phone gets no push for it at all, not even "New reply" with its id, and nothing is folded into its count. A folded aggregate ("N more things need you") carries only a number, never a conversation id or text, so a reply folded just before a grant was withdrawn adds at most one to that number. The notification text itself never travels through Apple: the phone fetches it through the preview route, which runs the same check. Attention-item pushes stay shared.

**Shared on purpose.** Telegram topics (all of them, with their history), sessions, attention items and their pushes, and emergency stop. Telegram topics are where the agent's work happens, and the MSP's job is to run the agent; the owner's private space is their app conversations and Slack.

**Timing.** The person is resolved when a request is accepted. A retry with the same `requestId` replays the stored answer (`MobileChatRequestStore`), so a reassignment or a removal never rewrites an already accepted message; it applies to the next new request.

**Who counts as the owner.** A registry profile is the owner when its derived role (`deriveRole`) is `owner` or its `telegramUserId` is the Telegram owner id. Any other profile, including one with `orgRole: admin`, may be paired as an MSP.

### 3.5 The owner's switch: opening access to an MSP

Off by default. The owner may open, per MSP person, either or both of:

- `ownerConversations`: the owner's own app conversations (list, read, send, rename, delete, and their files), through the same shared check;
- `slack`: Slack from the app.

Stored in `state/mobile-msp-grants.json` (`MspGrantStore`, atomic write, mode 0600), keyed by the person's registry id, with `setAt` and the owner phone that set it. No row, or an unreadable file, means nothing is granted (fail closed).

- `POST /mobile/people/:userId/grants` `{ ownerConversations?: boolean, slack?: boolean }`: **owner phone only** (device-signed, role owner). The bearer token and MSP phones get `403 owner-phone-required`. The owner's phone signature is the one proof that the owner made the choice; the bearer token is refused so that nothing talking to the agent, including an MSP asking the agent, can open the owner's private space. `userId` must be a registered MSP-eligible person (`400 bad-person`).
- `GET /mobile/people`: owner phone, or the bearer token (read-only, so the agent can answer "can my MSP see my chats?"). It lists the MSP persons with phones on this machine and their grants. MSP phones are refused.
- A grant changes access on the next request; nothing is cached.
- With `slack` on, the MSP's Slack messages carry the MSP's name and are dispatched with the MSP's own registered `slackUserId` (or a placeholder `app-msp:<userId>` that resolves to no registered person), never the owner's Slack id. The Slack permission gate therefore applies the MSP's own standing, not the owner's. The mirror line reads "📱 <MSP name> (from the app)".

The app half (the owner's settings screen with the two switches) is coordinated with topic 134088.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Mint validation (`role`/`userId` must resolve, MSP must not be the owner) | invariant | An authorization input checked against the registry; a wrong value is a client error, not a judgment call. |
| Device → person resolution; unassigned phone refused | invariant | Identity binding must be deterministic (Know Your Principal); failing closed never grants the owner's identity to an unknown person. |
| `mayUseConversation` (MSP refused on Slack / others' app conversations) | invariant | Role ceiling enumerated by the operator's product decision; a fixed rule like `RolePolicy` ceilings. |
| Grant change accepted only from an owner phone | invariant | The owner's device signature is the only proof of the owner's choice; a bearer path would let anyone who can talk to the agent open the owner's space. |
| Sender identity passed to the inbound core | invariant | Attribution follows the authenticated device key, never message content. |

## Verify the state, not its symbol

No new detector, sentinel or LLM judgment is added.


The symbol is `role`/`userId` on the device record. The state it claims is "this phone's key was approved by the owner for this named person". Corroboration: the record is written only by bearer-authenticated mint/reassign plus the owner-delivered code; the device key itself proves the phone on every request. Unmeasurable case: a `userId` that no longer resolves is explicitly `person-unknown` and refused, never defaulted to the owner.

## Maturation plan

- **test-agent-live:** the unit, integration and e2e tests in §6 on a real server boot: an MSP link minted for a registered person, redeemed, confirmed, its conversation stamped, its message reaching the session under the MSP's name, and Slack refused by role.
- **dev-agent-live:** the operator pairs a second phone as an MSP with a development agent (a registered person), checks that its messages show the MSP's name, that the owner's private app chats are not listed, and that the owner's switch opens and closes them.
- **fleet:** no new flag. It rides `mobilePairing.enabled`. Every existing phone stays the owner's with today's behaviour, and MSP behaviour appears only when a link is minted for a person.
- **graduation criterion:** the operator's MSP client agent runs one week with the owner's and the MSP's phones both in use, no message attributed to the wrong person, and no MSP access to owner-only areas without the owner's switch.
- **dark-window:** if no MSP phone is paired within 30 days of release, record the reason and a new date on fb-9bdc36bc-23d.

## Open questions

*(none)*

## Frontloaded Decisions

1. Role lives on the phone (device record), not as a new `OrgRole`: `OrgRole` drives the Slack `RolePolicy`, and an MSP is a relationship to this agent, not an org rank. The person is the existing `UserProfile`.
2. Absent fields mean owner (no rewrite migration).
3. The owner approves every phone (code to the owner only); the code message names the person.
4. An MSP phone's message is injected with no Telegram sender id at all (named in the sender tag only), never the owner's and never the MSP's own: the device path is `senderTrusted`, so any id would count as proven Telegram authority.
5. Owner-only by default: Slack and the owner's app conversations; the owner may open either per MSP from an owner phone (operator decision 10:29, §3.5).
6. A removed person's phone is refused, not downgraded to the owner.

## 4. Security

- Escalation path closed: an MSP phone can no longer act with the owner's Telegram id or Slack identity.
- Mint and reassign stay bearer-only; devices cannot mint or reassign (not in `DEVICE_ALLOWLIST`).
- A pairing link minted for the MSP carries the person in server memory, not in the link, so a phone cannot choose its own person or role.
- Pool reads: `GET /mobile/conversations?scope=pool` filters merged peer rows by the requesting phone's person after the merge (app rows carry `ownerPerson`), so a peer's bearer answer cannot leak the owner's conversations to an MSP phone.

## 5. Multi-machine posture

- MSP grants (`state/mobile-msp-grants.json`) live beside the device records they apply to, on the machine that holds the MSP's phones and is the only one that can authenticate them. machine-local-justification: physical-credential-locality — a grant is consulted only when a phone's device key verifies, which happens only on the machine holding that phone's record.
- Person and role ride on the device record, which already lives on the machine whose address the phone paired with and is read pool-wide through `GET /mobile/devices?scope=pool`. machine-local-justification: physical-credential-locality — the device record is bound to the host the phone's key signs for; the person is a field of that record.
- `ownerPerson` on `CreatedEvent` and `senderName`/`senderRole`/`senderPerson` on message events are replicated with the app conversation store (unified). Registry ids are local to each machine, so every stored person reference is namespaced `{ machineId, userId }` and compares equal only within the same machine's registry. A phone's signed requests verify only on the machine holding its device record, and that machine stamps the conversations it creates, so an MSP sees its own conversations wherever it can authenticate. On any other comparison (a different machine's namespace) the answer is no for the MSP and yes for the owner: fail closed toward the less-privileged person.
- Pairing codes stay process memory, as today.

## 6. Tests

- Push: unit — a reply push skips a phone the check refuses (no send, no fold), and attention pushes never consult it.
- Grants: unit (store defaults, merge, all-off removes, corrupt file grants nothing; each switch opens only its area); integration (bearer and MSP phone refused; owner phone opens and closes; MSP then reaches the owner's chats and passes the Slack role check).
- Unit: `MobilePeople` resolution (owner default, MSP, removed person, registered owner); `choosePerson` both sides of every rule; `PairingCodeStore` carries person; `DeviceRegistry.createPending`/`setPerson`; `validateAppEvent` keeps `ownerPerson`/`senderName`/`senderRole`/`senderPerson`, and an event carrying them still validates for a reader that ignores them (rollback); the allowlist-coverage test above.
- Integration (HTTP): mint with/without person; bad role/person refused; redeem copies person; code DM names the person; MSP chat injects the MSP's name and no owner id; owner chat unchanged; MSP refused on Slack; MSP list/read limited to own app conversations; owner sees all; reassign route bearer-only.
- E2E: production init path — a paired MSP phone's message reaches the inbound core with the MSP's name (feature alive, 200 not 503).

## 7. Agent awareness and migration parity

- `generateClaudeMd()` gains a short "Phones for named people (owner / MSP)" block: how to mint a link for a person (`userId`, `role`), how to reassign, what an MSP may not do.
- `migrateClaudeMd()` appends the same block to existing agents' CLAUDE.md under a content-sniff guard.
- No config defaults, hooks or skills change.

## 8. Rollback

A plain revert would be a privilege escalation: older code reads every active phone as the owner's, so an MSP phone would gain owner access. Two structural guards close that:

1. **Fail-closed authenticator guard.** `deviceAuthenticator` refuses (`403 person-unknown`) any device whose record carries a `role` other than `owner`, unless the people-and-roles resolver is present to resolve it. A rollback release reverts the feature commits but keeps this guard (the spec's rollback instruction, repeated in the PR body and the side-effects artifact), so MSP phones stop working instead of becoming owner phones.
2. **Mixed versions.** An older peer drops the optional fields when it re-validates an event, and events are deduplicated by event id with the first copy kept. A machine that received the original stamped `created` event keeps its `ownerPerson`. A machine that received a conversation only through an older peer holds a stripped copy and reads that MSP conversation as the owner's: the owner sees it (correct), and so would a different MSP on that machine who holds the owner's `ownerConversations` grant. That is a real exposure beyond the grant's intent, but it needs all four of: a pool mixing versions, a conversation that reached a machine only through the old peer, a second MSP whose phones are on that machine, and that MSP holding the grant. A stripped copy is not repaired by itself, so the exposure can outlast the update. This is a known limit, queued as feedback fb-e8327f7f-4d4 (a fix is an explicit created-role marker plus an "unknown owner" state that denies MSP access).
3. **Data stays forward-compatible.** The event fields are optional and older `validateAppEvent` rebuilds each event from its known fields, so they are dropped rather than rejected (no replication stall in a mixed-version pool). Owner phones keep the absent-field shape, so they are unaffected either way.

Builds already released before this change (≤ 1.3.1627) cannot carry guard 1. A machine that downgrades to such a build would read MSP phones as owner phones, so the operator procedure for a downgrade is: revoke every `role: msp` phone first (`GET /mobile/devices` shows the roles; `POST /mobile/devices/:id/revoke`). Instar updates move forward only, so this applies only to a hand downgrade.
