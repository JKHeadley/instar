---
title: "Telegram test groups through the browser broker"
slug: "telegram-test-groups"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "telegram-message-origin"
eli16-overview: "docs/specs/telegram-test-groups.eli16.md"
approved: false
lessons-engaged: [operator-chores-are-the-agents, narrow-typed-capability-not-raw-browser, P20-verify-the-state, outcome-unknown-is-not-failure, never-silently-cut-the-data-a-decision-depends-on]
feedback: "fb-87d2e9e4-e87"
review-convergence: "2026-11-08T16:12:24.734Z"
review-iterations: 6
review-completed-at: "2026-11-08T16:12:24.734Z"
review-report: "docs/specs/reports/telegram-test-groups-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Telegram test groups through the browser broker

## Problem statement

Live proofs on throwaway agents need a fresh Telegram forum group where a test bot is admin and the operator is the human member. On 2026-11-07 (PR 2760) the group was made by copying the operator's signed-in web Telegram profile. That profile (`justin-telegram`, Mac Studio) is now owned by the Telegram origin broker, which exposes only `GET /telegram/browser/:profileId/snapshot` and `POST /telegram/browser/:profileId/send`. Copying or driving the profile with generic browser tools is refused, correctly. Asking the operator to make groups by hand is a known failure (operator chores belong to the agent).

Two live proofs are blocked today: the Telegram half of unread messages (topic 134088) and the Telegram and Slack rows of dashboard conversations PR #2966 (topic 140618).

## Goal

Typed broker operations that can only ever touch groups this agent made:

1. **create**: a forum supergroup titled `Instar test - <name> [<marker>]`, whose members are the enrolled account (the operator) plus exactly one granted bot, with that bot an admin with topic rights. Returns the channel id and Bot API chat id. Never returns an access hash.
2. **list**: the live set of this agent's test groups, read from the account itself.
3. **delete**: removes one group, only after a live read shows it is creator-owned and carries a marker only this agent can issue.

## Non-goals

- No general admin API, no arbitrary TL method, no caller-supplied JavaScript. Page scripts are static code in `TelegramWebKDriver`; only JSON data produced by `canonicalBrowserJson` is interpolated (same rule as `invoke`).
- No change to the origin outbox, enrollment, or the recovery latch. The send path gets one bounded change (section 6): a reply waiting in the broker queue renews its outbox claim, so no queued work of any kind can let a reply's claim expire.
- No MTProto support: `EnrolledMtprotoDriver` does not implement the new methods, so a profile on that transport answers `test-groups-unsupported-transport` (boot only wires Web K profiles today, so this is a type-level guarantee, not a reachable path).
- No members other than the enrolled account and the one bot; no invite links; no public usernames; no `change_info` for the bot.

## Design

### 1. The account is the source of truth; the marker is the authority

Every group gets a marker `itg-` + 10 base32 characters: 5 random (`crypto.randomBytes`) and a 5-character tag, the first 25 bits of `HMAC-SHA256(key, 'itg:' + profileId + ':' + random)`, where `key` is a dedicated 32-byte secret at `<stateDir>/state/telegram-test-groups.key` (mode 0600, created with `crypto.randomBytes` on first use, never rotated). It is added to `KEY_MATERIAL_PATHS` in `src/core/keyMaterialPaths.ts`, the one list that already makes key files never served by the dashboard file routes, never backed up, gitignored and classified as secret for sync; the never-served walk test covers it. It is deliberately not derived from the rotatable ASP identity key, so an identity rotation or recovery never strands existing groups. An unreadable (present but unparseable or unreadable) key file makes create and delete hold `409 test-groups-key-unavailable`; GET keeps working and reports every candidate as `unverified` with `verification: 'key-unavailable'`. A missing key file is simply created; any groups made under a lost key then appear as `unverified` in GET (see accepted risks).

So a marker is **issuer-scoped and verifiable from the title alone**: only this agent, for this profile, can issue one that checks; another agent on the same account, or a hand-made title copying the syntax, fails verification (forging needs about 2^24 guesses, each checkable only through this agent's rate-limited live read). What it authenticates is the issuer, not the channel: copying an already issued marker onto a different creator-owned forum group would pass. That needs someone with the account itself deliberately renaming a group, and that someone could delete the group directly; it is an accepted risk (see below). The live title is `<caller title> [<marker>]`.

Consequences, which remove the classes of failure a ledger-as-authority design has:
- **Delete authority** is: a live read shows the channel is creator-owned (`pFlags.creator`), a forum supergroup (`pFlags.megagroup`, `pFlags.forum`), its title starts with `Instar test - ` and ends with ` [<marker>]`, and the marker verifies. No local record is needed, so a lost, stale or restored file can never strand a group or authorize a wrong one.
- **The live cap** is counted from the account: the number of verified groups in a complete read.
- **A lost create outcome** needs no reconcile: the group, if it exists, appears in the next list and is deletable like any other.

### 2. Grant (config, create only)

A new optional key in the Telegram messaging config, beside `browserSendAllowance`:

```json
"messageOrigin": {
  "testGroups": {
    "profileId": "justin-telegram",
    "accountId": "<enrolled account id>",
    "bots": [{ "username": "instar_pr2760_livetest_bot", "userId": "<bot user id>" }],
    "decisionRef": "<attribution reference>",
    "expiresAt": "<ISO-8601 instant, at most 30 days ahead when read>"
  }
}
```

`readTestGroupGrant(origin, now)` mirrors `readBrowserSendAllowance`: exact key sets; `profileId` `^[A-Za-z0-9_-]{1,64}$`; `accountId`, `userId` decimal digits; `username` a valid Telegram username ending in `bot`; 1 to 8 bots, no duplicate username or id; `decisionRef` must be exactly one well-formed attribution source marker, parsed by the existing `parseMarkers` in `src/core/attribution/marker.ts` (for example `[source: telegram 134088/123456 2026-11-08]`), pointing at the logged message that carries the decision; a bare feedback id the agent filed itself is not accepted; `expiresAt` parses, is in the future, and is at most 30 days after `now`. Anything else reads as `null`. It rides the existing config snapshot as `snapshot.testGroupGrant`.

The grant gates **create only**. List and delete need no grant, because they can only reach groups carrying this agent's marker; revoking or expiring the grant never strands cleanup.

This is an **agent-held grant**, not an operator signature. Echo writes it on the machine that owns the profile. Whether Echo's standing authority covers writing it is decided once, by Echo, when Echo approves this spec: the approval line records either "covered by <reference>" or "needs one exact-scope operator approval" (profile, account, bot list, caps, expiry, through a prefilled Approve/Decline in Echo's own authenticated operator topic). That is a live-proof precondition, not a build step. The builder writes no grant on the Studio. `grant.accountId === enrollment.accountId` is a consistency check, not corroboration.

### 3. Routes and gates

Mounted in `telegramOriginRoutes.ts` beside `send`/`snapshot`:

| Route | Body | Result |
|---|---|---|
| `POST /telegram/browser/:profileId/test-groups` | `{ "title": string, "bot": string }` exactly | `200 { channelId, chatId, title, bot, createdAt }` |
| `GET /telegram/browser/:profileId/test-groups` | none | `200 { complete, groups: [{ channelId, chatId, title, date }] }` |
| `POST /telegram/browser/:profileId/test-groups/:channelId/delete` | `{}` | `200 { channelId, state: "deleted" \| "gone" }` |

Gates, each failing closed:
1. Bearer auth (global middleware).
2. `runtime.browsers.get(profileId)` exists and carries a `testGroups` capability (wired at boot, section 8), else `503 telegram-browser-not-enrolled`.
3. Verified origin session token (`X-Instar-Origin-Session`) through `runtime.service.sessionProducer`, the credential `send` requires; the producer's `originMachineId`, `harnessId`, `sessionId` go into the audit log. Failure: `409 telegram-origin-held`.
4. Snapshot healthy, fresh, `telegram.enabled`. **Create** additionally (missing or invalid grant: `403 test-groups-not-granted`; lease not held: `409 test-groups-not-lease-holder`): grant present and unexpired, `grant.profileId === profileId`, `grant.accountId === enrollment.accountId`, bot still granted with the same id, and the lease held.
5. Body: `title` matches `^Instar test - [A-Za-z0-9][A-Za-z0-9 ._:#()/-]{0,95}$`, no two consecutive spaces, no trailing space; `bot` case-insensitively equals one grant username (leading `@` stripped); `channelId` `^[1-9][0-9]{0,19}$`. Unknown keys: `400 invalid-test-group-request`.
6. **Busy rule**: at most one test-group operation per profile queued or running, and none admitted while the broker has any operation queued or running or the executor has a send in flight (an in-flight counter around `OriginBrowserExecutor.send`/`execute`). The check and the enqueue happen synchronously together. Refusal `429 test-groups-busy` with `retryAfterMs: 5000`. This keeps admin work out of the way of replies (latency); reply safety comes from claim renewal (section 6).
7. **Create caps**, checked inside the create operation against data read at that moment: verified live groups (complete read) fewer than 5, and unverified marker-shaped candidates fewer than 20 (a separate ceiling with its own reason, `unverified-candidates`, so another agent's groups on a shared account are visible but never consume this agent's cap); creates in the last 24 h fewer than 10, counted as the larger of audit-log create attempts and live verified groups whose `date` is within 24 h; no flood hold. Refusals `429 test-groups-limit` naming the limit. An incomplete read refuses create (`409 test-groups-read-incomplete`).

GET and delete answer on the machine that owns the profile; elsewhere `503` like `send`.

### 4. Audit log

`<stateDir>/state/telegram-test-groups.jsonl`, append-only, one JSON object per line, `fsync` after each append, mode 0600: `{ at, op: 'create'|'delete'|'hold', phase: 'intent'|'outcome'|'hold', profileId, accountId, channelId?, title?, bot?, outcome?, reason?, decisionRef?, producer }`. Never stored: access hashes, tokens, session strings, message text.

- Create writes its `intent` line after the cap checks pass and immediately before the create evaluation (so refusals never count as attempts); if the append fails the create is refused (`409 test-groups-audit-unavailable`). Every operation writes an `outcome` line.
- The log carries the flood hold: a line with `reason: 'flood-wait'` and `until`.
- Read for caps: lines from the last 24 h. A torn final line without a newline (a crash mid-append) is truncated on open. Damage anywhere else moves the file aside to `state/telegram-test-groups.damaged-<ts>.jsonl` and starts a new log whose first line is a conservative hold: creates refuse for 24 h (`429 test-groups-limit`, `audit-damaged`). It heals itself, never lifts the cap, and needs nobody.
- When the file exceeds 2 MB it is rewritten (temp + fsync + rename) keeping the last 30 days.
- A missing file is normal (first use); the live cap does not depend on it, and the daily cap still counts live groups made in the last 24 h.
- The audit log and key file are declared in the State-Coherence Registry with their machine-local posture, so the coherence lints cover them.
- Registration: the prefix `state/telegram-test-groups.` is added to `ORIGIN_LOCAL_PREFIXES` in `OriginLocalPaths.ts`, the list that already drives the gitignore defaults, the `PostUpdateMigrator` gitignore migration, git-sync exclusions and backup blocked prefixes for the other origin-local files. Temp files are named `state/telegram-test-groups.<uuid>.tmp` so the prefix covers them. A test asserts the path is excluded from sync and backup.

### 5. Driver and page scripts

Evidence for TL shapes: tweb's serializer (`src/lib/mtproto/tl_utils.ts`: `const pFlags = obj.pFlags || obj` when storing flag fields) takes method flags as top-level booleans and constructor flags under `pFlags`; deserialized objects carry flags under `pFlags`. The build canary still gates every operation on an enrolled, reviewed Web K build.

`TelegramBrowserDriver` gains three optional methods: `listTestGroups`, `createTestGroup`, `deleteTestGroup`. `TelegramWebKDriver` implements them; **the boot `driverFactory` wrapper in `TelegramOriginBoot.ts` forwards all three** (today it forwards five named methods). Each runs one `Runtime.evaluate` whose script first re-runs the build/account probe in the same evaluation (the `invoke` pattern; `probeExpression` gains a deadline parameter that bounds both its `users.getUsers` stop time and its asset-fetch loop, and a probe that runs out of time returns a typed `budget` failure before any mutating call), passes `{rawError: true, noErrorBox: true, stopTime}` to every `invokeApi` with `stopTime` at most the evaluation deadline minus 3 s, and returns only the typed object below. Errors come back as `{ok:false, step, code, type}`, `type` copied only if it matches `^[A-Z_0-9]{1,48}$`.

**One identity predicate** (`isTestGroupCandidate`) is shared by every script: `_ === 'channel'`, `pFlags.creator`, `pFlags.megagroup`, `pFlags.forum`, title matches `^Instar test - .{1,112} \[itg-[a-z2-7]{10}\]$`. Marker verification (the HMAC tag) happens in Node, which holds the key.

**listTestGroups({deadline})**: `messages.getAllChats({except_ids: []})`. Returns `{ok:true, complete, groups: [{channelId, title, date}], requested?: {present: boolean}}` for candidates only, at most 100; `complete` is false for `messages.chatsSlice` or when the 100 bound was hit. When called from delete with a `channelId`, `requested.present` says whether that id is in the complete read at all, so delete can tell `gone` from `not a test group`. The candidate channel objects are kept in the page for the following delete evaluation, so an operation calls `getAllChats` at most once. Node splits them into verified groups and `unverified` ones (marker-shaped but the tag fails: another agent's, a hand-made imitation, or a group from a lost key). GET shows both; unverified ones count only toward their own ceiling and are never deletable through these routes. No other chat's data leaves the page. GET answers from the last complete read if it is under 15 s old (with `readAt`), and a cached answer skips the busy rule and the queue; only a live GET is a test-group operation. Any two live reads of one profile are at least 5 s apart and at most 60 run per rolling hour; both are checked at admission, in the same synchronous step as the busy rule, and refused with `429 test-groups-busy` carrying `retryAfterMs` (never a sleep inside the queue); create and delete always read live, and the cache is cleared before every evaluation that can change the account (create, rollback, delete), so a GET after any create or delete, including an unknown outcome, always reads live. A `420` from `getAllChats` writes a flood-hold line that holds all three operations until it expires.

**createTestGroup({title, bot: {username, userId}, deadline})** (title already includes the marker):
1. `contacts.resolveUsername({username})`: the `users` entry with `id === bot.userId` must have `pFlags.bot` and not `pFlags.deleted`; else `{ok:false, step:'bot-identity'}` (known, nothing made).
2. Before the irreversible step, require at least 15 s left in this evaluation (four later calls at about 3 s each, the last of which may be the rollback delete); else `{ok:false, step:'budget'}` (known, nothing made).
3. `channels.createChannel({megagroup: true, forum: true, title, about: ''})`. The result must contain exactly one channel that passes the identity predicate with exactly this title; else `{ok:false, step:'create-shape', uncertain: true}` (nothing else is touched; any group made shows up in list). A refusal with code 400/403/406/420 is known (`420` returns `retryAfterSec` from `FLOOD_WAIT_n`); any other error after the call was sent is `{ok:false, step:'create', uncertain: true}`.
4. `channels.inviteToChannel({channel, users: [inputUser]})`, where `channel` is built from the created channel object (its access hash never leaves the page). Non-empty `missing_invitees` is a failure.
5. `channels.editAdmin({channel, user_id: inputUser, admin_rights: {_: 'chatAdminRights', pFlags: {manage_topics: true, pin_messages: true, delete_messages: true}}, rank: ''})`. The literal is static and pinned by a test.
6. Verify: `channels.getParticipants({channel, filter: {_: 'channelParticipantsRecent'}, offset: 0, limit: 10, hash: '0'})` is `channels.channelParticipants`, `count === 2`, exactly the enrolled account as `channelParticipantCreator` and the bot as `channelParticipantAdmin` whose true `admin_rights.pFlags` include `manage_topics`, `pin_messages`, `delete_messages`, are otherwise only `other` (the implied manage-chat right Telegram adds to every admin), and include none of the pinned forbidden set (`change_info`, `post_messages`, `edit_messages`, `ban_users`, `invite_users`, `add_admins`, `anonymous`, `manage_call`, `post_stories`, `edit_stories`, `delete_stories`).
7. On failure in 4-6: `channels.deleteChannel` on the channel from step 3 (which already passed the predicate with the exact marker title). Returns `{ok:false, step, channelId, rolledBack}`.
Success: `{ok:true, channelId}`.

**deleteTestGroup({channelId, title, deadline})**, called only after Node verified `title` (from a live list read in the same operation) carries a valid marker. From that read: the id absent from a complete read means `gone` (200) without a second evaluation; the id present but not a verified candidate means `409 test-group-failed` (`not-a-test-group`), nothing touched; an incomplete read that still contains the id as a verified candidate proceeds (the step-2 re-check is the real identity check); an incomplete read without the id means `409 test-group-failed` (`incomplete-read`):
1. Take the channel object kept from the list evaluation (no second `getAllChats`); if the page lost it (process restarted between evaluations) return `{ok:false, step:'stale-read'}` and nothing is touched.
2. Fresh read `channels.getChannels({id: [inputChannel]})`: `CHANNEL_INVALID` or a `channelForbidden` with a valid access hash means `gone`. Otherwise the channel must pass the predicate and its title must equal `title` exactly; else `{ok:false, step:'identity-mismatch'}`, nothing deleted.
3. `channels.deleteChannel({channel})`. Returns `{ok:true, outcome:'deleted'}`.

Each driver and route result is one discriminated schema defined once in `TelegramTestGroups.ts` (including GET's `readAt` and per-group `verification`, and the page failure fields `uncertain`, `rolledBack`, `retryAfterSec`); Node parsers accept only the exact keys and types listed (digit strings, booleans, enumerated steps, titles matching the predicate) and refuse anything else, so a changed page script cannot leak an access hash through a route. Route tests scan every response body for `hash`.

### 6. Broker operation and reply safety

`TelegramBrowserBroker.runTestGroupOperation(kind, steps, authorize)` is a dedicated path modelled on `execute()`:
- Uses the shared `enqueue` (never beside a send on the one browser process), `isProfileExclusivelyOwned`, and the build canary with the durable recovery latch (`verifiedReadDriver`). The canary account must equal `enrollment.accountId` for every kind (and the grant account for create).
- Calls `authorize()` again immediately before **each** page evaluation (create: grant present and unexpired, same bot username and id, lease held; all: enrollment account unchanged). Create's evaluations are list (caps) then create; a failure before create is known with no Telegram call. Delete's are list (find and verify the title) then delete.
- Sets `evaluated = true` immediately before an evaluation that can change the account. Any error before it is known. After it, an error, transport loss or deadline is `unknown` (the response says so with `retryable: false` and points to GET, which shows whether the group exists).
- Budgets: each evaluation at most 20 s; whole operation at most 45 s, measured from when the driver is ready (a cold start is bounded separately by the existing 25 s start timeout, and the broker canary's probe receives the operation deadline through the same new parameter); a known `budget` failure leaves the warm driver open so a retry is fast; before starting the create evaluation Node requires at least 22 s left in the operation (20 s evaluation + margin), else a known `budget` failure. A typed `{ok:false}` page result leaves a healthy driver open; only transport loss, deadline or an unsupported build closes it, as for sends. An ordinary test-group failure (a typed page result, a refusal, a budget or identity failure) never sets the broker's `held` status; the shared build canary and recovery latch keep their existing behaviour, including the unsupported-build hold.
- Returns a discriminated union; routes map known failures to `409 test-group-failed` with the step, unknown to `409 test-group-outcome-unknown`, broker holds to `409 telegram-browser-held` (same shape as send).

**Reply safety (the one send-path change).** From the moment a reply child is claimed until its broker call settles (covering the queue wait, the canary, dispatch and the invoke), `OriginBrowserExecutor` renews its claim every 20 s with the store's existing `renewClaim` (lease 60 s); the outcome is recorded immediately after it settles. A failed renewal stops renewing and sets `renewalLost` on the executor's claim entry; `authorizePreparedChild` checks that flag first and refuses before `markDispatched`, so a child whose renewal failed is never dispatched. A renewal that fails after dispatch changes nothing: the invoke's outcome is recorded under the existing claim fence and the existing unrecorded-receipt path, exactly as today. Tests cover a failure before and after dispatch. Today nothing renews, so any long queued read can already expire a waiting reply and the reaper then records it delivered-ambiguous; this closes that for every caller. Test: a reply queued behind a 45 s test-group operation followed by a cold start still dispatches.

### 7. Outcomes

- Create success: `200` with ids. Known failure before the channel existed: `409 test-group-failed` (step). Rollback confirmed: `409 test-group-failed` with `rolledBack: true`. Rollback not confirmed, `create-shape` or `uncertain`: `409 test-group-outcome-unknown`; the caller lists, and deletes anything there that it does not want.
- FLOOD_WAIT on create appends a flood-hold line (`until` = now + advertised seconds); creates refuse until then.
- Delete: `deleted`, `gone` (absent from a complete read), or `409 test-group-failed` (`not-a-test-group`, `identity-mismatch`, `incomplete-read`, `stale-read`).

### 8. Boot wiring

`TelegramOriginBoot` builds one `TelegramTestGroups` instance per enrolled profile and stores it on the `runtime.browsers` entry as `testGroups` (one audit log path per agent, one in-process append chain shared by all profiles). An optional boot option `webKDriverFactory` (default `new TelegramWebKDriver`) is the test seam.

### 9. Agent awareness and migration parity

- `OriginAwareness.ts`: new `telegramOriginTestGroupsAwareness()` with a unique marker string, included in `telegramOriginAwareness()`; the "exposes only typed operations" sentence names the test-group routes.
- `PostUpdateMigrator`: an idempotent refresh of the old "exposes only" sentence, a `migrateClaudeMd` append guarded by the marker, and a row in the shadow-mirror table for Codex/Gemini agents; each with an idempotency test.
- The text: when a live proof needs a Telegram forum group with a test bot, create one through these routes (granted bots only), keep the chat id, delete it when done; never ask the operator to make groups.

## Security review focus (scope limits)

| Limit | Enforced in |
|---|---|
| Only `Instar test - ` titles from a closed character set are created | route regex; page create checks the created title |
| Nothing is deleted (including rollback) unless creator-owned, forum supergroup, marker title, and (outside rollback) the marker verifies with this agent's key | shared page predicate + Node HMAC check + page re-check of the exact verified title before delete |
| Another agent's group, or a hand-made group whose title imitates the syntax, is never touched | marker tag is keyed by this agent's dedicated marker key and the profile id (a copied issued marker is the accepted residual) |
| Only a granted bot, matched by username, id and bot flag | route, re-authorize before evaluation, page resolve step |
| Exactly two members; bot rights exactly manage_topics, pin, delete messages | static literal + participant verify (exact rights set) with rollback |
| No access hash, token or session string leaves the page | typed returns + exact-key Node parsers + response scan test |
| No raw TL or caller JavaScript | static methods and literals; data only via `canonicalBrowserJson` |
| No other chat's data leaves the page | list returns only candidates matching the predicate |
| Revocation reaches queued work | `authorize()` before every evaluation |
| Bounded blast radius | 5 live (counted on the account), 10 creates per 24 h, flood hold, one operation at a time, 20 s per evaluation, 45 s per operation, grant expiry at most 30 days |
| Replies never lose their claim while waiting | claim renewal for all queued work; busy rule for latency |

## Testing

- Unit: grant parser (valid; each malformed shape; expiry bounds; decisionRef shape); title regex (en-dash look-alike, double spaces, U+2028, combining marks, overlength); marker issue and verify (wrong key, wrong profile, flipped bit); audit log (append, fsync failure refuses create, skipped-line refusal, rotation, flood hold, 24 h counting); result parsers refuse extra keys; broker op (busy rule, re-authorize before each evaluation, revocation while queued gives no driver call, `evaluated` split, budgets, driver left open on typed failure); claim renewal (renews while queued and across an invoke that crosses a renewal tick, stops when the broker call settles, stops on a failed renewal); page script builders (method allowlist, pinned rights literal, data only via `canonicalBrowserJson`).
- Integration: the three routes through Express with a fake driver: each gate's refusal; create happy path; caps from a fake account read (5 live refuses; incomplete read refuses); rollback; outcome-unknown then list shows the group; delete of a group with a bad marker, another profile's marker, or a changed title refused; `gone`; no response contains `hash`.
- Wiring/E2E: the real boot path with a fake page layer through `webKDriverFactory`; the broker's driver exposes the three methods as functions; routes 200 when granted, create 403 when not, list and delete 200 without a grant.

## Live proof

Preconditions, each checked and reported: the Studio server runs this code; `GET /telegram/origins/status` (the operator status route Echo reads on the Studio) shows `justin-telegram` enrolled and not held; the Studio holds the lease; Echo has written the grant naming only `@instar_pr2760_livetest_bot`.

Steps: create `Instar test - test groups proof`; confirm through the spare bot's Bot API (`getChat`, `getChatMember`; token from the Studio vault `telegram_pr2760_test_bot_token`, never printed) a forum supergroup with the bot as admin with `can_manage_topics`; confirm the group appears in GET with `complete: true`; a throwaway agent configured with that bot and chat id creates one topic and posts one message; delete through the broker; confirm `getChat` now fails and GET no longer lists it. No message goes to any operator chat.

## Decision points touched

| Decision | Classification | Basis |
|---|---|---|
| Create requires an unexpired agent-held grant naming this profile and account | invariant | basis: enumerable-domain; evidence: the grant is an exact record with closed fields |
| Caller title regex with the `Instar test - ` prefix | invariant | basis: irreversible-consequence; evidence: groups appear in the operator's real chat list; a closed alphabet that Telegram does not rewrite keeps the exact-title checks reliable |
| Marker keyed by this agent's dedicated marker key and profile is the delete authority | invariant | basis: irreversible-consequence; evidence: delete is permanent; only a marker no other party can produce scopes it to groups this agent made, without trusting any local file |
| Bot must match grant username, id and bot flag | invariant | basis: enumerable-domain; evidence: the allowlist is a closed set |
| Exactly two members and exactly three bot rights, else rollback | invariant | basis: enumerable-domain; evidence: a fresh group holds exactly what the script added |
| Bot rights literal (manage_topics, pin, delete messages) | invariant | basis: external-constraint; evidence: Bot API `createForumTopic` requires `can_manage_topics`; `change_info` is excluded because it would let the bot rename the group out of its delete check |
| At most 5 live groups, counted on the account | invariant | basis: irreversible-consequence; evidence: each sits in the operator's real chat list; two blocked proofs need one each; a constant changed by PR |
| At most 10 creates per 24 h (attempts or live, whichever is larger) plus the flood hold | invariant | basis: external-constraint; evidence: Telegram answers FLOOD_WAIT_n to repeated channel creation and the penalty lands on the operator's own account |
| Incomplete read or damaged audit log refuses create | invariant | basis: irreversible-consequence; evidence: the caps would be blind, and new groups would pile up unseen |
| 20 s per evaluation, 45 s per operation, 22 s required before the create evaluation, 15 s before createChannel inside it | invariant | basis: external-constraint; evidence: each evaluation passes its own deadline into the probe and every RPC, so the bound is real; after createChannel at most four RPCs (invite, promote, verify, rollback) remain, and 15 s gives each about 3 s plus margin; the live proof records actual per-step timings; these bound reply latency, claim renewal carries reply safety |
| Claim renewal every 20 s at a 60 s lease until the broker call settles | invariant | basis: external-constraint; evidence: `leaseMs: 60_000` is the existing claim lease; renewing every 20 s leaves 40 s of lease after any single missed tick |
| Busy rule: no admission while anything is queued or in flight | invariant | basis: irreversible-consequence; evidence: replies are the operator's live conversation; admin work is never admitted ahead of a queued or in-flight reply; a reply arriving during an operation waits at most the 45 s operation, plus the driver's cold start (at most 25 s) when that operation began cold or ended in a transport failure; claim renewal keeps it safe |
| GET served from a complete read under 15 s old; live reads at least 5 s apart and at most 60 per hour; flood hold on any `getAllChats` 420 | invariant | basis: external-constraint; evidence: `getAllChats` returns the whole account in one RPC and its flood penalty lands on the operator's account; 15 s covers a caller polling after outcome-unknown at the 5 s busy retry |
| Grant expiry at most 30 days | invariant | basis: irreversible-consequence; evidence: the grant authorizes permanent actions on the operator's account and is renewed deliberately |
| List returns at most 100 candidates; unverified ceiling 20 | invariant | basis: enumerable-domain; evidence: this agent holds at most 5 verified groups by construction and at most 20 unverified ones are tolerated before create refuses, so 100 leaves room and still marks truncation as incomplete rather than cutting data silently |
| Outcome-unknown is never retried by a route | invariant | basis: irreversible-consequence; evidence: a blind retry can create a second group; the caller lists instead |

## Multi-machine posture

- Test-group routes and the broker operation: machine-local.
  machine-local-justification: physical-credential-locality impossible-because="the operator's web session is enrolled exclusively to one broker-owned profile on one machine; a relocated copy is a second live session that breaks the exclusive-enrollment proof the broker checks before every operation" permanence=permanent
- The audit log: machine-local.
  machine-local-justification: physical-credential-locality impossible-because="it records actions taken through the one enrolled profile and carries that account's flood hold; authority itself lives in the account and the marker, so nothing needs replicating" permanence=permanent
- The marker key: machine-local.
  machine-local-justification: physical-credential-locality impossible-because="it signs markers for groups that only the one enrolled profile can create or delete; a copy elsewhere would grant authority no other machine can exercise" permanence=permanent
- `GET .../test-groups` is a status surface scoped to the machine that owns the profile; other machines answer 503 like `send`.
- `/telegram/origins/status` is only read by the live proof as a precondition; its existing scope (per machine, plus `scope=pool`) is unchanged.
- The grant is read from the local messaging config like `browserSendAllowance`.
- No user-facing notices are added.

## Frontloaded Decisions

1. Authority is the issuer-keyed marker verified against a live read; the local file is an audit log only.
2. Bot rights: manage_topics, pin_messages, delete_messages. No change_info.
3. Caps: 5 live (from the account), 10 creates per 24 h, flood hold, one operation at a time, the budgets above.
4. Grant needed for create only; list and delete work without it so cleanup never strands; lease for create only.
5. MTProto: not implemented.
6. Grant author: Echo, under its standing authority or one exact-scope approval it raises; decided at spec approval; the builder never writes it.
7. Live proof through Echo's Studio broker once it runs this code, spare bot only, group deleted at the end.

## Accepted risks

- **Copied issued marker.** A party with access to the operator's account could rename a different creator-owned forum group to carry a marker this agent issued, and a later delete of that channel id would pass. Binding the marker to the channel id would need a second rename after creation, with its own interrupted-rename case, for a scenario whose actor can already delete the group directly. Accepted.
- **Lost marker key.** If `telegram-test-groups.key` is lost, a new key is created and existing groups show as `unverified` (visible in GET, counted only toward the unverified ceiling, not deletable here); Echo reports them as one exact list (titles and ids) so they can be removed in one step. Accepted: it needs the loss of the agent's own state, and the groups are inert and clearly labelled.
- **Lost audit log.** If the log file is deleted, the daily count falls back to live groups made in the last 24 h, so at most one extra day's quota (10 attempts) becomes available; the live cap of 5 is still counted on the account, and a lost flood hold costs one more refused call because Telegram repeats FLOOD_WAIT and the reply re-records it. Keeping a second durable copy of a rate counter is not worth its machinery here. Accepted.

## Maturation plan

- **test-agent-live:** Unit, integration and boot-path tests with a fake page layer; no real account is touched before the live proof.
- **dev-agent-live:** Echo on the Studio after the code lands, with a grant naming only the spare bot: the live proof in this spec (create, verify via Bot API, topic and message from a throwaway, delete, confirm gone), then the two blocked proofs (topics 134088 and 140618).
- **fleet:** Ships with the release but inert everywhere: create needs an agent-held grant, and only an agent whose broker owns an enrolled Web K profile has these routes at all.
- **graduation criterion:** Ten test groups created and deleted on the Studio with no group left behind, no rollback that failed to confirm, no reply held or reaped during a test-group operation, and per-step timings inside budget.
- **dark-window:** Until Echo writes the grant on the Studio; no time limit, because the routes do nothing without it.
- **ladder:** not applicable: no flag, one enrolled profile, gated by a per-use agent-held grant (absent means dark)

## Open questions

*(none)*

## Rollback

Dark by default: no grant, no creates. Removing or expiring the grant stops creates (new and queued); list and delete keep working. Code rollback order is agent-owned: Echo lists and deletes every remaining test group, confirms the list is empty, removes the marker key and audit log (a reverted `KEY_MATERIAL_PATHS` would otherwise stop protecting the key file), reverts, then ships a follow-up migration removing the awareness text (migrations only add, so a bare revert would leave agents told about routes that 404).
