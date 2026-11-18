---
title: "Work cards from the owner's phone: read one card, make a card from a message"
slug: phone-work-cards
eli16-overview: phone-work-cards.eli16.md
parent-principle: "Mobile-Complete Operator Actions"
author: echo
created: 2026-11-17
parent: docs/specs/work-front-doors.md (stage 2b, "Make a card" from a message)
commitments: CMT-1930 (create), CMT-1931 (read), part of CMT-1841
review-convergence: "2026-11-18T04:09:48.149Z"
review-iterations: 6
review-completed-at: "2026-11-18T04:09:48.149Z"
review-report: "docs/specs/reports/phone-work-cards-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 1
contested-then-cleared: 0
approved: true
approved-by: "echo under Justin's standing rule (2026-10-22: \"I should ONLY have to approve constitution changes\") and his go in topic 134088 (2026-11-17 15:37 PST: \"yes please proceed with this and the remaining 'instar topic managment' work\"); no constitution file or CODEOWNERS path touched (docs/STANDARDS-REGISTRY.md, .github/CODEOWNERS checked 2026-11-17)"
---

# Work cards from the owner's phone

## Problem statement

Stage 2b of the work front doors (`docs/specs/work-front-doors.md` §7, stage 2 bullet 2) gives every
message a "Make a card" action. The console has it (PR #3250): a sheet prefilled from the message, the
dashboard PIN, then the ordinary owner card create (`POST /work-board/cards`) with
`source: { conversationKey, messageId }`. The phone apps (iPhone, Android, Mac) cannot do the same:

1. **No single-card read for a phone.** The console reads one card with `GET /work-board/cards/:id`.
   That path is not on the phone's device allowlist, so a phone that opens a card from a tile, a
   notification or the card it just made has to re-read the whole board and search it.
2. **No phone create.** The console create needs the dashboard PIN. A phone has no PIN path; its
   person-proven writes (work-card taps, approvals, switches) use Face ID over a single-use challenge
   bound to the exact action (`docs/specs/mobile-native-permissions.md` §3.3). There is no such action
   for making a card.

## Proposed design

Two routes, closed to every phone but the owner's (the read also answers the bearer, as the console's
read does; the create takes only the owner phone's Face ID), both running the work board's existing code so a phone can never
do more than the PIN-confirmed console.

### 1. `GET /mobile/work-board/cards/:id` (CMT-1931)

- **Who:** an active owner phone, device-signed. Device allowlist entry
  `GET ^/mobile/work-board/cards/wc_[0-9a-f]{16}$`, `ownerOnly: true`, sharing the existing
  `work-board-reads` bucket of `GET /mobile/work-board` (no new rate is introduced: opening a card and
  reading the board draw on the one allowance the board read already has, and a refused read is a
  plain retryable 429 the phone already handles). It is NOT added to `TEAM_ROUTE_TIERS`, so a member or guest phone is
  refused by the device authenticator before the handler (team routes are closed unless named). The
  bearer also reaches it (the console's own read posture: a bearer read is the agent's view).
- **Handler:** the console's single-card handler itself (one function with a path flag, registered on
  both paths), so the per-card visibility rule is literally the same: owner and agent see every created
  card; any card the caller may not read is `404 not-found`. The one difference is a kind of caller,
  not a card: a scoped session sees its own card on the console path, and on the phone path is refused
  with the board read's `403 scoped-session-reads-its-own-card-only` (the phone path is for phones,
  matching `GET /mobile/work-board`).
- **Answer:** `200 { card }` where `card` is exactly `cardJson(...)` with the same extras the board
  gives (behind, last written on, replied-after-question, capacity wait, broken attachments,
  phone-only). Refusals: `401 unauthorized`, `403` (a team phone at the device authenticator, or a
  scoped session), `404 not-found`, `429` (the shared read allowance), `503 work-board-disabled` /
  `work-board-starting`.

### 2. `POST /mobile/work-board/cards` (CMT-1930)

**Request body** (JSON):

```
{
  "requestId": "<client id, lowercase: ^[a-z0-9][a-z0-9-]{7,63}$ — a lowercase UUID fits>",
  "title": "<non-empty text>",
  "need": "<non-empty text>",
  "doneWhen": [ { "id": "d1", "text": "<non-empty text>" }, ... ],   // at least one item, ids unique, ^[A-Za-z0-9_-]{1,64}$ (the store's item id rule)
  "source": { "conversationKey": "telegram:<topicId>" | "app:<conversation uuid>", "messageId": "<1..200 chars, no control characters>" },
  "challenge": "<from the challenge route>",
  "presenceSig": "<presence-key signature>",
  "preflight": true            // optional: run the checks and answer the line to sign; writes nothing, needs no challenge
}
```

**Device allowlist:** `POST ^/mobile/work-board/cards$`, `body: 'json'`, `ownerOnly: true`, the existing
`work-card-taps` bucket (30/min per device, shared with card taps: making and tapping cards are one kind
of owner work-board action). The challenge route's own `permission-actions` bucket (12/min) bounds how
many Face ID creates can be proven. Not in `TEAM_ROUTE_TIERS`.

**What is stored is exactly what is signed.** The route rebuilds the draft from the body before it
hashes or writes: `title`, `need`, each `doneWhen` item as exactly `{ id, text }` (so `certify` takes the
store's default, `owner-confirms`: a phone card's done items are confirmed by the owner, and the agent
cannot be given self-certification by an extra field the owner never saw), and `source` as exactly
`{ conversationKey, messageId }`. Every other field anywhere in the body is dropped before the write.

**Limits are the board's, not new ones.** The route checks only types and presence; every length
limit (title, need, each done item) is the owner-set limit the work board already applies to every
card (`settings.limits`, answered `413 over-limit` with the field and limit named). The one bound the
route adds, `messageId` at most 200 characters, is the bound the console's `messageIdFor` already
stores (it slices to 200), so a phone card and a console card carry the same source. The whole
request is also inside the server's existing JSON body cap.

`source` uses exactly the keys the console's "Make a card" stores (`dashboard/console/make-card.js`
`sourceKeyFor` / `messageIdFor`). Slack is not offered, as on the console. Unknown body fields are
dropped; `outward` is always `false` and the carrier is the agent's default, as on the console
(a card made from a message is the owner's own note to the agent; nothing is approved by making it).

**The signed draft.** `draftHash = sha256hex(canonicalJson({ v: 1, title, need, doneWhen, source }))`
with `WorkCardStore.canonicalJson` (object keys sorted, no whitespace, values as `JSON.stringify`, each
`doneWhen` item as `{ id, text }`). The phone computes it from exactly the fields it shows the owner
(in full, not cut short) before Face ID. The simplest correct client does not need its own canonical
JSON at all: the preflight answers the draft as the server rebuilt it plus its `draftHash`; the app
compares those fields with what it shows by plain string equality and, if they match, asks the
challenge for and signs that hash. A client that also computes the hash itself compares it with the
preflight's; a mismatch is an app bug the app reports instead of asking for Face ID. Either way a wrong
hash cannot produce a wrong card: the server hashes the body it receives and the challenge was issued
for one line. The unit tests pin fixed test
vectors (text with `/`, an emoji, U+2028, a quote, a newline, a tab, a backslash and U+0001) that the
iPhone, Android and Mac builders reproduce, since Swift's and Kotlin's default JSON escaping differ
from `JSON.stringify`. (Sending the draft as an opaque JSON string and hashing its bytes was
considered; it was not taken because the phone permission write gate and every other phone action
already sign a server-rebuilt line, and the preflight hands the app the server's own hash to compare,
so an encoder difference shows up before any Face ID, never as a wrong card.)

**The app's retry contract.** The app mints a fresh `requestId` for each "Make a card" sheet. After the
owner confirms with Face ID and immediately BEFORE it sends the signed create, it durably stores that
id, the exact draft and the pairing it is sending to, marked "possibly sent" (a draft that was only
preflighted is never pending), and keeps them, across app restarts, until it has a TERMINAL answer. A retry is always the owner's own tap (each costs a Face ID; the app never repeats a
write on its own, `docs/specs/mobile-native-permissions.md` §3.6), with the same id and the same draft,
to the same pairing. The owner can always drop a pending card after looking at the board ("Check the
board"); a pending request whose pairing is gone is dropped the same way. Terminal: `201`, `200` with `replayed: true`,
`409 request-id-reused`, `409 card-removed`, and the refusals given only after the server looked the
card up and found none (`404 source-conversation-not-found`, `413 over-limit`, `422 credential-refused`,
`400 invalid-record`): these prove no card exists for the id; and the shape `400`s, which come before
the lookup but depend only on the draft, so the same draft never made a card (a server update that
tightens a shape rule between an attempt and its retry is the accepted edge). All of this is for the
same owner; an owner change makes the phone no longer the owner phone (`403`, not terminal). Not terminal (keep
the id and draft, retry later): a lost answer, any `5xx`, `401 challenge-invalid` / `presence-invalid`,
`403`, `409 presence-key-missing`, `409 no-team-owner`, `429`, and `503`. Editing the card after an
unclear answer is a new card with a new id; a changed draft under the old id is refused
(`request-id-reused`) before Face ID.

**Preflight.** `preflight: true` runs checks 1–4 below (including the write's own checks as a dry run) and answers
`200 { draft: { title, need, doneWhen, source }, draftHash, confirm: { action: "work-card-create", target: requestId, proposalHash: draftHash,
actionLine } }`, writing nothing. The phone calls it before asking for a challenge, so a missing
conversation or a switched-off board is shown before any Face ID prompt. It shares the create's bucket;
its refusals are audited like any other.

**Challenge:** `POST /mobile/permissions/challenge { action: "work-card-create", target: requestId,
proposalHash: draftHash }`. Action line: `work-card-create <requestId> <draftHash>`. The presence key
signs the existing message `instar-permission-action-v1\n<deviceId>\n<host>\n<challenge>\n<line>`.

**Order of checks (each refusal is answered and nothing is written; checks 2–8 are audited, check 1
has no gate identity to audit, as for card taps):**

1. Phone create wired here (`503 work-board-disabled` when the work board dependency is absent).
2. The existing phone permission write gate, unchanged: permission actions on, a device signature,
   this machine's TLS front, an active owner phone, a console PIN set, an enrolled presence key
   (`503 permission-actions-off`, `403 device-signature-required` / `secure-transport-required` /
   `owner-phone-required`, `503 console-pin-not-set`, `409 presence-key-missing`).
3. Body shape → `400` with the field named (`bad-request-id`, `title-required`, `need-required`,
   `done-item-required`, `bad-done-item`, `bad-source`, `bad-message-id`), each with a plain `message`.
4. Pre-checks before the proof, so a refusal knowable from the request never consumes the challenge
   (and, through the preflight, never asks for a Face ID), in this order: the work board is on and
   started (`503 work-board-disabled` / `work-board-starting`); an owner resolves (`409 no-team-owner`,
   with a message; in production the owner key always resolves (the team record's owner, else the
   memory-privacy registry's owner, else `owner`, as for every work-board write), so this guards only a
   board wired without that resolver); if the card for this request already exists: a removed card is
   `409 card-removed` and a different draft `409 request-id-reused` here, before Face ID (the owner's
   phone can read the card anyway, so nothing leaks), and a true replay skips the remaining pre-checks
   and is answered after the proof (so a create whose answer was lost can be recovered even if its
   conversation was deleted since); otherwise the source conversation exists on this
   machine (Telegram: `telegramTopicKnown`, the rule every app write path uses; app:
   `AppConversationService.liveConversation`, not deleted) and this phone's person may read it
   (`deviceMayUse(..., 'read')`, the shared conversation check; for the owner it always admits, so it is
   defence in depth should the route ever be opened to others). Either failing is
   `404 source-conversation-not-found` with the plain message "That conversation is not on the machine
   you are connected to, so no card was made." (a conversation a person may not read does not exist for them);
   then every check the write itself runs, as a dry run that writes nothing
   (`WorkBoardService.createCard(..., { dryRun: true })`: the owner-set length limits `413 over-limit`,
   the credential check `422 credential-refused`, and the store's record shape `400 invalid-record`).
   A card prefilled from a long or pasted message is the likely case for these, so they are shown
   before Face ID. The dry run and the write share one record-shape function and `createCard`'s own
   checks, so a check added there is in the preflight too. An unexpected failure in these checks is `503 precheck-failed`
   ("This card could not be checked just now. Try again in a moment.").
5. The proof: the challenge must have been issued to this device, for this Host, for exactly
   `work-card-create <requestId> <draftHash-of-this-body>`, and the presence signature must verify
   (`401 challenge-invalid` / `presence-invalid`). A body changed after Face ID hashes differently and
   finds no challenge. These two keep the shared proof's bare codes (as for card taps); the app words
   them "That confirmation expired or went to another machine. Try again."
6. The owner key is read again for the write (`409 no-team-owner` if it vanished in between).
7. **Idempotency.** `cardId = "wc_" + sha256hex("work-card-create\n" + ownerPersonKey + "\n" +
   requestId).slice(0, 16)`. If that card exists: its `created` record must be the owner's person
   write with the same draft (`title`, `need`, `doneWhen`, `source` hash equal to `draftHash`) →
   `200 { cardId, conversationKey, card, replayed: true }`, nothing written; a different draft →
   `409 request-id-reused`; a removed card → `409 card-removed` (each with a plain message). On a replay
   the after-create steps (the card's conversation, a poke to the pickup controller) run again: both are
   idempotent (the conversation's key is derived from the card id; a poke only wakes the controller),
   so a create interrupted after the card was written finishes when the phone retries. If creating the
   conversation fails, the answer is still `201` (the card exists), the failure is logged, and the
   conversation is created at the card's next write or the next boot: the console create's behaviour,
   shared through one helper. A removed card is refused before the replay, so a late retry never
   recreates a removed card's conversation. The
   check and the create run in one synchronous step (no await between), so two concurrent requests in
   one process make one card.
8. Create: `WorkBoardService.createCard({ kind: 'person', personKey: owner, proof: 'presence',
   isOwner: true }, { title, need, doneWhen, outward: false, source }, { cardId })`, then the
   console's own after-create steps (create the card's conversation, poke the pickup controller).
   Service refusals pass through unchanged (the dry-run ones again, should the owner-set limits have
   changed in between, and `503 store-unavailable`).

**Answer:** `201 { cardId, conversationKey, card, overSoftBudget? }`, the console create's body (its
`card` carries no board extras; the single-card read does).
Every create attempt that reaches the write gate is in the permission audit (gate refusals included)
(`state/mobile-permission-actions.jsonl`, metadata only) as `work-card-created`, `work-card-replayed`
(a replay, status 200, nothing written) or `refused`. A successful preflight writes nothing and leaves
no row; a refused one is a `refused` row. The permission-actions graduation criterion ("refused rows
only the expected codes", `docs/specs/mobile-native-permissions.md`) counts this route's documented
refusal codes as expected.

**Service change.** `createCard` gains `{ dryRun: true }`: every check it runs, plus the store's record
shape, with nothing emitted. Its optional named card id (today only for the server's own cards,
`serverCard`, agent principal) also accepts an owner person principal. A named id for a person is not
exempt from anything the person's create already passes (person cards are never counted against the
agent's daily ceiling today), and an existing id is still `409 card-exists`.

### Shared code, no drift

The console's single-card read and the console create's after-create steps become two exported
helpers in `workBoardRoutes.ts`, used by the console routes and the phone routes. The console's
behaviour does not change (same checks, same bodies, same status codes).

## Decision points touched

- The phone permission write gate, reused unchanged with one new action kind — invariant; basis: irreversible-consequence; evidence: a created card is a durable, replicated owner-written record that can start agent work once approved, and the gate is the existing floor every phone write already stands on (mobile-native-permissions §3.3); nothing is weighed.
- The `work-card-create` action line — invariant; basis: enumerable-domain; evidence: the challenge is issued for one exact line and the signature covers it; the line either equals the one rebuilt from the body or it does not.
- Source conversation exists and is readable — invariant; basis: enumerable-domain; evidence: the key is `telegram:<id>` or `app:<uuid>`, answered by the same `telegramTopicKnown` / live-conversation read and `deviceMayUse` check every phone write path uses; it can only refuse.
- Idempotent replay, `request-id-reused`, `card-removed` — invariant; basis: enumerable-domain; evidence: the derived card either does not exist, exists removed, or exists with a stored draft whose hash equals or differs from the signed hash.
- `outward: false` and owner-confirmed done items for phone cards — invariant; basis: external-constraint; evidence: the console's "Make a card" (dashboard/console/make-card.js) fixes `outward: false` and sends items without `certify`; a phone card must store what the console stores.
- Pre-checks before the proof — invariant; basis: enumerable-domain; evidence: an ordering of refusals the create itself also gives (the dry run is the write's own checks; the source check is skipped for a replay); it adds no new refusal.
- Device allowlist rows — invariant; basis: external-constraint; evidence: the device authenticator's existing default-closed rule (TEAM_ROUTE_TIERS names what team phones may reach; these rows are owner-only by omission).
- No new authority over the agent — invariant; basis: irreversible-consequence; evidence: the bearer the agent holds (with the PIN) fails the write gate's device-signature step and the presence key lives in the phone's Secure Enclave, so the agent cannot write a card in the owner's name through this route.

## Multi-machine posture

- **Phone writes: machine-local by design** (physical-credential locality, as for every phone write in
  `docs/specs/mobile-native-permissions.md` §5): the device record and the presence key the write gate
  reads live only on the machine the phone paired with, so a create (and its retry) is proven only
  there; another machine refuses the device. The derived card id therefore makes retries idempotent on
  the one machine that can accept them, with no cross-machine race on the `created` key. (Two separate
  pairings of one phone to two machines of one agent, with the app sending one request to both, is the
  only way to reach two machines with one request id; the app holds one pairing per agent, so this is
  out of reach, and the fold is not changed for it.)
- **Cards: replicated** through the work board's existing journal (unchanged): a card made on the
  paired machine reaches every machine like any other card.
- **Challenges: machine-local by design** (in-memory, single-use, bound to the Host), exactly as for
  taps today: the phone asks the challenge and sends the create to the same machine.
- **Source check: reads the pool's replicated views, not a machine-local list.** App conversations
  are read from the app conversation store, which is replicated to every machine
  (`AppConversationsReplicatedStore`), so an app conversation made on any machine is known on all of
  them. Telegram topics use `telegramTopicKnown`, the one rule every phone write path into a Telegram
  topic already uses (named here, bound to a session here, or holding history in this machine's
  replicated message log). Using a different rule for cards than for sending into the same
  conversation would let a phone make a card from a conversation it cannot send to (or the reverse).
  If that shared rule refuses, the answer is `404 source-conversation-not-found` and nothing is
  written; widening the rule is a change to that shared rule, for every write path at once.
- **Audit: machine-local** like every other phone permission write.

## Maturation plan

- **test-agent-live:** a throwaway agent with an owner phone paired by the app builders' test rig: the phone opens one card, makes a card from a Telegram message and from an app message with Face ID, retries after a dropped answer and gets the same card, and is refused for an unknown conversation and an over-limit card before Face ID. The server half is proven by the signed-request integration tests and the E2E test in this change.
- **dev-agent-live:** Echo, once the iPhone "Make a card" sheet ships: the owner makes cards from real messages for one week.
- **fleet:** rides the two existing switches (`workBoard.enabled`, `mobilePairing.permissionActions.enabled`); no new switch, so the fleet sees it exactly when both are on.
- **graduation criterion:** over the dev week, from the permission audit and the board: every phone create that answered 201 is on the board with its `source`; no duplicate card for one request id; no `request-id-reused` from a genuine retry; zero operator-found defects on the sheet.
- **dark-window:** none beyond the two existing switches' own windows.
- **ladder:** workBoard.asks

## Frontloaded Decisions

1. **Owner phones only for both routes.** The brief names owner-phone routes; members keep the board
   read they have. *cheap-to-change-after:* opening the single read to members later is one allowlist
   tier line; the handler already applies the per-card conversation check.
2. **Face ID for every create, including a retry.** A retry after a lost answer asks Face ID again;
   the replay answer is given only after the proof. Not adding a proof-free replay keeps the write
   gate exactly as strong as for taps.
3. **The request id is the client's**, bound to the owner by the derived card id. Lowercase only, so
   it fits the signed line's target alphabet.
4. **Draft hash v1** fields are exactly `title`, `need`, `doneWhen`, `source` (everything the card
   stores from the request; `outward` and carrier are fixed).
5. **Source refusals are 404**, never 403, matching the work board's "a card you may not read does
   not exist for you".
6. **No new feature switch.** The read is gated by the work board switch (`workBoard.enabled`) and
   phone pairing, as the board read is. The create is gated by the work board switch and phone
   permission actions (`mobilePairing.permissionActions.enabled`, dev-live / fleet-dark), as card taps
   are. All are read live.
7. **Face ID, not the device signature alone, for a create.** The console asks the PIN for the same
   write, and a card can start agent work once approved; making one is a person's write, so it takes the
   person's proof (the write gate), never a device key that the phone holds without the owner present.

## Rollback

Revert the PR. Cards made from a phone stay as ordinary owner-written cards (`by.proof: 'presence'`,
a value the store already accepts from phone taps) and keep reading and working on the old code. No
migration, no config change, no state repair.

## Testing

All three tiers (Testing Integrity Standard):

- Unit: draft validation and projection (extra fields and `certify` dropped); hash with fixed test
  vectors; derived card id; action line build for `work-card-create` (good and bad target/hash);
  `createCard` with a named id for an owner person and refusal for a non-owner person; the dry run
  refuses what the write refuses and writes nothing; the pre-checks in order (board, owner, replay
  skips the source check, source, dry run); replay, `request-id-reused`, `card-removed`.
- Integration, through the production `authMiddleware`, device authenticator and allowlist, real
  device and presence signatures (`tests/helpers/mobileDevice.ts`): owner reads one card, member phone
  refused, scoped session refused, invisible card 404; owner creates a card from a Telegram and an app
  message with `source` stored exactly; another device refused 403; missing, forged and wrong-draft
  presence refused 401; bearer refused; unknown source 404 before any challenge is consumed; preflight
  answers the line and writes nothing; replay returns the same card with `replayed: true` and writes
  nothing; a reused request id with a different draft 409. The team-access status table
  (`tests/integration/team-access-status-table.test.ts`) gets a sample path for the new GET rule.
- E2E (feature is alive), on the real `AgentServer` with a real `WorkBoardRuntime` and
  `mobilePairing.permissionActions` on in the fixture: the phone read answers 200 with the card (not
  503/404) and the phone create is mounted and wired (a bearer is refused with
  `403 device-signature-required`, not 503 `work-board-disabled`).
- Live proof: these are server routes with no user surface of their own yet. The Live-User-Channel
  proof (the owner making a card from a message on the real phone, then opening it) is part of the
  app builders' done for the button and sheet, on a throwaway agent, before the owner is asked to try
  it. A wiring test asserts `routes.ts` passes a real `workCardCreate` to the phone
  routes.

## Agent awareness and release note

- `src/data/awareness/phone-work-cards.md`: the owner's phone can open one card and make a card from a
  message with Face ID; such a card is the owner's own (`by.proof: 'presence'`) and carries `source`.
- The work board's CapabilityIndex endpoint list gains the two routes.
- `upgrades/next/phone-work-cards.md`.

## Coordination

- PR #3364 (another session) edits `listBoard` in `workBoardRoutes.ts`; this change touches the
  single-card handler and adds a helper below it: no overlapping lines.
- PR #3353 adds a member to the same `PermissionAction` and `PermissionAuditEvent` unions in
  `mobilePermissionsRoutes.ts`; whichever lands second rebases (a one-line union merge, no meaning
  conflict).
- The phone-app half (the button, the sheet and the card screen on iPhone, Android and Mac) belongs to
  the app builders under stage 2b (CMT-1841); the route shapes above are their contract and are handed
  to them with this PR.

## Open questions

*(none)*
