# Side-Effects Review — paired phones belong to people (owner / MSP), with an owner switch

**Version / slug:** `mobile-app-people-and-roles`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (code review, see below)`

## Summary of the change

Implements docs/specs/mobile-app-people-and-roles.md (operator decisions 2026-11-03 10:04 and 10:29 PST). Files:
- `src/core/MobilePeople.ts` (new): pure resolver. `devicePerson()` maps a device record to `{ role, userId, name, telegramUserId, slackUserId, grants }`, where absent fields mean owner and a removed MSP person or unknown role means `person-unknown`. `choosePerson()` validates mint and reassign. `mayUseConversation()` is the one shared access check.
- `src/core/MobileMspGrants.ts` (new): `MspGrantStore` for the owner's per-MSP switches (`ownerConversations`, `slack`). Off by default, fail closed on an unreadable file.
- `src/core/MobileDeviceKeys.ts`: `DeviceRecord.userId?` / `role?`; `createPending` takes them; `setPerson()`.
- `src/core/MobilePairing.ts`: a pairing code carries its person (memory only).
- `src/server/mobilePairingRoutes.ts`:
  - mint takes `userId`/`role`; redeem copies the person; the owner's code DM names the person.
  - `deviceAuthenticator` resolves the person once per request and refuses `person-unknown` except on status, confirm and self-revoke.
  - Phone lists carry `role`/`personName`, and an MSP phone sees only its own.
  - New routes: `POST /mobile/devices/:id/person` (bearer, owner→MSP only), `GET /mobile/people` (owner phone or bearer read), `POST /mobile/people/:userId/grants` (owner phone only).
  - The Telegram-topic send uses the phone's person: an MSP phone sends no Telegram id.
- `src/server/mobileConversationRoutes.ts`, `mobileMediaRoutes.ts`, `mobileSlackRoutes.ts`:
  - every route that names a conversation runs `deviceMayUse`;
  - creates are stamped with `ownerPerson`, and messages record `senderName`/`senderRole`/`senderPerson`;
  - the Slack send speaks with the MSP's own Slack id (never the owner's) when granted.
- `src/core/AppConversationStore.ts` / `AppConversationService.ts`: optional event fields, an index column added in place, and stranded-create recovery keeps the owner.
- `src/server/routes.ts`, `src/messaging/TelegramAdapter.ts`: `MobileInboundTrust.sender` is logged on the inbound row.
- `src/server/AgentServer.ts`: wires the store lookup, the Telegram owner id and the people namespace.
- `dashboard/phones.js`: the Phones card shows whose phone each row is.
- `src/core/PostUpdateMigrator.ts` + `src/scaffold/templates.ts`: a new "Phones belong to people" CLAUDE.md section plus an in-place rewrite of the old "the owner's name" chat sentence.

Tier 2: identity and authority on an auth surface. About 700 source LOC. Spec review: 3 cross-model rounds plus one internal round and one code review. Findings changed the build in eight places:
- the routes the first draft missed;
- MSP Telegram id dropped;
- machine-namespaced person references;
- reassign can't raise to owner;
- reassign can't move sideways;
- the owner's Slack id treated as the owner;
- one machine-id source;
- the rollback guard.

## Decision-point inventory

- Device admission (`deviceAuthenticator`) — modify: also refuses a phone whose person is unknown (fail closed).
- Conversation access (`mayUseConversation` via `deviceMayUse`) — add: an invariant role rule, with the owner's grants as the only way to widen it.
- Grant change — add: accepted only with an owner phone's device signature.
- Mint / reassign validation — add: invariant registry checks.
- No LLM judgment, no new detector.

---

## 1. Over-block

- An MSP phone gets 404 on the owner's app conversations and 403 `owner-only` on Slack. This is the operator's chosen default, and the owner's switch opens either one.
- A phone whose person was removed from `users.json` stops working (except status, confirm, revoke). That's intended: it never becomes an owner phone. A `users.json` that can't be read has the same effect on MSP phones only, and owner phones are unaffected.
- An MSP phone's Telegram-topic message carries no Telegram id. Commands or standing authorization that need a proven Telegram sender therefore don't apply to it. That is the point: those require Telegram proof.

## 2. Under-block

- Telegram topics, sessions and attention are fully shared with the MSP. That is a deliberate product choice (§3.4).
- An MSP with the owner's `slack` grant posts into the owner's Slack conversations under the MSP's name and the MSP's own Slack standing. The owner chose that.
- Downgrade to a build ≤ 1.3.1627 reads MSP phones as owner phones. The documented procedure is to revoke MSP phones before a hand downgrade (spec §8).

## 3. Level-of-abstraction fit

- The person is resolved once at the authentication layer and rides on the request.
- Access is one pure function called by every conversation route. A unit test enumerates `DEVICE_ALLOWLIST` and fails when a route that takes a conversation is not flagged.
- The registry is the existing `UserManager` store, read-only through `readProfilesFromDisk`. No parallel identity store.

## 4. Signal vs authority compliance

Every new decision is a deterministic structural rule over authenticated inputs: the device key, the owner-approved assignment, and the registry. There is no brittle heuristic holding authority. The grant authority is exactly the owner's device signature.

## 5. Interactions

- Idempotent request replays: rename, delete, send and media routes run the access check before the stored-answer lookup, so a reassignment takes effect on the next request.
- Sentinel emergency stop does not read the sender id, so an MSP's "stop everything" still stops.
- `appInjectionTag` lines sent later (a file that arrived after the message) still name `ownerName()`. That is cosmetic, and the main dispatch names the sender.
- Existing tests: two `PairingCodeStore.redeem` deep-equals gained `person: null`. Everything else is unchanged, and all mobile unit/integration/e2e files pass.

## 6. External surfaces

- Additive JSON fields: `person` on mint and `GET /mobile/device`; `role`/`personName` on device rows; `senderName`/`senderRole` on history rows.
- New error codes: `person-unknown`, `owner-only`, `owner-phone-required`, `owner-needs-pairing`, `repair-needed`, `bad-person`, `bad-role`, `bad-grant`.
- The owner's code DM names an MSP person.
- The Telegram mirror line uses the sender's name.
- The app half (owner switches screen, error texts) is posted to topic 134088 in `.instar/vm-test/app-coordination.md`.

## 6b. Operator-surface quality

The Phones card rows now read "iPhone — Justin (MSP) · Active since …". It's plain words, with no ids or role codes beyond "MSP"/"owner", and a removed person reads "no longer assigned to anyone". No new buttons.

## 7. Multi-machine posture

- Device person and MSP grants are machine-local beside the device records (physical-credential-locality: consulted only when that machine verifies the phone's key).
- Conversation `ownerPerson` and message sender fields replicate with the app conversation store. They are namespaced by the same machine id the store stamps, and compare equal only within one registry.
- Pool reads filter after the merge.
- Mixed versions are covered in spec §8.

## 8. Rollback cost

- A revert release must keep the fail-closed rule "a device record with a non-owner `role` is refused" in `deviceAuthenticator` (spec §8), so MSP phones stop instead of becoming owner phones.
- Data needs no repair. Owner phones keep the absent-field shape, and the event fields are optional.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: no new self-triggered action. The only push-adjacent change is a recipient filter (`mayNotify`) that skips sends; it adds no restart, retry, respawn, notify trigger or loop.

---

## Second-pass review

Independent code review (subagent, 2026-11-03) of the full diff. It found no route through which a default MSP phone reaches owner data or identity, and confirmed:
- every conversation route runs the check before replay;
- `deviceMayUse` is permissive only for the bearer principal;
- notify tokens resolve the person;
- the pool filter, MSP Telegram id absence, stranded-create recovery and grant authority are correct.

Two RISKs and two NITs, all fixed before commit:
1. The people namespace used `selfMachineId`, while the store stamps `meshSelfId`. It now uses `peopleMachineId` with the store's exact expression.
2. An MSP profile carrying the owner's Slack id could have spoken as the owner once granted. `isOwnerProfile` now treats the owner's Slack id as the owner, and `speakAs` refuses it.
3. The purge check moved before the replay lookup.
4. The events route check moved before the existence check.

Concur after fixes.
