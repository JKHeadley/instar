---
title: "Secret Drop — outstanding requests survive restart, and status says what actually happened"
status: draft
author: Echo (feedback factory)
initiative: feedback-19643aa7-9ac1-4da5-8057-add768cd29ee
cluster: cluster-secret-drop-requests-are-lost-when-an-auto-update-restarts-t
severity: critical
---

# Secret Drop — outstanding requests survive restart, and status says what actually happened

## Problem

An outstanding (not yet submitted) Secret Drop request exists only in server
memory. When the server restarts, which happens on every auto-update, every
live link is wiped without anyone being told. After the restart:

1. `GET /secrets/drop/:token` returns **410** with the page "Link Expired or
   Already Used", even though the link had not expired and had not been used.
2. `GET /secrets/pending` no longer lists the request.
3. Nothing tells the requester (agent or Telegram topic) or the user that the
   link died.
4. Neither the page nor the API can tell "submitted" apart from "expired",
   "cancelled" or "lost at restart". A watcher that reads "gone from pending"
   as "submitted" therefore reports a false success.

`docs/specs/secret-drop-store-first.md` already made **submitted values**
survive restarts by persisting them to the encrypted `SecretStore`. It did not
cover the **request** side: the link itself is still memory-only. That spec's
trigger section even records this exact failure ("a 1-hour-TTL drop link's
token evaporated live in a server auto-update restart"). The fix it shipped
did not close it.

## Evidence

Reporter text, scrubbed and summarised (`.feedback-evidence.json`, 1 report,
received 2026-11-04):

- On a laptop agent, an auto-update to v1.3.1644 restarted the server between
  7:34:51 and 7:35:04 pm PST on 3 Nov 2026.
- A live link that had been sent to a user, with 53 minutes left, was erased.
- The link then returned 410 "expired or already used", and `/secrets/pending`
  was empty.
- A watcher read that as a submission, and the agent told the user their link
  had been used.
- The reporter asks that requests survive restart, that an update never voids
  a link silently, and that the page and pending list distinguish submitted,
  expired and lost-at-restart.

Where this comes from in the code:

| Location | Behaviour |
|---|---|
| `src/server/SecretDrop.ts:12` | Header says it outright: "In-memory only: pending requests and secrets never touch disk". |
| `src/server/SecretDrop.ts:209` | `private pending = new Map<string, SecretRequest>()` is the only record of an outstanding request. |
| `src/server/SecretDrop.ts:285-293` | `getPending` returns `null` for both "never existed / lost" and "expired" (and deletes expired entries). Callers can't tell them apart. |
| `src/server/SecretDrop.ts:352` | A successful submit just `pending.delete(token)`s. It leaves no record that the token was *submitted*. |
| `src/server/SecretDrop.ts:536-550` | `cancel` and `cleanup` also just delete. No terminal state is kept. |
| `src/server/SecretDrop.ts:871-881` | `shutdown()` clears `pending`. Process exit drops it in any case. |
| `src/server/SecretDrop.ts:825-866` | `renderExpiredPage` has one fixed message, "Link Expired or Already Used", whatever the cause. |
| `src/server/routes.ts:28629-28636` | `GET /secrets/drop/:token` sends 410 plus that page whenever `getPending` is null. |
| `src/server/routes.ts:28704-28707` | `POST /secrets/drop/:token` sends 410 "expired or already used" whenever `submit` is null. That also covers a CSRF mismatch, a missing field and a failed R1a signature, which are *not* expired or used. |
| `src/server/routes.ts:28889-28897` | `GET /secrets/pending` lists only live in-memory entries. Nothing records why an entry left the list. |

Reproduction (from triage): create a one-hour request, leave it unsubmitted,
restart the server, then open the link and check `/secrets/pending` and the
requester notifications. You get a 410, an empty pending list and no
notification.

## Goals

- G1. An unexpired, unsubmitted, uncancelled request still works after a
  server restart: same URL, same form, same expiry, and it can still be
  submitted.
- G2. Every request ends in exactly one explicit terminal state, kept for a
  bounded time: `submitted`, `expired`, `cancelled` or `invalidated` (with a
  reason, e.g. `lost-at-restart`, `persist-failed`, `restore-failed`).
- G3. The user-facing page and the agent-facing API both report that state.
  Leaving the pending list never implies submission.
- G4. If a request is lost anyway (persistence disabled or failed, state
  corrupted), the requester's topic is told, so nobody is left waiting on a
  dead link.

## Non-goals

- Moving requests between machines. A link belongs to the machine whose
  server issued it, as it does today.
- Changing how submitted values are persisted or retrieved. That stays as
  `secret-drop-store-first.md` and `secret-drop-sliding-window.md` define it.
- Changing TTL defaults, `MAX_PENDING`, CSRF, R1a sender verification or R2
  trust gating.

## Proposed fix

### 1. Persist outstanding requests (encrypted, no secret values)

At `create()`, write the request's serialisable fields to the existing
AES-256-GCM `SecretStore` under `secretDropRequests.<token>`:
`token, csrfToken, label, description, fields, topicId, createdAt, expiresAt,
agentName, browserHost, senderVerification`. These records hold no user
secret, but the token and CSRF value are capabilities, so they belong in the
encrypted store rather than a plain JSON file. This matches how
`secretDrops.<token>` is already stored.

- `onReceive` is a function and can't be persisted. A grep of `src/` finds no
  caller that passes it today. A restored request has no `onReceive`, and the
  spec makes that explicit in the type docs. The route-level Telegram and
  session notification on submit already covers the requester.
- Removal from the store happens on every terminal transition (submit,
  cancel, expiry cleanup).
- Opt-out: `config.secrets.persistDropRequests: false`. The default is on,
  following `persistDrops`. When off, behaviour falls back to memory-only,
  but section 3 still applies.
- Persistence is injected (a small `SecretDropPersistence` interface passed to
  the `SecretDrop` constructor), so `SecretDrop` stays unit-testable without
  touching the keychain. The test-environment `SecretStore` guard from
  `secret-drop-store-first.md` still applies.
- Failure policy: if the persist write fails at `create()`, the request is
  still created (the user has to get their link), but it is marked
  `durable: false`. The `/secrets/request` response carries
  `durable: false` plus a warning, and the server logs an ERROR, so the agent
  knows this link won't survive an update.

### 2. Restore on boot

When the `SecretDrop` instance is built in `routes.ts`, load every
`secretDropRequests.*` record:

- `expiresAt` in the future → put back into `pending`, keeping the original
  `expiresAt`. Downtime does not extend a link's life, and a restart does not
  shorten it.
- `expiresAt` in the past → write an `expired` tombstone (section 3) and
  delete the record.
- A malformed record → write an `invalidated / restore-failed` tombstone,
  delete the record, notify the topic (section 4) and log an ERROR.

`shutdown()` must keep clearing in-memory maps but must **not** delete
persisted request records. Only terminal transitions delete them.

### 3. Explicit terminal states (tombstones)

Add a small non-secret ledger, `stateDir/secret-drop-ledger.json`, keyed by
`sha256(token)` (the raw token is never written there):

```jsonc
{
  "<sha256(token)>": {
    "state": "pending" | "submitted" | "expired" | "cancelled" | "invalidated",
    "reason": "lost-at-restart" | "persist-failed" | "restore-failed" | null,
    "label": "…",            // already shown to the user on the form
    "topicId": 123 | null,
    "createdAt": 0, "expiresAt": 0, "endedAt": 0 | null
  }
}
```

- The `pending` entry is written at `create()`, even when
  `persistDropRequests` is off. It is hash-only and cheap, and it is what
  makes "lost" detectable at all.
- Each transition updates it: submit → `submitted`, cancel → `cancelled`,
  cleanup or `getPending` past expiry → `expired`.
- **Lost-at-restart detection:** on boot, any ledger entry still `pending`
  with no restored request (and not yet expired) becomes
  `invalidated / lost-at-restart`. Section 4 then notifies.
- Terminal entries are pruned 24 hours after `endedAt`. The ledger has a hard
  cap of 500 entries, oldest terminal first.
- Writes are atomic (temp file + rename), the same as other state files.

### 4. Tell the requester when a link dies without a submission

When a request ends as `invalidated`, the server sends one Telegram message
to its `topicId` (if set) and injects a system message into the bound
session using the same inject-or-spawn path as `[secret-drop-received]`:

> `[secret-drop-invalidated]` The Secret Drop link for "<label>" stopped
> working (<reason>) before anything was submitted. Nothing was received. Ask
> the user again with a new link if you still need it.

Expiry with no submission gets a quieter `[secret-drop-expired]` session
notice (no Telegram push), so a watcher hears "expired", not silence. These
messages never include the token or the URL.

### 5. Status surfaces

- **`SecretDrop.status(token)`** returns
  `{ state, reason?, label, expiresAt, endedAt? } | { state: 'unknown' }`.
  It reads live `pending` first, then the ledger.
- **`GET /secrets/status/:token`** (agent-facing, bearer auth, same as
  `/secrets/pending`) returns that object. This is the endpoint watchers
  should poll.
- **`GET /secrets/pending?include=recent`** adds a `recent` array of terminal
  ledger entries, each with `{ tokenHash, state, reason, label, endedAt }`.
  The default response shape stays the same for existing callers, and each
  live entry gains `durable: boolean`.
- **`GET /secrets/drop/:token`** keeps returning 410 for every non-pending
  state (link scanners and old clients rely on that), but the page text now
  depends on the state:
  - `submitted`: "This link was already used. <agent> received it."
  - `expired`: "This link expired at <time>. Ask <agent> for a new one."
  - `cancelled`: "<agent> cancelled this request."
  - `invalidated`: "This link stopped working because <agent>'s server
    restarted / hit an error. Nothing was received. Ask for a new one."
  - `unknown`: the existing generic text.
  Labels are HTML-escaped as they are today. A `X-Secret-Drop-State` header
  carries the state for scripts.
- **`POST /secrets/drop/:token`** keeps 410 for non-pending states, with a
  body of `{ error, state }`. A CSRF mismatch, a missing field or a failed
  R1a signature on a *live* request returns **400**
  `{ error: 'Submission rejected', state: 'pending' }` instead of the
  misleading "expired or already used". The request stays live, as it does
  today.

### 6. Fix the guidance that produced the false "used" report

Update the Secret Drop instructions emitted by `src/scaffold/templates.ts`
and the matching block in `src/core/PostUpdateMigrator.ts`, plus the
capability text in `src/server/CapabilityIndex.ts`, to say: "To find out
whether a request was submitted, call `GET /secrets/status/:token`. Absence
from `/secrets/pending` does **not** mean it was submitted." The existing
`secret-drop-retrieve.mjs` helper gains a `--status` mode that prints the
state only.

## Security considerations

- Persisted request records hold capabilities (the token and CSRF value) but
  no user secrets. They sit in the same encrypted store that already holds
  submitted values, so this adds no new exposure class.
- The plaintext ledger holds only `sha256(token)`, the label (already shown
  to anyone with the link) and timestamps. It can't be used to rebuild a URL.
- A restored request keeps its original `expiresAt`, so a restart can't be
  used to stretch a link's life.
- The state-specific 410 page shows only to someone who already has the
  token, and gives them only the label they could already see.
- `senderVerification.senderPubKeyHex` is a public key, so persisting it is
  fine. R2 gating is re-evaluated on every POST, so restore can't bypass it.

## Test plan

Unit (`tests/unit/SecretDrop.test.ts`, fake timers, in-memory persistence
fake):

1. A created request is written to persistence. A new `SecretDrop` built over
   the same persistence restores it, with the same `expiresAt`, the same
   rendered form, and a working `submit()` using the original CSRF.
   *(This is the core failing-then-passing regression: "an unsubmitted
   request survives a restart and can still be submitted".)*
2. A record that expired during downtime is not restored, and
   `status()` returns `expired`.
3. Ledger has `pending` but there is no persisted record (memory-only mode or
   persist failure) → after restart, `status()` is
   `invalidated / lost-at-restart` and the invalidation listener fires once.
4. `submit`, `cancel` and expiry each delete the persisted record and leave
   the right tombstone. `shutdown()` doesn't delete persisted records.
5. `status()` returns four different states for submitted, expired,
   cancelled and invalidated, and `unknown` for a random token.
6. Tombstones are pruned after 24 hours, and the 500-entry cap holds.
7. A persist failure at create still returns a token with `durable: false`.

Integration (routes, with a temp `stateDir` and the keychain guard):

8. Create, rebuild the router (simulated restart), then `GET
   /secrets/drop/:token` returns 200 and the form, and the request is still
   in `/secrets/pending`.
9. Once each terminal state is reached, `GET /secrets/drop/:token` returns 410
   with the state-specific text and header, and `/secrets/status/:token`
   matches.
10. A CSRF mismatch on a live request returns 400 with `state: 'pending'`,
    and the request stays usable.
11. A lost-at-restart request sends exactly one `[secret-drop-invalidated]`
    message to its topic, with no token or URL in it.

## Rollout

- Ships default-on. No migration is needed: links issued before the upgrade
  are memory-only, so the restart that installs this release still loses
  them. They have no ledger entry yet, so they show as `unknown`. The release
  notes say so. Every link issued after it survives later restarts.
- Rollback is safe. Older servers ignore `secretDropRequests.*` and the
  ledger file.

## Open questions

- Should the server **defer an auto-update restart** while durable-false
  requests are outstanding, as a fallback for when persistence is
  unavailable? This spec leaves that out and relies on the invalidation
  notice. It is worth considering if `persist-failed` turns out to be common.
- Is 24 hours the right tombstone retention, or should it match the longest
  allowed TTL?
