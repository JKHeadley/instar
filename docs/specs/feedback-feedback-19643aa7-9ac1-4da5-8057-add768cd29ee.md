---
title: "Secret Drop requests survive restart, with an explicit end state"
slug: "feedback-feedback-19643aa7-9ac1-4da5-8057-add768cd29ee"
author: "echo"
parent-spec: "docs/specs/SECRET-DROP-HARDENING-SPEC.md"
related-specs:
  - "docs/specs/secret-drop-store-first.md"
  - "docs/specs/secret-drop-sliding-window.md"
---

# Secret Drop requests survive restart, with an explicit end state

## Problem statement

An unsubmitted Secret Drop request exists only in the server process's memory
(`SecretDrop.pending`, `src/server/SecretDrop.ts:209`). The class header states this
on purpose: "In-memory only: pending requests and secrets never touch disk". Any
server restart, including the automatic restart an update triggers, wipes every
outstanding request. After that:

1. `GET /secrets/drop/:token` finds no request and returns **410** with the generic
   "expired or already used" page (`src/server/routes.ts`, the `getPending` → `renderExpiredPage` branch).
2. `POST /secrets/drop/:token` returns 410 `"This link has expired or already been used"`.
3. `GET /secrets/pending` no longer lists the token.
4. No route lets a caller tell "submitted" apart from "expired", "cancelled" or
   "lost". A request that is gone from `/secrets/pending` looks the same however it
   ended, so a polling consumer can easily read "gone" as "submitted".

Submissions already survive restart. Since the store-first change, the submitted
values go to the encrypted `SecretStore` under `secretDrops.<token>`, and
`/secrets/retrieve` falls back to that copy. The **request** itself, the link the
user has not used yet, has no durable form.

### Evidence

One report (2026-11-04, laptop agent). An automatic update to v1.3.1644 restarted the
server between 19:34:51 and 19:35:04 PST on 2026-11-03. The restart erased a live link
that had been sent to a user and still had 53 minutes left. The link then returned
410, and `/secrets/pending` was empty. A watcher read the empty list as a submission,
and the user was told the link had been used. Nothing told the requester or the user
that the link had actually died.

The code matches the report. `SecretDrop` has no load or save path, the constructor
takes only `agentName`, and `onReceive` callbacks (which cannot be serialised) have
no callers outside the class. Nothing structural forces requests to stay in memory.

### Reproduction

1. `POST /secrets/request` with `ttlMs: 3600000`.
2. Leave it unsubmitted and restart the server.
3. `GET /secrets/drop/<token>` returns 410. `GET /secrets/pending` returns `[]`. The
   request cannot be told apart from a submitted one.

## Goals

- An outstanding, unexpired request survives a server restart. After the restart the
  same URL serves the same form, and a form loaded before the restart still submits
  afterwards (the CSRF token is the same).
- Every request ends in exactly one explicit, queryable state: `pending`,
  `submitted`, `expired`, `cancelled`, `invalidated` or `unknown`.
- **A link that was submitted, cancelled or consumed can never become usable again**,
  whatever point a crash or restart interrupts.
- The user-facing page says which end state applies.

## Non-goals

- **No new outbound calls.** This change adds no Telegram messages, no session
  injections and no spawns. That includes expiry, invalidation and startup recovery.
  The only notifications are the existing receipt confirmation and the existing
  session message on a successful submission, and they stay as they are. Telling a
  requester when a link dies is left to a separate design, because it would add
  outbound messages.
- No change to the wording of existing injected messages, the scaffold template, the
  `PostUpdateMigrator` guidance text, or helper scripts.
- No change to TTL defaults, `MAX_PENDING`, the sliding retrieval window, R1a sender
  verification or the R2 trust gate.
- Cross-machine handoff of pending requests is out of scope. The ledger lives in the
  machine-local `stateDir`.

## Proposed design

### 1. The request ledger

A new encrypted file, `<stateDir>/secrets/secret-drop-ledger.enc`, holds one JSON
document:

```
{ version: 1, records: { [token]: LedgerRecord } }
```

It is read and written through the existing `SecretStore` class with
`storeFile: 'secrets/secret-drop-ledger.enc'`. That means the same master key, the
same v2 format and the same atomic temp-file + `rename` write. The file is separate
from `config.secrets.enc`, so Secret Drop traffic never rewrites the main vault.
Today the store-first copy does a read-modify-write on the main vault on every
submission.

`LedgerRecord`:

| field | notes |
|---|---|
| `state` | `pending` \| `submitted` \| `cancelled` \| `expired` \| `invalidated` |
| `csrfToken`, `label`, `description`, `fields`, `topicId`, `browserHost`, `senderPubKeyHex` | everything needed to rebuild the `SecretRequest`, minus `onReceive` |
| `createdAt`, `expiresAt` | unchanged meaning |
| `stateChangedAt` | ms since epoch |
| `reason` | for `invalidated` only: `unreadable-record` |
| `values` | only while `state === 'submitted'`, only when the value may be persisted (`persistDrops !== false` and no `browserHost`), and removed once the value is consumed or purged |
| `receivedAt` | for `submitted` |

`unknown` is never stored. It is the answer for a token that has no record.

Expiry needs no stored transition. A record whose `expiresAt` has passed is reported
as `expired` and is never usable, whatever its stored state says. Because expiry
depends only on the clock, a crash cannot leave an expired link usable. A periodic
sweep writes `expired` later, purely as housekeeping.

### 2. Commit before memory, memory before side effects

Every state change follows the same fixed order:

1. Take the ledger lock (section 3) and re-read the ledger from disk.
2. **Compare-and-set.** Apply the change only if the record's current on-disk state is
   the expected source state, for example `pending` for a submit. Otherwise abort
   with that state.
3. Write the whole document with one atomic `rename`. This is the commit point.
4. Release the lock, then update the in-memory maps.
5. Only then respond to the HTTP caller and run the existing side effects.

If the write fails, nothing is acknowledged and memory is left alone. The caller gets
**503** `{ error, reason: 'not-saved' }`.

Here is what each change does, and what a crash at each point leaves behind:

**Create** (`pending` is new). Commit the record before returning the token. If the
commit fails, create fails with 503 and no link is issued. A link that exists only in
memory, and would silently die at the next restart, is never minted.
*Crash before the rename:* no link was ever returned. *Crash after the rename:* a
pending link survives, which is the intended result.

**Submit** (`pending` → `submitted`). CSRF, required fields, R1a signature and the R2
trust gate are all checked first, as today, without touching any state. Then a single
commit sets `state = submitted` and `receivedAt`, and stores `values` when they may be
persisted. **The state change and the stored value land in the same rename.** No
interleaving can leave a link pending on disk while its value was accepted, or the
other way round.
- *Crash before the rename:* the disk still says `pending`, and the user never got a
  200. After the restart the link is still usable, which is correct because nothing
  was accepted.
- *Crash after the rename, before the response:* the disk says `submitted`. After the
  restart the page shows "already submitted", a second POST is refused, and the value
  can be retrieved.
- *Commit fails:* 503. The request stays pending and the user can submit again.

  This replaces today's "best-effort, loud" persistence of the submitted value. That
  approach acknowledged a submission whose durable record might be missing, which
  could let the link come back as pending after a restart.

**Cancel** (`pending` → `cancelled`). Commit first, then remove from memory, then
answer 200. If the commit fails, the cancel answers 503 and the request stays
pending. The route does not claim a cancellation that was not saved.
*Crash after the rename:* the link stays cancelled after the restart.

**Consume** (`retrieve?consume=true`, `submitted` with values → `submitted` without
values). Read the values, commit their removal, then return them. *Crash after the
rename:* the value is gone, which is what consume asked for. The record stays
`submitted` and never goes back to pending. *Crash before the rename:* the value is
still there and the consume can be retried.

**Purge** (the received idle or absolute cap fires). Commit the removal of `values`.
The state stays `submitted`, with `valueRetained: false`.

No change ever moves a record **into** `pending` except create. At the compare-and-set
level, `submitted`, `cancelled`, `expired` and `invalidated` are terminal. That is the
property the test plan checks at every crash point.

### 3. Overlapping processes during a restart

An update restart can briefly leave the old and the new server running on the same
`stateDir`. All ledger read-modify-writes take an exclusive lockfile,
`secret-drop-ledger.lock`, created with `O_EXCL`. A lock is treated as stale if its
recorded pid is no longer alive, or if it is older than 10 s. Because every change
re-reads the disk and compares-and-sets under the lock, the disk is the authority:

- If process A records the submission, process B's later submit of the same token
  aborts with `submitted`.
- If B's in-memory map still holds the request, B may serve the form, but the POST
  is refused by the compare-and-set.

### 4. Startup recovery

When `SecretDrop` is built with a `stateDir`, it loads the ledger:

- `pending` and unexpired: rebuild the `SecretRequest` in `pending` with the original
  `csrfToken` and `expiresAt`.
- `pending` and expired: treated as `expired`, and written as `expired` on the first
  sweep.
- `submitted` with `values` and `receivedAt` still inside `RECEIVED_ABSOLUTE_MAX_MS`:
  rebuild the in-memory `received` entry. The absolute deadline is computed from the
  stored `receivedAt`, and the idle timer is re-armed to the shorter of the idle
  window and the time left before the absolute deadline.
- `submitted` past the absolute cap: purge `values`.
- A record that fails shape validation becomes `invalidated` with
  `reason: 'unreadable-record'` and is never usable.
- **Unreadable ledger** (decrypt or parse failure): load nothing and fail closed.
  Every token answers `unknown`, so no link becomes usable. The unreadable file is
  renamed to `secret-drop-ledger.enc.unreadable-<ts>` and kept, not overwritten. A
  fresh ledger starts. The failure is logged locally with `console.error`, and
  `GET /secrets/pending` carries `ledger: 'recovered-from-unreadable'` until the next
  restart. No outbound notification is sent.
- Reconciliation with the legacy store: a `secretDrops.<token>` copy in
  `config.secrets.enc` is deleted when the ledger record for that token is
  consumed or purged (section 6).

Startup recovery makes no network calls and sends no messages.

### 5. Explicit status on every surface

- **`GET /secrets/drop/:token`** (no auth): `pending` serves the form, as today.
  Every other state still returns **410** for compatibility, with a page that says
  which state applies:
  - submitted: "This link was already used."
  - expired: "This link expired."
  - cancelled: "This request was cancelled."
  - invalidated or unknown: "This link no longer works."

  The single `renderExpiredPage()` becomes `renderClosedPage(state)`. Its markup and
  escaping are unchanged.
- **`POST /secrets/drop/:token`**: the 410 body gains `state`. A request that is
  still pending but fails validation (CSRF, an empty field, a bad R1a signature)
  answers **400** `{ state: 'pending', error: 'invalid-submission' }` instead of 410,
  so a rejected attempt is not mistaken for a closed link. The request is not
  consumed, as today. A commit failure answers 503 (section 2).
- **New `GET /secrets/status/:token`** (bearer auth, same middleware as
  `/secrets/pending`): returns `{ state, createdAt, expiresAt, stateChangedAt,
  valueRetained? }`. It never returns values or the CSRF token. The route catalog
  entry in `CapabilityIndex` gains one descriptive line in its existing format.
- **`GET /secrets/pending`**: the default response shape is unchanged. Adding
  `?include=recent` also returns `recent: [{ token, label, state, stateChangedAt }]`
  for terminal records still held. The mobile `listPending()` view is unchanged, so
  no new token leaves that route.

### 6. Retention, limits, compatibility

- Terminal records, which hold no values, are kept for 24 h. At most 200 are kept,
  oldest pruned first. After that the token answers `unknown`, which is still never
  usable.
- `MAX_PENDING` (20) is unchanged. It counts only `pending` records.
- **Compatibility copy, one release.** After the ledger commit on submit, the existing
  `secretDrops.<token>` write to `config.secrets.enc` keeps running, still
  best-effort. This lets a downgrade to a version without the ledger still retrieve an
  unconsumed submission. The copy holds only values and never affects whether a link
  can be used, so it adds no replay risk. `/secrets/retrieve` reads memory first, then
  the ledger, then the legacy copy. Consume and purge delete the ledger value first
  and the legacy copy second. A crash between those two deletes is cleaned up at
  startup (section 4).
- Config `secrets.persistDropRequests` (default `true`). Setting it to `false`
  restores today's memory-only behaviour exactly, for rollback.
- The `SecretDrop` header's security-properties list is corrected. Request metadata
  and tokens are now stored on disk, encrypted with the vault master key in a 0600
  file. Secret values are still stored only under the existing `persistDrops` rules.
- The one-time cost: requests that are open while the server upgrades from a
  pre-ledger version are lost that one last time, because the old process never wrote
  them down.

### Security considerations

- Tokens and CSRF tokens are stored encrypted with the same master key that already
  protects the submitted values. Anyone who can decrypt the ledger can already decrypt
  the vault, so this adds no new class of exposure.
- No route is added that does not require auth. The new status route needs the bearer
  token and returns no secret material.
- Failure paths fail closed. An unreadable ledger, a failed commit or a lost lock race
  never leaves a usable link and never acknowledges a submission that was not saved.

## Test plan

Unit tests go in `tests/unit/SecretDrop-durable.test.ts`. `SecretDrop` gets an
optional ledger I/O seam, so a test can inject a write that throws before the rename,
or a hook that throws after the rename but before the in-memory update. A "restart"
is simulated by building a second `SecretDrop` on the same temporary `stateDir`.

1. **The headline test: a pending request survives a restart.** Create with a 1 h TTL
   and rebuild. `getPending` returns the same `csrfToken` and `expiresAt`, and
   `submit` with the original CSRF succeeds. This fails on current code.
2. Expiry across a restart (fake timers): after the rebuild past `expiresAt`, the
   status is `expired`, the form route answers 410 with the expired page, and submit
   is refused.
3. Submit fails before the rename: 503-equivalent result `not-saved`. After the
   rebuild the request is still `pending` and a resubmit succeeds.
4. **Submit interrupted after the rename:** after the rebuild the status is
   `submitted`, `getPending` is null, a second submit is refused, and the value can be
   retrieved.
5. Cancel interrupted before the rename: the cancel reports failure and the request
   stays pending. **Cancel interrupted after the rename:** after the rebuild the status
   is `cancelled` and the link is never usable.
6. **Consume interrupted after the rename:** after the rebuild the value is gone, the
   state is `submitted` with `valueRetained: false`, and the link is not pending.
7. Two instances on one `stateDir`: A submits, and B's submit of the same token is
   refused by the compare-and-set, even though B's memory still holds the request.
8. Unreadable ledger at startup: no token is usable, the status is `unknown`, the
   original file is kept as `.unreadable-<ts>`, and a new create works.
9. A `browserHost` request and `persistDrops: false`: the decrypted ledger record has
   no `values` field at any point.
10. A received submission whose `receivedAt` is older than 30 min when the ledger
    loads is purged at startup.
11. Legacy fallback: a value stored only under `secretDrops.<token>` in
    `config.secrets.enc` can still be retrieved, and consume deletes it.
12. Pending, submitted, expired and cancelled answer four different
    `GET /secrets/status/:token` results.
13. `persistDropRequests: false`: no ledger file is created, and behaviour matches
    today.
14. No outbound calls: startup recovery, expiry and cancel never call the Telegram
    adapter or the session manager (spies are asserted not to have been called).

Integration test (`tests/integration/secret-drop-restart.test.ts`): boot the router,
create a request, rebuild the router on the same `stateDir`, then check that
`GET /secrets/drop/:token` returns 200 with the form and `/secrets/pending` still
lists the token. After submitting, `/secrets/status/:token` reports `submitted`.

## Rollout

Ship with `persistDropRequests` on by default. Rollback means setting the flag to
`false`, or downgrading. The one-release compatibility copy means a downgrade does not
lose submissions that were already accepted. Requests that are still pending at the
moment of a downgrade are lost, which is today's behaviour.
