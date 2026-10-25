---
title: A2A honest delivery outcomes — the sender hears what the relay already knows
date: 2026-10-06
author: echo
parent-spec: A2A-DURABLE-DELIVERY-SPEC.md
parent-principle: "Close the Loop"
parent-principle-fit: "Every relay send already gets a delivered / queued / rejected / expired verdict from the relay; the sender discards all of them, so a send can only ever end as 'sent, unconfirmed'. Consuming the verdicts closes the loop the durable-delivery tracker opened."
eli16-overview: a2a-honest-delivery-outcomes.eli16.md
approved: true
approved-by: Justin
approved-via: "Telegram topic 122413, 2026-10-06 18:57 PDT: \"Yes, I approve. Please don't let me be the bottleneck here.\" (verified operator)"
review-convergence: "2026-10-07T01:39:21.974Z"
review-iterations: 8
review-completed-at: "2026-10-07T01:39:21.974Z"
review-report: "docs/specs/reports/a2a-honest-delivery-outcomes-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Spec — A2A honest delivery outcomes

## Problem

On 2026-10-06 two messages from Echo to Luna (sagemind) both returned
`{"accepted":false,"delivered":false,"deliveryOutcome":"submitted to relay; acceptance unconfirmed"}`.
Luna was off the relay for 40 hours (her laptop displaced, her Studio a standby).
Nothing on Echo's side ever turned either send into "not delivered". The only
evidence anything was wrong was a human asking "has Luna responded yet?".

The relay already reports what happened to every message
(`src/threadline/relay/RelayServer.ts`), always to the socket of the identity that
sent it (`connections.getSocket(envelope.from)`):

- immediate `ack status:'delivered'` — written to the recipient's live socket
  (not proof the recipient read it).
- immediate `ack status:'queued', ttl` (seconds) — recipient offline; held in the
  relay's IN-MEMORY offline queue (default 24 h; lost on relay restart).
- immediate `ack status:'rejected', reason` — routing refused, or queue full.
- later `ack status:'delivered'` — a queued message flushed on the recipient's
  reconnect; sent only if the sender identity has a live socket at that moment.
- later `delivery_expired { messageId, recipientId }` — a queued message's TTL
  elapsed; same live-socket condition.
- a sender ban arrives as a `type:'error'` frame with no `messageId`.

The client discards all of it: `RelayClient` re-emits `'ack'` but `ThreadlineClient`
never subscribes, and `RelayClient` has no `delivery_expired` case. The
`A2ADeliveryTracker` only learns of delivery from a peer *reply* (Layer A of the
parent spec), and `markFailed` has no caller.

**Why sender-side, and why now.** A durable relay queue (broker semantics) would
remove the "verdict lost on relay restart" case, but the relay is a separate
hosted service and a sender that does not LISTEN cannot report anything even
from a perfect broker. Listening is required either way; relay durability is a
separate relay-side change (non-goal).

## What already exists (do NOT rebuild)

- `A2ADeliveryTracker` (SQLite; `recordSent`, `recordAckByThread`, `markFailed`,
  `peerHealth`) — parent spec §1. "Honest" throughout this spec means: the
  reported value is either a verdict the relay actually sent for that id, or an
  explicit `unknown` — never an inference from silence. Note: `markFailed` fails rows in `awaiting-ack`
  OR `escalated`.
- `/threadline/relay-send` records every relay send with `recordSent` keyed on the
  envelope `messageId` (the id the relay's frames carry), with `transport='relay'`.
- `GET /threadline/peers/health[/:fp]` — parent spec §5.
- `A2ARedeliverySentinel` — parent spec §4; ships disabled; out of scope.

## What this adds

### 1. Client: a verdict dispatcher on the stable object

All of this lives on `ThreadlineClient` (long-lived; it rebuilds its inner
`RelayClient` on every `connect()` and re-forwards events, so subscribers attach
once).

- `RelayClient`: new frame case `delivery_expired` → `emit('delivery-expired', { messageId, recipientId })`.
- `ThreadlineClient` subscribes once per inner client to `'ack'` and
  `'delivery-expired'` and runs ONE dispatcher:
  - a **recent-verdict cache** `Map<messageId, Verdict>` (TTL 60 s, cap 2 000
    entries, oldest evicted) — closes the race where the relay answers before
    anyone is waiting;
  - a **waiter map** `Map<messageId, { resolve, timer }>` (cap 1 000; over cap a
    new wait resolves `null` immediately rather than queueing);
  - re-emits `'relay-verdict'` `{ messageId, status, reasonCode?, reason?, ttlSec?, recipientId? }`.
- `awaitRelayAck(messageId, timeoutMs): Promise<Verdict | null>` checks the cache
  first, then registers a waiter. On `disconnected` / `displaced` every pending
  waiter resolves `null` at once.
- **Untrusted text.** The relay's `reason` is mapped to a fixed code by prefix
  (the relay's actual strings, `RelayServer.ts` / `MessageRouter.ts` / `AbuseDetector`):

  | relay text starts with | code | retryable |
  |---|---|---|
  | `Offline queue full` | `queue-full` | yes |
  | `Rate limited` | `rate-limited` | yes |
  | `New agent rate limit` | `rate-limited` | yes |
  | `No pending A2A task` | `routing-refused` | no |
  | `Duplicate message ID` | `routing-refused` | no (only reachable by an id collision) |
  | `Recipient socket not available` / `Failed to send to recipient` | `routing-refused` | no (transient socket race; honest: the relay did not take it) |
  | any other router `reason` | `routing-refused` | no |
  | no prefix matched (`unmappedReason`) | `unmapped` | **unknown** (`relay_retryable` NULL, `retryLater: null`; the next increment treats unknown as "retry after a long delay", never as "never retry" — misclassifying transient as permanent is the costlier error). Prefix mapping is explicitly a BRIDGE until ACT-017. |
  | ban `error` frame (no `messageId`) | `banned` | no |

  The raw string is clamped to 200 chars with control, bidi and zero-width
  characters stripped and is stored in the tracker and audit log ONLY. The route,
  MCP tool and peer-health read return the code (`relayReasonCode`), never the
  text — relay-supplied prose must not reach an agent's context.
- **Ban frame (socket-level, never a per-message verdict).** A relay `error`
  frame with code `BANNED` (text in `message`, no `messageId`; delivered as
  `RelayClient`'s `'error'` event, re-emitted by `ThreadlineClient`, filtered
  on `code === RELAY_ERROR_CODES.BANNED`, whose wire value is lowercase
  `'banned'`) says the SOCKET is banned. The relay runs the ban gate
  on every frame type (including `pong`), bans self-expire, and the relay may
  still process a send already on the wire after the ban lapses — so no
  per-message verdict can be inferred from it.
  - Every LIVE waiter resolves `unconfirmed` with `banSuspected: true`; the
    dispatcher emits one `relay-verdict { status: 'unconfirmed', reasonCode:
    'banned' }` per waiting `messageId`, and the tracker moves those rows to
    `unconfirmed` with `relay_reason_code='banned'` (`relay_status` stays NULL).
    An id-bearing relay verdict arriving later overrides it exactly as for any
    `unconfirmed` row (`delivered`/`queued` → `awaiting-ack`; `rejected`/
    `expired` → `failed`). A send with no live waiter yet reports the same
    `unconfirmed` + `banSuspected` on timeout.
  - `banSuspected` reads a `banActive` label: set by a BANNED frame; cleared on
    the forwarded `'connected'` event (which covers `RelayClient`'s internal
    auto-reconnect as well as `connect()`) or by an ack for a message sent AFTER
    the frame. Send order is a process-local monotonically increasing integer
    `sendSeq` (incremented per `sendAuto`, never reset) kept in a bounded
    `Map<messageId, sendSeq>` (cap 2 000, oldest evicted);
    a BANNED frame records `banSeq = lastSendSeq`; an ack clears only when
    `seq(ack.messageId) > banSeq`; an unknown id never clears (conservative —
    the label is a hint, never fed to the tracker as a verdict). A ban that lifts
    with no later send leaves a stale hint until the next send or reconnect; a
    reconnect while the ban still holds clears it early (auth succeeds before
    the frame gate) and the next send's BANNED frame re-raises it; hint-only,
    so least-harm in both directions.
- **Counters.** The dispatcher keeps `cacheEvictions`, `waiterOverCap`,
  `disconnectResolved`, `unmappedReason` (a relay string that matched no prefix —
  the drift signal if the hosted relay's wording changes; a structured relay-side
  code — and the refused `messageId` on BANNED frames — is owned by the dated action
  ACT-017, due 2026-10-20 (same repo, but the hosted relay is
  deployed on its own cadence behind client npm releases, so a client cannot
  assume the code field is present yet — that lag is the only reason the bridge
  exists); until then an unmapped `rejected` has
  UNKNOWN retryability, as the table says; the E2E tier asserts the exact relay
  strings, not just frame shapes, and the hosted relay deploys from this repo); the tracker keeps `expiredMismatchIgnored`.
  **Auth note: every `/threadline/*` path bypasses the Bearer middleware
  (`middleware.ts`: handshake + health are unauthenticated by design).** So the
  counters are NOT put on `/threadline/health`; the AUTHENTICATED BRANCH of
  `GET /health` (the route itself is public; its `isAuthed` block adds
  `multiMachine`/`eventLoop`/`telegramOriginStorage`) exposes them as a flat object
  `relayVerdicts: { cacheEvictions, waiterOverCap, disconnectResolved, unmappedReason, unconfirmedSettled, expiredMismatchIgnored }`,
  omitted when the callback is absent, under `threadline.relayVerdicts`, read
  from a new nullable `RouteContext` field (`relayVerdictCounters`) wired where
  `AgentServer` builds the context, beside `multiMachine.syncStatus`.
  `unmappedReason` increments once per frame; each DISTINCT unmapped reason
  also lands ONE `DegradationReporter` event keyed
  `A2ARelayVerdict:unmapped:<sha256(clamped)[0:16]>` with class-only text (the
  hash, never the relay prose — which stays in the tracker/audit log only). The
  distinct-key set is capped at 32 per process (a restart re-admits 32 —
  bounded by restarts, acceptable); overflow folds into one
  `unmapped-overflow` event, so high-cardinality relay wording cannot grow the
  event stream. A new counter `unconfirmedSettled` counts `relay-unconfirmed`
  outbox entries treated as settled (Frontloaded #9).
- **Ack origin invariant.** Only the relay writes `ack` frames to a client today
  (`RelayServer.handleAck` does not forward peer acks). A test pins this; if
  forwarding is ever added, verdict acks must carry a relay-origin marker first.

### 2. Tracker: record relay verdicts; never infer failure from silence

Additive columns on `a2a_delivery` (added by `ALTER TABLE … ADD COLUMN` guarded by
`PRAGMA table_info`, in `open()`; idempotent; metadata-only on large tables):

| column | meaning |
|---|---|
| `relay_status TEXT NULL` | last RELAY verdict: `delivered` \| `queued` \| `rejected` \| `expired` — relay-sourced values only; for a ban `relay_status` stays NULL and only `relay_reason_code='banned'` is set. All stored timestamps are JS `toISOString()` values (ISO with `T`), the invariant the lexical comparisons depend on |
| `relay_status_at TEXT NULL` | when it was recorded |
| `relay_reason_code TEXT NULL` | fixed code from §1: `queue-full` \| `rate-limited` \| `routing-refused` \| `banned` \| `unmapped` |
| `relay_reason TEXT NULL` | clamped relay text |
| `relay_expires_at TEXT NULL` | for `queued`: `at + clamp(ttlSec, 0, 24 h)`; 24 h when `ttl` is missing or not a finite number |
| `relay_retryable INTEGER NULL` | from the code table in §1 |

Plus `CREATE INDEX IF NOT EXISTS idx_a2a_delivery_state_sent ON a2a_delivery(state, sent_at)`
and a one-row `a2a_meta(key='relay_tracking_since', value=<ISO>)` written on the
first migration.

New tracker state **`unconfirmed`** (non-terminal): "no proof either way".
`recordAckByThread` / `recordAck` accept it like `awaiting-ack`.

`recordRelayStatus(messageId, verdict)` — single transaction:
- unknown `messageId` → ignored (another process's send, or pre-upgrade);
- `delivered` / `queued`: store the verdict; state unchanged; a late `delivered`
  or `queued` on an `unconfirmed` row moves it back to `awaiting-ack`;
- `unconfirmed` (reason `banned`, from the ban fan-out): from `awaiting-ack`
  only AND `relay_status IS NULL` (a sentinel re-drive of a row that already
  carries `delivered` must not be stamped `banned`), state → `unconfirmed`, `relay_reason_code='banned'`, `relay_status`
  untouched (NULL); a live waiter exists only for a just-sent row, so an
  `escalated` row can never receive it;
- `rejected` (any code) and `expired`: store the verdict and fail the row (from
  `awaiting-ack`, `escalated` or `unconfirmed`). A refusal IS the relay's stated
  outcome for that `messageId` — never "unknown". Retryability is a property of
  the CODE, stored beside it (`relay_retryable INTEGER`), surfaced in
  `lastRelayStatus`, and read by the next increment from `failed` rows; it is not
  a state. A later `queued`/`delivered` for the same id never overwrites a stored
  `rejected`. `expired` applies
  only when the row's `relay_status` is `queued` AND the frame's `recipientId`
  (the relay copies `envelope.to`, a canonical fingerprint — the same value
  `recordSent` stores as `peer_fp`; the integration test pins this against the
  real `RelayServer` frame, not a synthesized one) equals `peer_fp`; otherwise
  the frame is ignored and counted;
- a relay `delivered` never overwrites a stored `rejected` / `expired`;
- a `queued` verdict arriving for an `unconfirmed` row is a real id-bearing
  verdict: the row returns to `awaiting-ack` with `relay_expires_at` recorded
  (the sweep's queued rule then applies again);
- an `acked` row is never changed.

A peer **reply** acks `awaiting-ack`, `escalated` and `unconfirmed` rows as today
(Layer A). It never touches `failed` rows: those carry an explicit relay refusal or
expiry, so the reply must belong to a different message.

**Invariant:** `state` tracks PEER PROCESSING (ack by reply); `relay_status`
tracks the TRANSPORT verdict; neither is ever inferred from the other except by
the transitions listed in the table below.

**The existing "peer went quiet" signal must survive.** `pendingCount`,
`oldestPendingAgeMs` and `stale` are computed over `awaiting-ack ∪ unconfirmed`
(today: `awaiting-ack` only; `unconfirmed` rows with `relay_reason_code='banned'`
are included by that rule, so a ban keeps every affected peer visibly stale). A
peer is ALSO stale when it has a `failed` row the peer provably never received
(`relay_status='expired'`) newer than its last ack and last inbound. As one
expression, per peer:

```sql
stale = (oldest_pending_sent_at IS NOT NULL AND oldest_pending_sent_at < :cutoff)
     OR EXISTS (SELECT 1 FROM a2a_delivery d
                WHERE d.peer_fp = :fp AND d.state = 'failed' AND d.relay_status = 'expired'
                  AND d.relay_status_at > COALESCE(:last_acked_at, '')
                  AND d.relay_status_at > COALESCE(:last_inbound_at, ''))
```

(`oldest_pending_sent_at` = min `sent_at` over `state IN ('awaiting-ack','unconfirmed')`.)
The second clause clears only on a later ack or inbound — a dead channel must
not read healthy by age — and `failedCount` lets a reader tell it from the
time-windowed first clause. `findOverdue`, `markAttempt` and `markEscalated`
likewise include `unconfirmed`, so the parent spec's sentinel can still reach
swept rows. Test: a peer silent for 30 h still reads `stale:true` after the
sweep. `recordAck(messageId)` accepts `unconfirmed`. `recordAckByThread` never
considers `failed` rows, so a reply cannot be credited to a message with a
stored `rejected`/`expired` (a banned row is `unconfirmed` and remains
ack-eligible — the pre-existing Layer-A weakness, unchanged here). Why a relay
`rejected` outranks a later reply: a reply cannot be to a message the relay
never routed, so the ack belongs to another row (and for `expired` the queued
copy was discarded unread — the peer provably never received it); the "untrusted" note in
Non-goals is about ROUTING decisions the next increment makes on `failed`, not
about whether the refusal happened. `pendingCount` and `oldest_pending_sent_at`
are `SELECT COUNT(*), MIN(sent_at)` aggregates, never materialized rows. The
ISO-with-`T` timestamp invariant is enforced by one `nowIso()` helper used for
every tracker write and a unit test that rejects a space-separated value.
`PeerHealth` gains
`failedCount`, `unconfirmedCount`, `lastRelayStatus` (`{ status, at, reasonCode, retryable }`).

The minimal invariant path is: relay frame → dispatcher → tracker → route
response; everything else in this spec (sweep, pool read, counters, awareness)
is ancillary observability.

Transition table (row state × event → new state; `—` = unchanged):

| state \ event | relay `delivered` | relay `queued` | relay `rejected` | `delivery_expired` (corroborated) | BANNED frame (live waiter) | peer reply (Layer A) | sweep |
|---|---|---|---|---|---|---|---|
| `awaiting-ack` | — (status stored) | — (expiry stored) | `failed` | `failed` | `unconfirmed` (reason `banned`) | `acked` | `unconfirmed` |
| `escalated` | — | — | `failed` | `failed` | — | `acked` | — |
| `unconfirmed` | `awaiting-ack` | `awaiting-ack` (expiry stored) | `failed` | `failed` | — | `acked` | — |
| `failed` | — | — | — | — | — | — | — |
| `acked` | — | — | — | — | — | — | — |

`unconfirmed` rows that never get a verdict or a reply accumulate deliberately
(the table has no retention — pre-existing non-goal); the next increment consumes
them.
New index `idx_a2a_delivery_peer_state ON a2a_delivery(peer_fp, state)` keeps
the per-peer counts cheap. Additive.

### 3. The silence sweep (relabel only, never fail)

A new `setInterval` (15 min, `unref()`, single-flight, cleared on shutdown) owned
in `src/commands/server.ts` next to where the tracker is opened. It moves `awaiting-ack`
rows (only that state — an `escalated` row keeps its escalation) to
`unconfirmed` — never to `failed` — when, for `transport='relay'` rows sent after
`relay_tracking_since` only:
- `relay_status='queued'` and `relay_expires_at + 1 h < now`;
- `relay_status IS NULL` and `sent_at + 24 h < now`.

Both cutoffs are computed in JS as ISO strings and bound as parameters (SQLite's
`datetime()` output uses a space, not `T`, so SQL-side arithmetic would compare
wrongly). One `UPDATE … WHERE rowid IN (SELECT … LIMIT 500) RETURNING peer_fp`
per tick (bundled SQLite 3.51 supports `RETURNING`). Rows are relabelled oldest first (`ORDER BY sent_at ASC`). Brakes:
single-flight; a tick that throws reports ONE `DegradationReporter` event
(component `A2ADeliverySweep`, fixed dedupe key, class-only text — no DB path,
peer or agent id; `notifyUser` stays false, so any operator raise is downstream
of the reporter's own persistent-open escalation) then backs off 1 h → 2 h → 4 h,
ceiling 24 h, reset on a clean tick (applied by skipping ticks until
`nextAllowedAt`; the `setInterval` itself is never re-created). The route's
read-after-write ordering relies on the tracker write being synchronous
(better-sqlite3) inside the same `emit`. The audit file is size-checked by the sweep
tick before append (`fs.statSync`); at 10 MB it is renamed to `.1` (overwriting
any prior `.1`). A row a late
`delivered` moved back to `awaiting-ack` carries `relay_status='delivered'` and
is never swept again (it waits for a reply, as today). Each moved row is appended to
`logs/a2a-delivery-verdicts.jsonl` (messageId, peer fingerprint, from/to state,
cause; no message content). This sweep raises **no** operator notice: a peer
being offline is an ordinary event, and there is no self-heal step in this
increment (redelivery is off, fallback is the next spec). Escalation stays with
the parent spec's sentinel and the next increment, which consume `failed` /
`unconfirmed`.

### 4. Honest route outcome (`/threadline/relay-send`, `waitForReply:false`)

Order inside the relay branch becomes:
1. `sendAutoWithThread` (returns `messageId` synchronously);
2. before `awaitRelayAck`: `recordSent`, `recordThreadMessage` (the canonical
   outbound leg, so a fast reply never precedes it), `captureOrigin` (awaited as
   today; thread owner recorded before any reply can arrive — the anti-hijack
   guard depends on it). The in-memory reply claim is NOT released here (today it
   is released inside the outbox block; moving it later closes a double-reply
   window during the wait);
3. `verdict = await threadlineClient.awaitRelayAck(messageId, 3000)` (the 60 s
   cache covers a verdict that lands during `captureOrigin`);
4. the §5 subscription has already recorded the verdict; the route does NOT
   call `recordRelayStatus` itself (one writer, no double-record). Append the
   canonical outbox entry ONCE with the final outcome (`relay-sent` /
   `relay-queued` / `relay-rejected` / `relay-unconfirmed`) — the outbox is
   append-only and HMAC-per-line, so there is no update-by-id and no
   `pending-verdict` placeholder. `hasCanonicalReplyFor` puts the filter in its match
   predicate: it returns true iff ANY verified entry for `(threadId, inReplyTo)`
   has an `outcome` other than `relay-rejected` (absent or any other value, e.g.
   legacy `accepted`, counts as settled). A later refused retry therefore never
   un-settles an earlier success — the peer already holds that reply — and a
   `relay-queued` entry that later expires stays settled (never re-driven):
   unit tests for the `[relay-sent, relay-rejected]` and
   `[relay-rejected, relay-sent]` sequences (true, true) and `[relay-rejected]`
   alone (false). So reap recovery may re-drive a refused
   reply (a `routing-refused` re-drive is expected to be refused again; the
   bound is the resume queue's own `maxResurrections` (default 2 per 24 h
   window, keyed per topic, else per thread) plus entry TTL — not this rule). A `relay-unconfirmed` entry counts as settled even
   though a half-open socket means the peer may not hold it: the deliberate
   no-duplicate-over-no-loss choice (Layer B is the exit). So
   crash/reap recovery re-drives a refused reply instead of treating it as sent;
5. on a 2xx: Telegram-bridge mirror, then release the reply claim. On
   `rejected`: NO `retainReplyClaimFailure` (that marks "delivered but settlement
   failed" and would block a retry forever); the 502 releases the claim through
   the existing `res.once('finish')` handler, so a retry is allowed. In
   `waitForReply:true` mode a `rejected` verdict also clears this request's
   reply-waiter timer and deletes its map entry only if it is still this
   request's entry (an orphaned waiter's timeout would otherwise delete a retry's
   waiter on the same thread).

Known limits of this order: a SERVER crash inside the 3 s wait leaves no outbox
entry (a session reap does not — the route runs in the server and still appends
after the wait). The message may then be re-driven once, by the agent re-issuing
`threadline_send` after its HTTP call errored, or by a later reap of that session
with the inbound still unsettled; whichever fires first appends an outbox entry
that blocks the other via `hasCanonicalReplyFor`, so the duplicate is bounded to
one and the prior at-most-once guarantee is unchanged for every other path. A re-drive composes a NEW reply with a NEW `messageId` (`respawn` in
`ThreadlineReapRecovery` spawns a session that sends through `relay-send`), so
the relay's duplicate-id refusal is never triggered by it; the peer may receive
two replies, never a failed original. Rows with `relay_status='delivered'` and no
reply stay `awaiting-ack` (and count toward `stale`) exactly as today — this
increment does not change that; Layer B of the parent spec is the exit. A `rejected` message still has a canonical thread-log leg the peer never
holds, so that thread's symmetry reads `diverged` until the next successful
exchange — accepted, because the leg must be recorded before the verdict is
known.

The route's answer is reliable only while THIS process still owns the relay
socket: a displacement or reconnect during the 3 s wait resolves every pending
waiter `null` and the send reports `unconfirmed` (the tracker row remains
correctable by a late verdict landing here; one landing on another machine is
the documented posture limit). Latency: the normal cost is one relay round trip; a half-open socket costs the
full 3 s. The MCP client (`mcp-http-client.ts`) has no HTTP timeout of its own
(bounded only by fetch's defaults) and `threadline_send` does not retry on any
status. Why a synchronous wait rather
than "202 + poll": the agent needs the answer in the same tool call to decide its
next step, and 3 s is bounded; the tracker (§5) remains authoritative for late
verdicts, so the route's answer is provisional and says so. Why a dispatcher
rather than awaiting the tracker row: the tracker is optional (`tracker?.`) and
the in-memory path answers without a disk round trip; both consume the same
single subscription, so they cannot disagree.

Response (all existing fields kept; `delivered` stays reserved for proven
processing):

| relay verdict | HTTP | `success` | `accepted` | `relayStatus` | `retryLater` | `deliveryOutcome` |
|---|---|---|---|---|---|---|
| `delivered` | 200 | true | true | `delivered` | — | `handed to the peer's relay connection; not yet confirmed read` |
| `queued` | 200 | true | true | `queued` | — | `peer offline; the relay holds it for up to N h` (N = ceil(clampedTtlSec/3600), 24 when absent or non-numeric) |
| `rejected` | 502 | false | false | `rejected` | `retryLater: true` for `queue-full`/`rate-limited`; `null` for `unmapped`; else false (`boolean \| null` in `SendMessageResult`) | `not delivered: relay refused (<code>). Tracked; do not resend now.` |
| BANNED frame (live waiter) | 200 | true | false | `unconfirmed` (`relayReasonCode: 'banned'`, `banSuspected: true`) | — | `submitted to relay; the relay reports this sender banned` |

`banSuspected?: boolean` is a declared field on the HTTP response and on
`SendMessageResult`; the "none in 3 s" row carries `banSuspected: true` and the
ban text whenever the label is set.
| none in 3 s | 200 | true | false | `unconfirmed` | — | `submitted to relay; no relay acknowledgement within 3s` |

The field is named `retryLater` (not `retryable`) so an automated client does not
read it as "retry now"; it is relay-asserted, not peer-verified (a peer can fill
its own queue): it means the refusal was transient and a LATER resend
may succeed; the tracker row carries the same flag for the next increment.

The response carries `relayReasonCode` (never the relay's text). On 502 the
body also carries `error` (same text), `messageId` and `threadId`. 502 is kept
over 409/422 because the relay IS the upstream and its refusal is an upstream
failure; the only consumer (`threadline_send`) does not auto-retry 5xx, and any
future consumer must not either: clients key on the JSON body, never the status
class, and a 502 WITHOUT the JSON body (a proxy or tunnel 502) is treated as
`unconfirmed`, not `rejected`. A contract test asserts `threadline_send` does
not retry on 502.
`waitForReply:true`: the verdict wait runs concurrently with the reply wait (no
time comes off the reply budget); a `rejected` verdict ends the wait at once with
the same 502 body; otherwise behaviour is unchanged plus `relayStatus`.

**MCP path.** `SendMessageResult` (and its parsed type, copy step and the
`threadline_send` response in `ThreadlineMCPServer`) gains `relayStatus`,
`relayReasonCode`, `retryLater` and `banSuspected`; on a non-2xx the client keeps `error`, `messageId`, `threadId`.

### 5. Server wiring

`server.ts` subscribes once to `threadlineClient.on('relay-verdict', v => tracker?.recordRelayStatus(v.messageId, v))`.
Every step uses `tracker?.`; the route's `relayStatus` and `awaitRelayAck` do not
depend on the tracker.

### 6. Pool-scope read

`GET /threadline/peers/health` is reachable WITHOUT a Bearer token today (the
`/threadline/*` middleware exemption above), per peer, on this machine only. The
pool scope must not widen that: whenever `scope=pool` is present the handler
uses the token compare the authenticated branch of `/health` uses (sha256 both
sides + `timingSafeEqual` against `ctx.config.authToken`; 403 on a bad or ABSENT
token, as the middleware does). There is no shared helper today and a plain
`===` compare is not acceptable, so THIS increment extracts that token-only
compare into `bearerMatches(req, ctx)` in `src/server/middleware.ts` and uses it
in both places; the helper reads ONLY the `Authorization` header (never a
query-string token, which would land in fan-out URLs and logs), and `/health`
stays byte-identical in behaviour — including the no-`authToken`-configured
case, where `/health` treats every caller as authenticated and the pool branch
therefore does too (an install with no token has no secret to guard). The `X-Instar-AgentId` mismatch rule (which
`/health` does not apply) is applied in the pool branch only, after the token
compare (copying auth logic is how comparisons drift). The token guards fan-out AMPLIFICATION, not the data (the
per-peer leg is the unauthenticated default scope), and the spec records that
default-scope exemption as pre-existing rather than asserting auth that does not
exist.

`GET /threadline/peers/health?scope=pool` (and `/:fp/health?scope=pool`) merges
each online machine's rows via the existing pool fan-out used by the reaper pool
view (`readReaperPoolPeers` pattern): machine-tagged, a dark peer becomes a
`pool.failed` entry, never a 500. The `:fp` path parameter is validated against `^[0-9a-f]{6,64}$` and
URL-encoded; peers are queried with the DEFAULT scope only (no re-fan-out); peer
bodies are shape-checked and size-capped (the helper's 2 MB bound) as the helper
requires. Merge semantics: rows are never merged across machines — each row is
tagged `machineId`/`machineNickname` and keyed `(machineId, peerFp)`; counts and
`stale` are reported per machine row, and the top-level `staleCount` is the sum.
No clock-skew adjustment: timestamps are shown as each machine recorded them. When this
machine's own tracker is null the pool read still answers with `local: null` plus
the peers. In a mixed-version pool, machines on older code omit `unconfirmed`
rows. The default-scope `/threadline/peers/health` response gains a top-level
`instarVersion` (`ProcessIntegrity.getInstance()?.runningVersion`, falling back
to `ctx.config.version || '0.0.0'` — the expression `/health` uses, so
"absent" is never confused with `'0.0.0'`). That page is unauthenticated, so
this is a small new version disclosure, accepted explicitly: the version is
already public on npm and carries no secret. The pool read lifts it from each
peer body onto that peer's row, and `mixedVersion: true` iff any OK
peer's `instarVersion` differs from this machine's OR is absent (an older peer
omits the field — that IS the mixed case; failed peers are excluded). A summed
`staleCount` is therefore never silently an undercount. Default scope is unchanged.

### 7. Agent awareness

CLAUDE.md template + `migrateClaudeMd`: a new paragraph with its OWN sniff key
("What `relayStatus` means"), inserted after the existing A2A delivery-health
section: what each `relayStatus` value means, that `queued` means the peer is
offline now, that `unconfirmed` means unknown (not lost), not to resend a
`rejected` message immediately, that `stale` now covers unconfirmed and recently
failed rows, and that `?scope=pool` shows rows written by the relay-owning
machine from any machine.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Relay verdict → tracker state (`rejected`/`expired` → `failed`; `delivered`/`queued` → state unchanged except a late `delivered` moves `unconfirmed` back to `awaiting-ack`) | `invariant` | Transcribes a verdict the relay already made for that exact `messageId`; no competing signals; never blocks or reroutes. |
| Silence sweep → `unconfirmed` | `invariant` | Relabels to an explicitly non-terminal "unknown" state; takes no action, sends nothing, and any later verdict or reply overrides it. Fixed policy thresholds (Frontloaded #5). |
| Reply acks an `unconfirmed` row | `invariant` | A reply is proof of processing (parent spec Layer A); `unconfirmed` means no proof either way. |
| Route answer for a send (3 s wait, HTTP 502 on `rejected`) | `invariant` (fixed API policy) | Reports the relay's verdict or its absence; the wait cannot change delivery, only what is reported. Interface impact frontloaded (#2, #3). |
| Reason code → `retryLater` | `invariant` | Fixed prefix table (§1); agents act on it, so it is frontloaded, not inferred; an unmapped reason yields `null` (unknown), never a guess. |
| BANNED frame → every LIVE waiter's row `unconfirmed` (reason `banned`) | `invariant` | A socket-level signal is never turned into a per-message terminal verdict; the row stays correctable by any later id-bearing verdict or reply. |
| `hasCanonicalReplyFor` treats only `relay-rejected` as unsettled | `invariant` | A refused reply may be re-driven (bounded by the resume queue, per thread); a sent/queued/unconfirmed reply is never duplicated — the deliberate no-duplicate-over-no-loss choice (Frontloaded #9). |
| A peer reply never acks a `failed` row | `invariant` | The relay stated that message was not taken or expired; crediting a reply to it would be a false ack. |
| `delivery_expired` dropped on recipient / status mismatch | `invariant` | A frame that does not corroborate the row is not evidence about it. |

## Verify the State, Not Its Symbol

| Symbol | State it is taken to mean | Corroboration | Unmeasurable result |
|---|---|---|---|
| relay `delivered` | written to the peer's relay socket | relay routed to the recipient's own authenticated session | n/a — never treated as "read"; `delivered:false` stays |
| relay `rejected` | the relay did not take the message | relay is the only party that can accept it | — |
| relay `delivery_expired` | queued copy discarded unread | row's `relay_status` is `queued` AND the frame's `recipientId` equals `peer_fp` | mismatch → ignored and counted |
| no verdict | **unknown** | none | `unconfirmed` (non-terminal), never `failed` |

## Multi-machine posture

Posture: **unified (default)**. Each machine's tracker holds the rows for the
sends IT made (only the machine holding the relay connection can send; any other
machine's `relay-send` returns 503 before sending), and `?scope=pool` (§6) gives one merged read from any machine.
Known limit: a LATE verdict (flush `delivered`, `delivery_expired`) goes to
whichever machine holds the identity's socket at that moment; if that is a
different machine it ignores the unknown id and the row on the sending machine
falls to `unconfirmed` — honest, not wrong.

## Frontloaded Decisions

1. `delivered` stays reserved for proven processing; the relay's `delivered` is
   reported as `relayStatus`.
2. `rejected` returns HTTP 502, `success:false`, `retryLater` and "do not resend
   immediately". Interface change, deliberate: a refused send is a failed send.
3. The ack wait is 3 s, a fixed constant (not cheap-to-change: it shapes a
   published agent-visible answer). One relay round trip is normally well under it.
4. No fallback routing, redelivery or operator notice in this increment.
5. Sweep thresholds are fixed constants: queued → `relay_expires_at + 1 h`; no
   verdict → 24 h; TTL clamp 24 h; cadence 15 min; verdict cache 60 s / 2 000;
   waiter cap 1 000; reason clamp 200 chars.
6. The sweep only touches `transport='relay'` rows sent after
   `relay_tracking_since`, so the upgrade never relabels history in one burst.
7. Every relay refusal is `failed`; `retryLater` is a stored flag on the row and
   a response field, never a state.
8. Glossary: *single-flight* = a tick never starts while the previous one is
   still running; *DegradationReporter* = the local degradation ledger
   (disk + feedback service; no user notice unless `notifyUser`); *Layer A* = a peer reply counts as acknowledgement (parent spec);
   *displaced* = bumped off the relay by another connection with the same
   identity; *reply claim* = the per-inbound in-memory lock that lets only one
   session answer a given message; *canonical outbox/thread log* = the
   append-only, signed per-thread record of what this agent sent; *sniff key* = the literal the CLAUDE.md migration checks for before
   inserting; *pool fan-out* = the per-peer HTTP read used by pool-scope routes.
9. `relay-unconfirmed` outbox entries count as settled: no-duplicate over
   no-loss, counted in `unconfirmedSettled`; Layer B of the parent spec is the
   exit.
10. Ban fan-out is bounded by the 1 000-waiter cap; the `sendSeq` map and the
    verdict cache are capped at 2 000 entries each.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** live from the first build; the dispatcher, tracker
  transitions, sweep and route outcome are exercised against the in-repo
  `RelayServer` with no second machine (the three test tiers in Testing).
- **dev-agent-live:** ships live on this agent — a verdict listener that is
  dark reports nothing, which is the bug being fixed. The only behaviour that
  changes what an agent sees is the route answer (`relayStatus`, 502 on
  refusal); it is bounded, fail-honest, and reads `unconfirmed` on every
  uncertainty, so no dry-run is needed. The pool scope is dark until a second
  machine of this agent is online (it is a no-op with no peers).
- **fleet:** with the release that carries it, no flag: every path degrades to
  today's behaviour (`unconfirmed` = the old "submitted; acceptance
  unconfirmed") when the relay sends nothing.
- **graduation criterion:** on this agent, one week of sends to a peer known to
  be offline show `queued` at the route and `unconfirmed` after the sweep —
  never a false `failed` — and one send to a live peer shows `delivered` within
  one relay round trip; `unmappedReason` stays at 0 against the deployed relay.
- **dark-window:** none. The pool scope simply has nothing to merge on a
  single-machine agent.

## Security posture (summary)

- Default scope `GET /threadline/peers/health[/:fp]`: UNAUTHENTICATED today
  (pre-existing `/threadline/*` exemption), per peer, this machine only; gains
  `instarVersion` (accepted disclosure — the version is public on npm).
- `?scope=pool`: token-checked (`bearerMatches`, header only, 403 on bad or
  absent) plus the agent-id rule; guards fan-out amplification.
- Counters: authenticated branch of `/health` only.
- Relay prose never reaches an agent; codes only. Audit log
  `logs/a2a-delivery-verdicts.jsonl` carries `messageId` + full peer fingerprint
  (local, same visibility as `peerHealth` and the relationships store; no body).

## Non-goals

- **Loss-risk trade-off, stated plainly:** a `relay-unconfirmed` reply is
  treated as settled, so a half-open socket can leave a reply the peer never
  received un-resent by this increment. This is chosen over duplicates; the
  parent spec's Layer B (explicit `a2a-ack`, with its absence after a bounded
  window as the resend trigger) is the mechanism that revisits it.
- Fallback channels (Telegram agent messages, peer HTTP, GitHub) — next
  increment. It must treat relay-sourced `failed` as untrusted input (a peer can
  fill a recipient's offline queue on purpose) and `unconfirmed` as unknown.
- Turning on `A2ARedeliverySentinel`; its resends use new message ids that this
  tracker does not record.
- A durable relay offline queue (relay-side).
- Listener-daemon mode: when the daemon owns the relay, `relay-send` 503s before
  sending, so no verdicts are recorded. Unchanged.
- Table retention (pre-existing; unchanged; aging posture tracked as ACT-042,
  due 2026-10-20).

## Edge cases

- **Verdict before waiter / before row**: covered by the 60 s cache and by
  `recordSent` preceding any `await`.
- **Relay restart drops the queue / sender disconnected at flush or expiry**: no
  verdict ever arrives → the sweep relabels to `unconfirmed` (unknown); a later
  reply still acks it.
- **Half-open socket**: `sendMessage` does not throw, the relay never sees the
  message → `unconfirmed` at the route, `unconfirmed` again after the sweep.
- **Sender banned**: every live waiter → `unconfirmed` + `banSuspected`
  (reason `banned`, non-terminal); a send with no live waiter reports the same
  on timeout; a ban that lifts while the socket stays open is corrected by the
  next id-bearing verdict. Tests cover several in-flight sends, a reconnect /
  displacement during a ban, an ack cached before the ban frame (the cached
  verdict wins), a ban lifted mid-stream with a late `delivered` restoring the
  row, and the `sendSeq` clear rule.
- **Queued ack lost, then a genuine expiry**: if the immediate `queued` ack
  was lost (disconnect at send time) `relay_status` stays NULL, so a later
  `delivery_expired` fails corroboration and is ignored (counted); the row ends
  `unconfirmed` via the sweep rather than `failed` — honest, narrow, accepted.
- **Ack for another process's send**: unknown id → ignored.

## Testing (three tiers)

- Unit: `recordRelayStatus` — each verdict, no `acked` downgrade, `delivered`
  never overwrites `rejected`/`expired`, `expired` recipient mismatch ignored,
  `unconfirmed` → `awaiting-ack` on late `delivered`, reply acks an
  `unconfirmed` row but never a `failed` one, guarded column migration on an existing DB; sweep — only
  relay rows after `relay_tracking_since`, never `failed`, `RETURNING` audit lines;
  dispatcher — cache-before-waiter race, waiter timeout, cap, disconnect resolves
  waiters; reason clamp + code mapping.
- Integration: `/threadline/relay-send` against a real local `RelayServer`:
  recipient online (`delivered`), offline (`queued`, N h), queue full (502,
  `retryLater:true`, reply claim released, resend allowed, `hasCanonicalReplyFor`
  false for the `relay-rejected` entry); MCP `threadline_send` renders
  `relayStatus` and the 502 error; `peers/health?scope=pool` shape.
- E2E (the in-repo `RelayServer` — the hosted relay is deployed from this same
  codebase, so a relay change that would break a pinned invariant lands in this
  repo first and fails here): production server path — offline recipient → `queued` row; short-TTL relay
  expires it → `failed`, `peerHealth.failedCount` 1 and the peer reads `stale`;
  the real relay's `delivery_expired.recipientId` matches `peer_fp`; relay pinned
  not to forward peer acks, not to route a late verdict to another sender, and
  to ack inside `handleRouteMessage` BEFORE processing the next frame (the
  ordering the ban handling relies on: concurrent sends, some acked, then a ban); a sustained-failure sweep tick reports once and backs
  off.

## Migration parity

- SQLite: the six additive guarded columns of §2 (`relay_status`,
  `relay_status_at`, `relay_reason_code`, `relay_reason`, `relay_expires_at`,
  `relay_retryable`), both indexes (`(state, sent_at)`, `(peer_fp, state)`) and
  the `a2a_meta` row, all in `open()`.
- CLAUDE.md: template + own-sniff migration paragraph.
- No config defaults change.

## Rollback

Revert the commit. Older code ignores the added columns, the two indexes and the
meta table. Rows in the new `unconfirmed` state are omitted by older code's explicit
state lists (`peerHealth`, `findOverdue`, `recordAckByThread`): they go inert, a
later reply never acks them, and they drop out of `pendingCount`/`stale`. To
restore them run the one-line reverse migration
`UPDATE a2a_delivery SET state='awaiting-ack' WHERE state='unconfirmed'` before
or after the revert (the sweep only ever relabels `awaiting-ack` rows, so no
escalation is lost).
