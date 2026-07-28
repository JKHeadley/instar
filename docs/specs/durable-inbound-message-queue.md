---
title: "Durable Inbound Message Queue + Hold-for-Stability Policy"
slug: "durable-inbound-message-queue"
author: "echo"
ships-staged: true
rollout-flag-path: multiMachine.sessionPool.inboundQueue
rollout-criteria: "dark→dev-dry-run: wiring pins green both paths. dry-run→dev-live: >=7d dry-run, sane wouldEnqueue/wouldHold counters, zero dryRunErrors. dev-live→fleet: >=7d live, zero unexplained expired/dropped, holdsRecoveredInPlace>0, zero ordering-violation counter growth, operator sign-off. holdForStability trails one stage behind at every step (operator discipline — the reconciler tracks the inboundQueue flag only)."
rollout-evidence-type: endpoint
rollout-evidence-ref: /pool/queue
lessons-engaged: "P1, P3, P4, P5, P7 (Tier-0 justification in §Supervision), P10, P14 (§4.4 flap accounting), P17 (§7 emitter aggregation), P18 (§4.5 counters, dry-run counters), P19 (per-entry brakes + Eternal Sentinel declaration §3.2), PIS settle ordering + duplicate-window-5 honesty (§3.4/§5 — label corrected round-6, was misfiled as L17-adjacent), B1/B29 (copy rules §1/§5). Declined: P2 (no LLM in pipeline — deterministic-evaluator carve-out per signal-vs-authority, see §Supervision)."
review-convergence: "2026-06-12T19:50:59.641Z"
review-iterations: 10
review-completed-at: "2026-06-12T19:50:59.641Z"
review-report: "docs/specs/reports/durable-inbound-message-queue-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true
approved-by: "Justin (telegram uid 7812716706), topic 18423, 2026-06-12 13:16 PDT — 'approved'"
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
---

# Durable Inbound Message Queue + Hold-for-Stability Policy

Parent: CMT-1118 (Justin-approved 2026-06-12, option 2C from the June-5 loop-safety audit).
Parent principle: P19 — No Unbounded Loops.
Foundation: Multi-Machine Session Pool §L4, OwnerSuspectBreaker (#886).

## Glossary

- **Local durable custody** — the message is committed (`synchronous=FULL`) to this
  machine's queue store; survives process crash and reboot of THIS machine; does NOT
  survive permanent loss of this machine's disk. Never "durable" unqualified.
- **Custody-acked** — the route outcome telling the inbound pipeline "the queue has
  this; do not also deliver it now."
- **Delivered** — a real dispatch completed: local injection through the full inbound
  local-delivery path, or remote-ACKed by the owner.
- **Delivery guarantee** — at-least-once from custody to dispatch, with at-most-once
  acting enforced by injection-class receipts on both local and remote paths (§3.4).
  The known duplicate windows AND loss windows are enumerated in §5. We do not say
  "exactly-once."
- **Canonical message id** — `<platform>:<chatId>:<msgId>`, minted ONCE at ingress
  (§2.1) and used identically across all four dedupe surfaces: queue PK, mesh
  `deliverMessage` envelope, injection receipts, refusal negative cache. (Round-2
  review: three different key-spaces in one ledger produced both double-injection and
  false-duplicate-loss paths; one mint point kills the class.)

## Why this shape (and not the alternatives)

This is deliberately a small single-node durable inbox + retry worker on SQLite — not
an external MQ (zero-dependency is a project constitutional constraint: file-based
state, no brokers, and no NEW runtime dependencies — better-sqlite3 is already
shipped for PendingRelayStore/TokenLedger, which is why a third-party SQLite
queue library is also out: it would be a new dependency to audit for exactly the
semantics this spec pins explicitly; round-8 external) and not a fix to the platform-offset/ACK contract (the §L4
acked→offset plumbing spans every platform adapter and the lifeline, with per-platform
replay semantics — a larger conformance project this design neither needs nor
precludes; custody works the same whether or not it ever lands). Local custody
composes with the existing mesh, survives the common failure (process crash/restart),
and accepts — with enumerated, reported loss — the rare one (machine disk death).

Alternatives weighed and declined for v1 (round-3 external ask): **append to the
git-synced state log before custody-ack** — the git-sync cadence (minutes) is far
slower than the ack must be (sub-second), so it cannot be the custody write; **
replicate queue metadata to peers** (rqlite-class embedded replication or
metadata-only mesh push) — real cross-machine durability, and the named phase-2
candidate if live loss reports show incidence; rejected for v1 because it puts a
network round-trip (or a new consensus dependency) on the ingress hot path to defend
against a failure mode we have never yet observed, before we have data on its real
rate. The §5 loss windows + counters exist precisely to gather that data.

Named cost of the bespoke route (round-5, both externals): building on SQLite means
owning durability, retries, TTLs, and dead-lettering ourselves — features an
off-the-shelf MQ ships for free. Accepted because the zero-dependency constraint is
constitutional and the PendingRelayStore precedent has carried the same pattern in
production; the constraint is re-evaluated if the phase-2 replication candidate
ever becomes real (a consensus dependency would dwarf an MQ dependency).
Complexity budget + replace-triggers (round-9 external): the implementation is
bounded by the Minimal Correctness Core + twelve MUSTs (everything else is
droppable policy); the observed-failure triggers that would reopen the
architecture choice are named — recurring §5 window-1 loss reports → the
replication candidate; recurring window-4/6 `possiblyNotInjected` growth → the
platform-ACK conformance project (§Why-this-shape's declined alternative);
either trigger reads from counters this spec ships, not from anecdote.

```
Telegram/Slack ──ingress──▶ onTopicMessage
                              │ intercepts (commands, operator-bind, relocation)
                              ▼
                        dispatchInbound(via:'live') ──▶ route()
                              │                           │ queued/blocked verdict
                              │ deliverable                ▼
                              ▼                    PendingInboundStore (custody-ack)
                        inject / forward                  │
                              ▲                           ▼
                        dispatchInbound(via:'drain') ◀── QueueDrainLoop
                                                          ▲ triggers: ownership
                                                            confirm · breaker close ·
                                                            machine-online · 15s tick
```

## Minimal correctness core (round-5 — what cannot be compromised)

Everything in this spec is either CORE (an invariant whose violation loses or
duplicates a user message) or POLICY/OBSERVABILITY (tunable, degradable, droppable
under pressure). The core, in full: (1) custody is claimed only after a
`synchronous=FULL` commit, and a custody-acked message is never also delivered by
the fall-through; (2) one canonical message id across all four dedupe surfaces;
(3) the drain disposition derives `delivered` for local paths only from
receipt-write success, and the receipt is written at the ownership-handover point;
(4) per-session FIFO via head-only selection + the ordering gate; (5) dispatch
only while holding the router lease, tenure-stamped; (6) every LOCAL terminal
loss is reported (remote machine-death custody is SUSPECTED from the last
heartbeat, possibly incomplete — never overclaimed; round-7 external).
Structurally this IS an inbox/outbox table + single dispatcher worker —
the familiar pattern — plus ownership/lease semantics the multi-machine pool
forces; hold-for-stability, flap accounting, survivor reports, and all counters
are policy layered on the core and can be disabled without touching it.
Observability degradation is permitted (a failed counter write never stops
delivery); core invariant violations are not.

**Message state map (round-5 — "delivered" vs "receipt written" vs "actually
injected", disambiguated in one table):**

| Queue row | Receipt | Downstream (PIS/inject) | Means | User-visible outcome |
|---|---|---|---|---|
| `queued` | – | – | in custody, awaiting dispatch | delayed (≤ drain tick / hold window) |
| `claimed` | – | – | dispatch in flight | momentary; crash → re-queued |
| `claimed` | ✓ | – (either path — crash table row 2) | ownership handed over; inject may not have run | crash-instant loss window: boot sweep reports "possibly not injected — resend if unanswered" (§3.4, §5) |
| `claimed` | ✓ | ✓ | handover recorded; PIS replays inject after crash | exactly once — except the post-inject pre-clear crash instant (duplicate window 5, §5) |
| `delivered` | ✓ | cleared | terminal success | message arrived |
| `expired` / `dropped-overflow` | – | – | terminal loss | reported (§5: every terminal loss is reported, never silent) |

"Receipt written" is the at-most-once authority; "queue row `delivered`" is
bookkeeping that lags it safely; "actually injected" is downstream truth the
receipt deliberately precedes (loss-over-duplicate, argued §3.4).

**Implementation MUSTs (round-6 external — the hard requirements extracted from
rationale, one checklist):** (1) custody-ack only after `synchronous=FULL` commit;
(2) enqueue is the last fallible step before the outcome return
(no-throw-after-commit); (3) receipt write at the ownership-handover point,
transactionally conditional on the row still being `claimed` (§3.6); (4) caught
inject-error after receipt-write → report + `possiblyNotInjected`, never silent
(§3.4); (5) tenure = holder + acquisition generation, never the renewal-advancing
epoch (§3.5); (6) every transition asserts expected prior state; (7) head-only
selection + ordering gate, mirror never serves the route-throw check (§2.2/§2.3);
(8) dispatch only while `holdsLease`, checked per pass AND batch; (9) the six
config-seam invariants validated at boot, violation → queue OFF (§Config); (10)
boot sweep on the unconditional path, keyed on file existence, before any drain;
(11) every LOCAL terminal loss reported with a retained operator-visible locator
— timestamp, platform message id, topic, sender display name, payload length;
NEVER content (payload nulled at terminal; round-7 external: "resend if
unanswered" must be actionable, so the locator that lets an operator correlate
the affected message survives terminalization even though the content does not);
remote machine-death custody is SUSPECTED from the last heartbeat and may be
incomplete beyond top-K (§5.1) — "reported" is never overclaimed for it; (12) all
destructive fs ops through SafeFsExecutor. Everything else in this spec is
rationale, policy, or observability around these twelve.

## Problem statement (grounded against the shipped wiring)

The SessionRouter calls its `queueMessage` dep for every routing verdict it cannot
complete (transient `placing`/`transferring`, placement blocked, no capable machine,
CAS contention). In production that dep is a **no-op**, and — verified in code —
what actually happens to those messages today is:

1. **`RouteOutcome.acked` is consumed nowhere.** The §L4 ACK protocol exists in
   docstrings; the lifeline persists the Telegram poll offset after every update
   unconditionally. There is no platform redelivery for un-acked outcomes.
2. **`'queued'`/`'placement-blocked'` outcomes fall through to local dispatch** —
   the message is injected into whatever session this machine has, immediately,
   regardless of the routing verdict.

Consequences this feature fixes: **wrong-place delivery** (mid-transfer messages
injected into stale local sessions), **loss windows** (ingress paths with no
fall-through; sessions reaped mid-handling; no durable record anything was pending),
and **forced swaps** (the router's only answer to a suspect owner is immediate
re-placement — a 5-second blip moves the conversation; the swap churn Justin asked us
to reduce). The OwnerSuspectBreaker (#886) deliberately left the
queue-vs-replace policy open; this spec is that decision plus the queue it requires.

**ON-state behavior delta:** messages that today arrive immediately-but-possibly-in-
the-wrong-place will arrive in the right place, slightly later (sub-second on event
triggers; ≤ `drainTickMs` worst case; ≤ `holdMaxMs` during a held blip). OFF-state
behavior is byte-for-byte today's, **except** the one-shot residual-custody sweep
(§5.3) when a store file with non-terminal rows exists — scoped, named, fail-open.

## Design

### 1. PendingInboundStore

SQLite, PendingRelayStore-pattern with deviations noted:

- **Path** `<stateDir>/state/pending-inbound.<sanitizedAgentId>.sqlite`; `chmod 0600`
  after open, BEFORE the WAL pragma (sidecars inherit). Sanitization-collision caveat
  inherited and documented.
- **Pragmas**: WAL, **`synchronous=FULL`** (a custody-ack must survive power loss;
  PendingRelayStore's NORMAL is backstopped by its sender's exit-1 semantics — this
  store has no such backstop; write volume is human-message-rate), `busy_timeout=5000`.
- **Single-writer**: opened by the server process only; never a shell-side opener.
  Within the process (round-7 external): ONE serialized write executor owns ALL
  store + receipt mutations — live ingress enqueue, the 3 drain workers'
  transitions, boot sweep, prune, mirror reconciliation, and halt transitions all
  funnel through it (better-sqlite3 is synchronous, so the executor is a
  discipline statement: no interleaved multi-statement write sequences across
  async boundaries, every multi-step mutation is one transaction). Enforced as a
  contract, not a convention (round-8 external): the store class encapsulates the
  DB handle — no raw-handle export, every mutation a named method — and a unit
  test pins that the handle is private (the same encapsulation pattern
  PendingRelayStore ships).
- **Storage assumptions (round-4)**: the stateDir lives on a LOCAL PERSISTENT
  disk with honest fsync — a network-mounted stateDir voids SQLite's locking +
  fsync assumptions and is unsupported (one boot-time warning if detectable);
  containerized ephemeral volumes and fsync-lying storage likewise void the
  "local durable custody" claim (round-6 external) — the supported-deployment
  scope is stated, not silently assumed. Partial WAL/SHM corruption is
  exactly the §5.3 quarantine path. **ENOSPC (round-5)**: a disk-full enqueue fails
  → `refused` → fall-through (the fail-safe direction already covers it); a
  disk-full terminal-cleanup/prune failure is an Eternal-Sentinel tick failure —
  episode-latched, one degradation signal, never a loss of already-committed rows
  (SQLite transactions fail atomically). **WAL checkpointing (round-5)**: WAL mode
  auto-checkpoints at the default 1000-page threshold; at human-message-rate write
  volume the WAL stays small in steady state. A checkpoint failure (e.g. ENOSPC)
  leaves committed data in the WAL — still durable, still readable — and surfaces
  as the same Eternal-Sentinel degradation signal. Boot with an oversized WAL/SHM
  (a prior crash mid-checkpoint) is handled by SQLite's normal recovery on open;
  an open that fails outright IS the corrupt-store case → §5.3 quarantine. Tests
  named in §Testing: ENOSPC-during-enqueue, checkpoint-failure degradation, and
  boot-with-stale-WAL recovery.
- **Columns**: `session_key` + `message_id` (canonical id) — **composite PK**;
  `payload` (≤ `maxPayloadBytes`); `sender_envelope` (JSON `{userId, username,
  firstName}` captured at ingress); `topic_metadata`; `reason`; `state`
  (`queued | claimed | delivered | expired | dropped-overflow`); `enqueued_at` (wall,
  human-facing); `enqueued_mono` + `boot_session_id` (§6 — monotonic deadlines are
  reconstructable only within one boot session; cross-reboot, wall-clock + the
  post-reboot clamp govern); `lease_epoch` (tenure at enqueue, §3.5); `first_held_at`
  (§4.3); `first_frozen_at` + `total_frozen_ms` + `frozen_since` (§3.6 cumulative
  pause accounting; `frozen_since` is the round-8 fix — the in-progress episode's
  start must itself be durable, or a restart during episode ≥2 makes the
  cumulative span uncomputable: under-counting blows the invariant-3 receipt
  floor, over-counting charges unfrozen gaps and prematurely expires rows; each
  resume folds `now − frozen_since` into `total_frozen_ms` and clears it, and the
  cap/deadline-shift logic reads `total_frozen_ms + (now − frozen_since)` for a
  live episode); `attempts`; `next_attempt_at`; `last_error` (**sanitized**: error class +
  length-capped message, payload echoes stripped); `delivered_unconfirmed`
  (§3.4 round-9 — receipt-settled-without-confirmed-inject, a row-level fact);
  `status_history` (last 10
  transitions — states/reasons/timestamps only, never content); `enqueue_seq`.
  **Schema legality (round-3)**: SQLite permits AUTOINCREMENT only on an `INTEGER
  PRIMARY KEY` column, so the actual schema is `enqueue_seq INTEGER PRIMARY KEY
  AUTOINCREMENT` with **`UNIQUE (session_key, message_id)`** as the dedupe key —
  identical dedupe/eviction semantics to the "composite PK" phrasing used throughout
  this spec, and never-reused seqs guaranteed (plain rowid reuses after deletes).
- **Indexes**: `(state, next_attempt_at)`; `(session_key, enqueue_seq)`.
- **Transactions**: enqueue (existence check + insert + seq) is one transaction;
  claim is atomic `UPDATE … WHERE state='queued' … RETURNING`; every transition
  asserts expected prior state (mismatch = logged no-op).
- **Enqueue tri-state**: `queued` | `already-queued` | `refused`. `already-queued`
  semantics depend on the existing row's state: non-terminal or `delivered` →
  custody re-affirmed (correct dedupe); `expired`/`dropped-overflow` → **`refused`**
  (the prior instance was loss-reported; a bare custody re-affirmation against a row
  that will never dispatch would be silent loss — round-2 security finding).
- **Payload hygiene**: oversize → `refused`. On every terminal transition, `payload`,
  `sender_envelope`, `topic_metadata` are nulled in-transaction. Terminal rows are
  pruned after `deliveredRetentionMs` (24h) **by the backstop tick — pruning is an
  explicit §3.2 duty**. Dry-run/debug log lines carry ids and byte lengths, never
  message text. Unit test: a poison row whose parse error embeds the payload leaves
  no payload bytes anywhere at terminal.

**Bounds (P19) — with the real worst case named:**

- `maxPerSession` 50 — overflow evicts that session's oldest **`state='queued'`**
  row (never `claimed`) → `dropped-overflow` + loss report.
- `maxTotal` 500 — refuses FIRST entries (sessions with nothing queued). Sessions
  already queued may append (FIFO carve-out) — which makes the true ceiling
  `maxTotal × maxPerSession`; the carve-out is therefore itself capped by
  **`hardMaxTotal`** (default 1000 rows): above it, even carve-out appends are
  refused. Worst case is thus 1000 rows × 64KB ≈ 64MB, stated. A refusal for a
  session WITH queued entries is ordering-affecting: the fall-through delivers the
  message out of order — and possibly in the wrong place (the fall-through is
  today's local dispatch; under pressure the degraded mode is today's exact
  behavior, named) — rather than losing it (delivery beats both loss and silence —
  the chosen trade), increments an `orderingViolations` counter in `/pool/queue`,
  and logs episode-capped. `entryTtlMs` (30 min) bounds how long stuck sessions can
  occupy cap space.
- Refusal brakes: episode-latched logging + one degradation signal per episode + a
  negative cache keyed on the **canonical (session_key, message_id)** (round-2:
  a raw-id cache key re-imports the cross-chat collision the composite PK fixed),
  TTL `refusalNegativeCacheMs` 60s.
- Loss is never silent: every `expired`/`dropped-overflow` aggregates into ONE
  attention item per episode. **Copy rules**: counts + topic names + machine
  NICKNAMES (ids at debug only) + reasons + timestamps; never payload bytes; plain
  English; and ACTIONABLE, never a passive hope (round-3: "you may still get a late
  reply" promised a recovery no mechanism performs — an expired row is terminal):
  the loss copy is "I didn't get to these N messages — resend anything still
  needed," optionally listing topics.

### 2. Custody handshake

#### 2.1 The canonical id mint

The inbound handler mints the canonical id at ingress and uses it for the `route()`
`messageId`, the mesh `deliverMessage` envelope, injection receipts, and the queue
PK — one key-space everywhere. **Version skew**: receipts recorded pre-upgrade under
raw ids will not match post-upgrade redeliveries — at most one duplicate delivery per
in-flight message across the upgrade boundary; named and accepted (a dual-key check
during skew is optional hardening, not required).

#### 2.2 Router + consumption-site changes

- `queueMessage` becomes required, tri-state, and carries the sender envelope: the
  `InboundMessage` type gains `senderEnvelope?` populated at ingress, and
  `queueMessage(msg, reason)` persists it (round-2: the MUST-reinject-with-stored-
  frame guarantee was unimplementable without naming this signature change).
- The mesh `deliverMessage` envelope gains optional `senderEnvelope` so a drained
  `forwarded` disposition carries the frame; an old peer ignores it and injects with
  the default frame — the remote-path limitation is named and accepted for the skew
  window.
- The router's `queued`/`placement-blocked` return sites set `acked` true only for
  `queued`/`already-queued` enqueue results.
- **Consumption site**: custody-acked outcomes → return (no local fall-through);
  un-custodied (`refused`/off/dry-run) → today's fall-through. Wiring pins assert
  both directions. **Why refusal fall-through is safe for an acting agent
  (round-6 external — "wrong-place acting may be worse than loss")**: the
  fall-through IS the pre-queue baseline — today's SHIPPED behavior is
  unconditional local dispatch for every one of these verdicts, so the refusal
  path is never worse than the world without this feature; the queue only ever
  NARROWS wrong-place delivery (every custody-acked message is one that today
  would have dispatched wrong-place), and no per-message-type classification is
  needed because no message class gets a new wrong-place path it didn't already
  have. Wrong-place delivery remains visible via `orderingViolations` + the
  refusal counters.
- **Enqueue is lease-gated**: a machine that does not hold the router lease never
  takes custody (`refused` → today's fall-through) — custody is only ever taken
  where it can be drained (§3.5); without this, a non-holder's custody was
  guaranteed-loss-by-expiry (round-2 adversarial).
- **Route-throw fail-open is custody-aware — via a per-MESSAGE point read**: the
  inbound catch's local-dispatch fallback runs a point SELECT on the composite PK
  `(session_key, message_id)` against the store (indexed, single-writer, rare path);
  a committed non-terminal row for THIS message → skip local dispatch (the queue owns
  it); no row → today's fall-through fires. The session-count mirror MUST NOT serve
  this check (round-3, three reviewers: the mirror is session-granularity and a
  count>0 proxy silently loses a never-enqueued message whose session has sibling
  entries — the catch would skip dispatch of a message the queue never took). The
  mirror serves the ordering gate exclusively. Enqueue is the last fallible step
  before the outcome return (no-throw-after-commit invariant). Unit tests both
  directions: throw with only SIBLING rows queued → fall-through dispatches; throw
  with THIS message committed → skip.
- **Ingress-ledger lifecycle for custody**: a `queued`/`already-queued` enqueue
  result COMPLETES the ingress exactly-once ledger row for the message (custody is
  the durable copy from then on — otherwise stuck-row recovery replays the message
  through the full ingress path for the life of the hold), and the ledger transition
  is ordered strictly AFTER the enqueue commit (the reverse order has a crash window
  where the cursor advanced and no custody exists — unrecorded loss). Crash between
  commit and ledger-advance → the replay dedupes as `already-queued`. Unit-pinned.

#### 2.3 Ordering invariant

- `hasQueued(sessionKey)` counts `queued` AND `claimed`; evaluated INSIDE the
  per-session promise chain.
- Backed by an in-memory `Map<sessionKey, {count, minSeq}>` mirror. **Honest
  consistency contract** (round-2: "transactionally with the store" was not
  achievable for a Map): same-code-path updates at every transition site (enqueue,
  claim, release, terminal, eviction, poison, sweep, prune — enumerated in the
  build), boot-rebuilt, plus (a) read-through to SQLite whenever the mirror reads
  zero for a session being gated, and (b) reconciliation every 4th backstop tick
  (pinned round-6 — ~one reconciliation per minute at the default `drainTickMs`)
  (GROUP BY count over ≤1000 rows) that logs + corrects drift and increments a
  `mirrorDrift` counter surfaced in `/pool/queue` (dry-run/dev-live promotion
  evidence).
- Live messages enqueue behind existing entries; drain dispatches are exempt for
  their own entry by seq comparison — though with §3.2's head-only selection the
  drain-side gate-block is unreachable by construction (kept as a defensive assert
  with a logged no-op disposition).

#### 2.4 Dry-run

Never claims custody, never short-circuits, bypasses the ordering gate; maintains
**durable counters** (`wouldEnqueue`, `wouldHold`, `wouldRefuse`, `dryRunErrors`)
surfaced in `/pool/queue` — the dry-run stage evidence (round-2: rate-capped log
lines alone were structurally invisible). Residual rows from a live→dry-run flip are
handled by the §5.3 sweep.

### 3. QueueDrainLoop

#### 3.1 The dispatch seam: `dispatchInbound()` (extracted, not improvised)

Round 2 grounded the exact cut point: the current inbound handler
(`telegram.onTopicMessage`) is [stateful intercepts: operator auto-bind, commands,
nickname relocation, topic-profile ingress, hub/fix commands] → [`route()` +
outcome consumption] → [local-delivery tail: inject/respawn/auto-spawn +
injection tracking + per-message "✓ Delivered" confirmation]. The build extracts the
post-intercept core into a named function:

```
dispatchInbound(msg, opts: { via: 'live'|'drain', senderEnvelope, enqueueSeq? })
  → 'delivered' | 'un-routable' | 'failed'
```

`onTopicMessage` calls it after its intercepts; the drain calls it directly. The
`via:'drain'` contract (every divergence enumerated — the round-1 no-op-sink lesson
applied one layer up):

- **Bypasses the intercept stack** — a stored message is DATA: it is never
  re-interpreted as a relocation/profile/hub/fix command, never re-binds the topic
  operator, and emergency-stop classification happens at ingress only.
- **Bypasses the ingress exactly-once ledger gate** (the ingress record already
  exists for every queued message — re-presenting through it would drop every
  drained entry as already-handled, the round-2 "new sink one layer up"). The
  drain's at-most-once authority is the **injection-class receipt** (§3.4), a
  distinct record class written only at injection — never confused with ingress
  rows.
- **Suppresses the per-message delivery confirmation** (a 25-entry drain must not
  fire 25 "✓ Delivered" sends into one chat at Telegram's ~1 msg/s ceiling) — the
  pass summary carries the count; at most one aggregate confirmation per session
  per pass.
- **Runs**: routing, the full local-delivery tail (inject/respawn with the STORED
  sender envelope), and injection tracking. Same-session runs of multiple entries
  are paced with a 1s inter-inject delay (pinned round-6 — matches the Telegram
  ~1 msg/s framing above; coalescing is the rejected branch, kept out of v1 for
  determinism).
- Disposition mapping: `forwarded|duplicate|`remote `spawned`|remote
  `owner-dead-replaced` → `delivered` from the route action; **`handled-locally`
  AND self `owner-dead-replaced` (`placed-self` — round-4: the dead-owner re-place
  that chooses THIS machine returns its own action with a no-op `handleLocally`,
  exactly like `handled-locally`; without this row an implementer terminals it from
  the action and the fire-and-forget bug survives through one branch) →
  `delivered` only on receipt-write success** — the drain AWAITS the local-delivery
  tail through the §3.4 receipt/PIS write (round-3: the live tail's respawn and
  auto-spawn sub-paths are fire-and-forget, and the spawn-in-progress guard returns
  silently — the route action alone would terminal a row whose delivery never
  happened; the live path keeps its fire-and-forget). The spawn-in-progress skip
  maps to un-routable. `queued|placement-blocked` (and the skip) → un-routable:
  release + backoff + **`attempts++`** (round-3: without the increment,
  `maxAttempts` was unreachable from the un-routable class — the wedged-
  `transferring` treadmill the final forced re-place exists to unwedge would have
  TTL'd every entry serially with the escape hatch never firing); throw → failed
  attempt (§3.3).

#### 3.2 Selection, triggers, pacing

- **Head-only per-session selection**: only a session's lowest non-terminal
  `enqueue_seq` is eligible; successors inherit the head's schedule (round-2: due
  successors behind a backed-off head burned attempts against the gate forever).
- **Held-row exclusion**: the hold verdict is evaluated BEFORE claiming (pure
  in-memory: breaker state + capacity registry — no row I/O); rows whose verdict is
  `hold` are excluded from batch selection entirely while held (round-2 scalability:
  at defaults, held rows were due every tick with the lowest seqs and monopolized
  every batch). The recheck runs once per `holdRecheckMs` and evaluates **each held
  HEAD's `first_held_at` against `holdMaxMs`** (round-3: the round-2 wording said
  "episode age," which resurrected the per-episode reset bug §4.3 had just killed —
  a flapping owner's episodes are each younger than the budget while the entry ages
  to TTL loss). The `first_held_at` DB column is AUTHORITATIVE; the in-memory
  held-set is a boot-rebuilt cache of it (round-4: split state was ambiguous after
  restart — the no-row-I/O property holds because the cache serves the recheck, and
  a restart rebuilds it from the column, never resetting hold budgets). The breaker-close event delivers held rows
  instantly. **Hold-release herd cap (round-3)**: budget-expired releases whose
  dispatch implies re-placement/spawn are capped at `maxFailoverReleasesPerTick`
  (default 5 — matching the §5.1 respawn arm; a single blip stamps a cohort of
  `first_held_at` within seconds, so synchronized expiry is the NORMAL case, and an
  uncapped release is a spawn herd onto the surviving machine), oldest-first; beyond
  the cap, entries stay held with reason `budget-overrun`, counted, released on
  subsequent ticks ("per tick" = the `holdRecheckMs` recheck, not `drainTickMs`).
  Breaker-close RECOVERY deliveries (forwards into existing sessions on the
  recovered owner) are uncapped — they spawn nothing. **Drain-rate invariant
  (round-4)**: `budget-overrun` entries are the one class whose only exits are a
  capped release or TTL — so the config seam validates
  `holdMaxMs + ceil(maxHeldTotal / maxFailoverReleasesPerTick) × holdRecheckMs <
  entryTtlMs` (defaults pass with 4.6× margin; a legal-but-bad tuning must not turn
  the anti-herd cap into the loss mechanism).
- A pass loops batches (`drainBatchSize` 25 per batch, `drainConcurrency` 3
  cross-session) until no eligible rows or the pass deadline (`passDeadlineMs` 60s)
  — deadline stops new dispatches, releases unstarted claims; in-flight settles on
  its own timeouts. Pass duration exceeding `drainTickMs` under failing peers is
  expected; single-flight makes it safe.
- **Event triggers** (scoped `next_attempt_at` resets): ownership transition for a
  session with entries (the `emitPlacement` seam incl. confirmClaim); breaker close
  — `recordSuccess` gains an `onClose` hook (**new code, named**); machine-online
  transition — a new edge-detected `onMachineOnline` hook on MachinePoolRegistry
  (**new code, named**; liveness is currently derived per-read, no event exists).
- **Backstop tick** every `drainTickMs` 15s; duties: eligible-row scan, terminal-row
  pruning past `deliveredRetentionMs`, **receipt pruning (§3.4)**, TTL expiry,
  mirror reconciliation (every Nth), expired-quarantine deletion (steady-state
  layer; the boot sweep owns the gated-off case).
- Single-flight + `rerunRequested` + `minInterPassMs` 500ms.
- **Eternal Sentinel declaration (P19)**: the tick never gives up — declared:
  critical-healer role, rate floor = `drainTickMs`, constant per-tick cost, and
  observable: tick/scan failures are episode-latched (log once per episode, one
  degradation signal after 10 min sustained, recovery logged once).

#### 3.3 Per-entry error isolation

Each dispatch individually try/caught: throw → failed attempt (`attempts++`,
backoff, sanitized `last_error`). Unparseable payload/metadata → terminal `expired`
reason `poisoned` + loss report. An abnormal pass releases the single-flight guard
in `finally`.

**`maxAttempts` terminal semantics (round-2: the knob was decorative)**: at
`attempts ≥ maxAttempts` (10), the entry takes ONE final forced re-place — a
`placeAndClaim` that bypasses the hold/deliver verdict (today's behavior as the
floor; this also covers the spurious-stale-ack treadmill where re-placing is the
only thing that realigns epochs). Why the bypass is justified over
terminal-report-only (round-7 external): ten failed attempts against the SAME
owner is the strongest evidence available that this owner cannot make progress —
re-placement is the only arm left that can, and a hold verdict at that point
would just delay the same expiry. The bypass is COUNTED
(`holdBypassedByAttemptsCap`, surfaced in `/pool/queue`) so a stability-policy
override never happens invisibly; a growing counter during instability is the
signal to retune `maxAttempts`/backoff, named as dry-run/dev-live promotion
evidence. Only if that final re-place also fails does the
entry go terminal `expired`, reason `attempts-exhausted`, loss-reported. Silent
expiry is never the first resort.

#### 3.4 Idempotency on both paths (receipt = the ownership-handover record)

The from-queue local path writes an **injection-class receipt** (canonical-id-keyed,
distinct class from ingress ledger rows) **at the ownership-handover point**.
**Ordering is PINNED (round-7, adversarial: "same transaction/step as the PIS
record" was unimplementable — the receipt lives in the queue SQLite DB, the
PendingInjectStore is a separate file store, and cross-store atomicity does not
exist; PIS-first would open an unenumerated double-inject window AND let a
committed PIS record replay a post-stop inject after the §3.6 conditional receipt
correctly aborted)**: the conditional receipt commit comes FIRST (gated on the row
still being `claimed`, §3.6), THEN the PIS record for spawn-injects — or, on the
direct path, then the inject. A crash between the receipt commit and the PIS
write is crash-table row-2 semantics (receipt-without-downstream-record → boot
sweep marks delivered + "possibly not injected" report) — already-enumerated,
loss-over-duplicate-consistent. **Why receipt-before-inject (loss over
duplicate, argued)**: a duplicated user INSTRUCTION injected into a live agent
session is duplicate *acting* — the agent may re-run a command, re-send a message,
re-place an order; for an autonomous agent that is strictly worse than one lost
inject bounded to a process-crash instant, which the §5 enumeration + history
injection make visible and recoverable. Chat-display systems prefer
duplicate-visible; an acting agent must prefer at-most-once. The receipt is NOT at
the queue row's `delivered` transition
(round-2 walked the crash between PIS-write and row-transition: the boot sweep found
claimed-no-receipt, released it, and BOTH PIS replay and redispatch fired — the
receipt must be visible to the sweep the moment any downstream owner exists). The
queue row's `delivered` transition lags safely: a redispatch that finds the receipt
settles the row as `delivered` without injecting.

**Caught inject-error after receipt-write (round-6, adversarial — the non-crash
throw path)**: on the direct-inject route, a transient inject failure AFTER the
receipt write (tmux send failure, session reaped between claim and inject) must
not become silent loss recorded as `delivered`. The receipt remains the at-most-
once authority (re-injecting would risk exactly the duplicate acting it exists to
prevent), so the dispatch settles the row `delivered` — carrying a durable
**`delivered_unconfirmed` row flag (round-9 external: a state name should
reflect facts, not dedupe decisions — every receipt-settled-without-confirmed-
inject row is distinguishable AT THE ROW, not only in an aggregate counter, and
every surface treats flagged rows as their own class)** — and emits the SAME
"possibly not injected — resend if unanswered" report at error time (symmetric
with the boot sweep's detection of the crash variant), episode-aggregated, and
increments a dedicated **`possiblyNotInjected` counter** surfaced in `/pool/queue`
(round-6 external: operator metrics must never let `delivered` overstate success —
this state is distinctly countable, not folded into delivered). §5 loss window 4
is restated accordingly: bounded to a process-crash instant OR a caught
inject-error instant — BOTH reported, neither silent. Unit test: receipt written →
inject throws → row `delivered`, one report, counter incremented, no re-inject.

**Crash-point table** (round-2 codex — every partial state and its recovery):

| Crash after… | Queue row | Receipt | PIS row | Boot outcome |
|---|---|---|---|---|
| claim | claimed | – | – | sweep → queued; redispatch |
| receipt commit (EITHER path — before PIS write / before direct inject) | claimed | ✓ | – | sweep sees receipt-without-downstream-record → marks delivered, raises a "possibly not injected" line in the boot sweep's aggregated report (round-4: this state IS boot-detectable — receipt present, row claimed, no PIS record — so the accepted loss window is reported, not silent; bounded to a process-crash instant, enumerated §5; round-7: the receipt-first ordering pin makes this row cover the spawn path's receipt→PIS gap too) |
| PIS write (after receipt — round-7 pinned order) | claimed | ✓ | ✓ | sweep → delivered; PIS replays the inject (single owner; post-inject pre-clear crash = duplicate window 5, §5) |
| inject, before row transition | claimed | ✓ | cleared | sweep → delivered; no double inject |
| row transition | delivered | ✓ | – | terminal; pruned later |

Boot ordering: queue sweep first (consults receipts), then `recoverPendingInjects`.
**Halt reaches the PIS (round-8, adversarial: the stop/pause defenses were all
in-process — a stop landing after the PIS write, followed by a crash, left a
surviving PIS record that `recoverPendingInjects` would replay at boot, injecting
into a halted topic; same leak for pause via a pre-pause PIS record replaying
mid-freeze)**: (a) the STOP transition deletes the PIS record (via the
PIS's existing clear API, through the SafeFs funnel) for every row it
transitions that has one; (b) belt-and-suspenders, the queue boot sweep — which
already runs BEFORE `recoverPendingInjects` — vetoes/deletes PIS records for
session/message ids whose rows it observes as `operator-stop`. **STOP-scoped
ONLY (round-9, two reviewers): a "frozen" arm here would destroy the pending
replay for a row the pause PROMISED future delivery — and per the §3.6 round-9
pause-scope pin (`queued` rows only; in-flight dispatches complete), a frozen
row can never be mid-handover, so no frozen-row PIS record legitimately
exists.** This is
queue-side cleanup of queue-originated records, not a renegotiation of PIS
semantics. Integration test: stop after PIS-write + process crash + reboot →
zero injections for the stopped topic.

Remote path: receive-side `recordReceipt` keyed on the canonical id (§2.1 makes the
mesh envelope carry it, fixing the raw-per-chat-id collision in the existing mesh
receipt path). **The peer's receipt row carries an `injected` marker flipped
after its local inject completes (round-8, adversarial: a peer crash between
receipt-commit and inject was an UNENUMERATED silent-loss window — the sender's
row is already terminal `delivered` on the remote ACK, every redispatch is
deduped by the peer's own receipt, and nothing reported the loss): the peer's
boot sweep reports unflipped receipts as "possibly not injected — resend if
unanswered" (same copy class and bounded-to-crash-instant scope as the local
direct path; loss window 6, §5). The symmetry is COMPLETE only with the
non-crash variant (round-9, two reviewers): a peer-side CAUGHT inject failure
after receipt-commit (tmux send failure, session reaped — the same transient
class as the round-6 local fix) emits the same report + a peer-side
`possiblyNotInjected` counter AT ERROR TIME, marker left unflipped; and receipt
pruning REFUSES to silently prune an unflipped receipt — a long-uptime peer that
never reboots emits the report at prune time as the backstop, so the loss
cannot age out unreported. Loss-over-duplicate symmetric on both paths,
never silent on either — crash instant OR caught-error instant, both reported.** The receive side additionally re-validates a carried
`senderEnvelope.userId` against ITS OWN users registry before injecting with that
frame (per-machine registries can diverge during a deauthorization); failure NACKs
so the drain side terminals the entry `sender-deauthorized`. **NACK transport
(round-4 — the disposition was named but unreachable)**: the `DeliverAck.accepted`
vocabulary gains `'sender-rejected'` — a typed, NON-retryable ack that (a) does NOT
mark the owner suspect (the peer is healthy; it answered), (b) is not retried or
re-placed (the re-placed owner's registry would reject identically), and (c) maps
in the drain to terminal `sender-deauthorized`. Version skew: an old peer never
emits the new value (it doesn't re-validate) — drained entries to old peers keep
the at-ingress-validation-only posture, named.

**Receipt store mechanics (round-3 — four reviewers asked; the at-most-once
authority cannot itself be unbounded or ephemeral)**: injection-class receipts live
in a **class-tagged table in the queue DB itself** (same durability, same 0600 file,
same single-writer; the class column makes "never confused with ingress rows"
mechanical, not conventional). Retention: `deliveredRetentionMs` (24h), which
exceeds the maximum redispatch horizon (`entryTtlMs` 30 min + Σbackoff + 
`claimStaleMs` + `pauseMaxMs` + the boot-sweep window — round-10: this
parenthetical had gone stale, omitting the `pauseMaxMs` term invariant 3 added
in round 6; §Config's enforced inequality is authoritative) — the floor is
stated as an invariant: a
receipt MUST outlive every row that could redispatch against it, validated in the
config seam if the knobs are tuned. Pruning is a named §3.2 backstop-tick duty
alongside terminal-row pruning; rows are bounded by message rate × retention and
counted in `/pool/queue`.

**Per-dispatch deadline (round-3)**: the drain enforces `dispatchDeadlineMs`
(default 60s) around each `dispatchInbound` call, validated `< claimStaleMs` in the
config seam — replacing the round-2 single-retry-loop formula, which under-bounded
the real path ~4× (stale-ownership re-resolves compound up to `maxReResolveDepth`+1
full retry loops, and a CAS-loss cycle resets the depth — a claimed row's dispatch
could legitimately outlive `claimStaleMs` and get double-dispatched by stale-claim
recovery). Deadline-exceeded maps to a failed attempt (release + backoff).

#### 3.5 Lease/topology gating (tenure-stamped)

- Dispatch requires `holdsLease`, checked per pass AND per batch (the ≤1-batch
  mid-pass window after a lease loss is the named accepted residual).
- Every entry is stamped with the **tenure at enqueue**, where tenure is DEFINED
  (round-6, adversarial: the pool spec's lease epoch advances on EVERY renewal —
  stamping that would clamp virtually every entry that survives one renewal cycle,
  silently truncating the whole timing model to 2 min): **tenure = (holder machine
  id, acquisition generation)** — the generation advances only when a DIFFERENT
  holder acquires, never on renewal, and a same-holder re-acquire with no
  intervening holder (single-machine lease-store hiccup) is the SAME tenure. The
  `lease_epoch` column carries this tenure id. **Source of truth (round-7,
  adversarial: no pool-spec field carries this — the lease record's `epoch`
  advances on every renewal and `leaseGenerationStart` resets on a same-holder
  re-acquire, so both obvious candidates are wrong)**: the queue maintains its
  OWN acquisition-generation counter, persisted in the store's meta table, bumped
  iff the lease ref tip observed at this machine's claim names a holder ≠ self
  (the tip always names the last holder, so an intervening B in A→B→A is always
  visible at A's re-claim), unchanged on renewals and on same-holder re-acquire.
  The named alternative — tenure as a first-class lease-protocol field (round-9
  external) — is DECLINED for v1: it widens the blast radius to the pool
  protocol and every lease consumer for a value only the queue reads; the
  queue-local derivation is observably correct (the tip comparison cannot miss
  an intervening holder) and the four pinned unit tests force it. Revisit if a
  second consumer ever needs tenure.
  An entry dispatched under a
  DIFFERENT tenure takes the `staleCustodyTtlMs` clamp (2 min) — this
  covers lease-flap-back without a reboot (round-2: A→B→A lease cycling replayed
  10-minute-old custody into a conversation B had already served; the reboot-only
  clamp missed it). Same clamp post-reboot. **Frozen rows (§3.6) and tenure**: a
  pause does not change tenure (same holder), so resume-redispatch within the same
  tenure is never clamped — the §3.6 deadline-shift governs; if the lease MOVED
  to another holder during a pause, the clamp legitimately applies on the new
  tenure (frozen rows are not clamp-exempt across a real holder change). Unit
  tests: renewal-while-queued does NOT clamp; holder-change does; same-holder
  re-acquire does not; pause+resume same holder does not.
- A **planned** lease handoff is three ORDERED steps (round-3: leaving the enqueue
  gate open during the final pass was a structural capture window as wide as the
  pass — up to 60s of live messages taken into custody that then strands as
  guaranteed loss): (1) a handoff-in-progress flag flips the enqueue gate to
  `refused` (fall-through, same as non-holder; out-of-order deliveries for sessions
  with queued entries increment `orderingViolations` — the already-chosen trade);
  (2) final drain pass(es) run until empty or a bounded handoff deadline;
  (3) lease release. Entries that remain take the tenure clamp on the other side.
  Two-machine test: a message arriving mid-final-pass is delivered, never expired.
- A non-holder never dispatches; with §2.2's lease-gated enqueue, non-holder custody
  largely cannot arise; any residue (race at handoff) expires
  `lease-moved-before-drain`, loss-reported.

#### 3.6 Operator halt (emergency stop × custody)

Round-3 (two reviewers): the sentinel emergency-stop kills the session and clears
the autonomous job but never touched custody — the drain would have respawned a
session and re-injected the pre-stop work messages after the operator said stop,
converting a safety control into a delay. Therefore: on a sentinel
`emergency-stop` for a topic, the lease holder transitions that session's
non-terminal rows to terminal `expired`, reason `operator-stop`, loss-reported with
honest, actionable copy ("dropped on your stop command — resend anything still
wanted"). On a `pause`/freeze, **`queued` rows ONLY** are frozen — a DURABLE row
state (`first_frozen_at` +
cumulative `total_frozen_ms` + `frozen_since` (wall-clock, per §6's
cross-reboot rule) for the in-progress episode — all
three durable, §1 columns; an
in-memory frozen-set is a boot-rebuilt cache only), so a restart mid-pause stays
paused AND the cumulative accounting survives the restart (round-8: without a
durable `frozen_since`, a restart during episode ≥2 made the live span
uncomputable in both directions). **Pause scope is pinned to `queued` rows
(round-9, two reviewers independently): a pause is a soft hold, not an emergency
abort — in-flight (`claimed`) dispatches COMPLETE normally (bounded ≤
`dispatchDeadlineMs`), so a pause can never land inside the receipt→inject
handover window. This kills two silent-loss chains by construction: (a) the
§3.6 transactional fence and post-receipt re-check are STOP-scoped — under the
old "pause freezes everything" reading, a pause in the handover window committed
the receipt, skipped the inject, and the resume redispatch settled `delivered`
without injecting, unreported; (b) the §3.4 boot-sweep PIS veto no longer needs
a "frozen" arm at all (deletion is `operator-stop`-scoped ONLY), so a
crash-mid-pause can never destroy a pending replay for a row that was promised
future delivery. Two follow-on rules: a `claimed` row that RELEASES back to
`queued` while a pause is in effect is frozen at release (the drain already
consults halt state per pass, so it would not redispatch anyway — freezing at
release keeps the TTL accounting paused too); at boot with a pause durably in
effect, rows the sweep recovers `claimed`→`queued` are frozen by the same rule,
and crashed in-flight dispatches get normal crash-table semantics (receipt →
delivered + "possibly not injected" report; no receipt → queued+frozen;
receipt+PIS → the PIS replays at boot, COMPLETING the in-flight dispatch —
permitted during a pause, since in-flight work completing is exactly the
round-9 pause contract). Rows newly ENQUEUED while a pause is in effect are
frozen at enqueue — same rule as release (round-10: otherwise they would
TTL-run mid-pause). The
emergency variant that DOES abort in-flight work is stop, which is terminal and
loss-reported — pause never converts a promised delivery into silent loss.
Unit test: pause lands while a dispatch is between receipt and inject → the
dispatch completes and delivers; pause+crash+reboot → recovered rows frozen,
zero PIS records deleted, resume delivers exactly once.**
Frozen rows are excluded from selection and TTL accounting pauses (resume shifts
deadlines by the frozen span — the §6 sleep-shift pattern). The freeze is BOUNDED
**CUMULATIVELY per row (round-7, adversarial: a per-episode `frozen_at` clock
resurrects the exact per-episode-reset bug §4.3 killed for holds — a flapping
pause source could cycle pause→resume forever, each episode under the cap, the
row's redispatch horizon growing without bound past what config-seam invariant 3
budgets, re-opening the remote-receipt double-inject window after ~5 cycles at
defaults)**: `pauseMaxMs` (default 4h, validated in the config seam against the
§3.4 receipt floor) bounds `total_frozen_ms` ACROSS pause/resume episodes — the
single `pauseMaxMs` term invariant 3 budgets is therefore the true worst case,
not one episode's. Past the cumulative cap, frozen rows go terminal `expired`,
reason `pause-expired`, loss-reported with the standard actionable copy. Unit
test: N pause/resume cycles whose frozen spans sum past `pauseMaxMs` → terminal
`pause-expired`, regardless of per-episode duration. Standby copy for frozen
entries (same reason-keyed mechanism §4.7 uses for held entries): "paused on
your hold." Resume re-enters via the event-trigger
seam. Unit tests: frozen-past-cap expires reported; resumed-within-cap redispatches
against a still-live receipt; restart mid-pause stays frozen. The
drain additionally consults the halt state per pass/batch — AND at the §3.4
ownership-handover chokepoint (round-4: pass/batch granularity alone cannot deliver
"zero post-stop injections" — a dispatch in flight across the stop, up to
`dispatchDeadlineMs`, would respawn and inject pre-stop work after the operator
said stop). The handover step aborts before the receipt write when the session is
STOPPED (stop-scoped per the round-9 pin — a pause lets the dispatch complete);
the aborted dispatch then finds its row already transitioned by the stop
(claimed rows are non-terminal and ARE transitioned) and settles as a logged no-op
— the ledger honestly reads `operator-stop`, never `delivered`-that-wasn't or
`expired`-that-was. **The chokepoint consult alone is TOCTOU-racy (round-6,
adversarial: a stop landing between the halt-check passing and the receipt write
would let receipt + inject fire post-stop), so the close is transactional, not
temporal: the receipt write is conditional on the queue row still being `claimed`
(the same expected-prior-state assert every transition already carries) — the
stop's claimed→expired transition makes a late receipt write fail atomically,
which aborts the inject. The transactional fence covers the receipt write; the
receipt→inject gap gets its own close (round-7, adversarial: a stop landing
AFTER the conditional receipt commit but BEFORE the inject would otherwise fire
post-stop — the stop's transition succeeds on the still-claimed row, but nothing
re-consulted halt state): a post-receipt pre-inject STOP RE-CHECK (stop-scoped,
round-9) skips the
inject when stopped. Skip-after-receipt is safe — it is exactly the
already-enumerated orphaned-receipt shape: the row reads `operator-stop`
(transitioned by the stop), the receipt outlives harmlessly, and no redispatch
ever runs against a terminal row.** Guarantee scope (round-6 external): "zero
post-stop injections" is a LOCAL-handover guarantee — no local inject and no NEW
remote forward after the stop is observed (pass/batch/chokepoint consults); a
remote forward already ACKed by the peer before the stop propagates is the
peer's own halt state's to handle, named honestly. Integration test: queued rows
+ an in-flight dispatch + emergency stop → zero post-stop local injections
(including BOTH the stop-between-check-and-receipt AND the
stop-between-receipt-and-inject interleavings).

### 4. Hold-for-stability

#### 4.1 Verdict sites

Consulted at **every** `placeAndClaim(msg,'failover',…)` site: dispatchOne's
dead-owner branch, forwardToOwner's exhaustion, both re-resolve dead-ends. `hold` →
enqueue reason `owner-suspect-hold` (custody-acked).

#### 4.2 Required dep, effective-state honesty

`ownerHoldVerdict` is a required dep with an always-`'failover'` default injected
when the policy is off; config-coupled wiring pins both ways. The guard registry
entry for hold registers a **runtime getter reporting the EFFECTIVE state**
(always-failover default ⇒ `enabled:false`), so the orphaned-config case
(`holdForStability.enabled:true`, queue off) derives `/guards`
`off-runtime-divergent` as §4.6 promises (round-2: with `expectRuntime:false` the
posture was unreachable and `/guards` would have claimed `on-unverified`). The
getter is registered on the **unconditional boot path** (the same path as the §5.3
sweep), as a closure over the effective-state computation — round-3: registering it
inside the mesh-gated wiring means the orphaned case (whose components are exactly
the ones never constructed) derives a phantom `missing` instead of the promised
divergence. **Hold × queue-dry-run is pinned**: under `inboundQueue.dryRun`, hold
is effectively OFF (always-failover; the `wouldHold` counter is the dry-run
evidence) and the getter reports `enabled:false` — a `hold` verdict whose enqueue
would be non-custodial is never produced. Verdict
logic: heartbeat offline → `failover` (dead is dead; detection-lag caveat: a
hard-crashed machine reads online up to the staleness window — one hold cycle of
added latency, named). Suspect + online + within the hold budget → `hold`. Past
budget → `failover`. Not suspect (exhaustion sites) → `deliver` = enqueue-and-drain
rather than swap.

#### 4.3 The hold budget: per-entry cumulative, not per-episode

Round 2 broke the per-episode clock: `recordSuccess` fires on ANY ack (including
stale-ownership acks) and deletes the episode — a flapping owner granted itself a
fresh `holdMaxMs` per blip, and held entries' only exit became TTL loss. The binding
bound is now **per entry**: `first_held_at` is stamped at the entry's first hold;
the verdict returns `failover` for any entry with `now − first_held_at > holdMaxMs`
(90s) **regardless of the current episode's age**. Additionally, while the §4.4 flap
rate exceeds `flapThresholdPerHour`, the verdict for that machine forces `failover`
(a chronically flapping machine gets no hold at all until it calms). Held entries
never increment `attempts`; TTL still bounds everything. Unit test: an entry held
across ≥2 episodes releases to failover — never to `expired`.

#### 4.4 Flap accounting (defined mechanics)

The breaker gains an episodes-per-hour counter that survives `recordSuccess`
(in-memory; restart resets it and it re-trips within an hour — stated). A
**flap-episode** opens when the rate ≥ `flapThresholdPerHour` (6) and closes when
the rate stays below threshold for 30 min; open raises ONE attention item
(FailureEpisodeLatch; nickname in copy), close re-arms. Surfaced in `/pool/queue`.

#### 4.5 Counters (P18 — the value claim's artifact)

`holdsStarted`, `holdsRecoveredInPlace`, `holdsReleasedToFailover` (with reason
breakdown: budget-exhausted / flap-forced / `maxHeldTotal`-refused), durable,
in `/pool/queue` + the mesh capacity heartbeat. These are the fleet-promotion
evidence.

#### 4.6 Scope guards

`maxHeldTotal` (150) — when a `hold` verdict's enqueue is refused at this cap, the
verdict **degrades to `failover`** (swap; counted with its own reason) — never drop,
never local-inject. Pinned topics keep #886 semantics. Orphaned
`holdForStability.enabled` without the queue: degrade-loudly (treated off, loud log,
one HIGH attention item, `/guards` divergence per §4.2) — never a boot refusal.
Validation lives in the sessionPool config-validation seam, which also enforces
`claimStaleMs > (deliverMessageMaxRetries+1) × meshAttemptTimeout + Σbackoff`
(round-2: otherwise stale-claim recovery re-dispatches entries whose original
dispatch is still in flight).

#### 4.7 User surface during custody

The standby/PresenceProxy classifier gains a queued-in-custody state sourced from
the store, **keyed on the entry's `reason`** (round-3: `hasQueued` alone covers ALL
custody reasons; quoting the hold contract for a placement-blocked entry is the
honest-standby lie reborn): `owner-suspect-hold` → "held for stability — the owner
machine is recovering; it will deliver or move within ~Ns" with N **derived from the
live `holdMaxMs` + drain latency, never a literal**; all other reasons → "queued for
delivery — bounded by M minutes, after which you'll get a notice" with M derived
from `entryTtlMs`.

### 5. Custody-loss honesty — loss AND duplicate windows enumerated

**Loss windows:**

1. **Machine dies permanently.** Mitigation (consumes the mesh-path heartbeat —
   `queueDepth`, `oldestQueuedAt`, the holder's current tenure id (acquisition
   generation, §3.5 — round-8: the supersede-dedupe episode key is built from
   this value, and without it on an observable surface the survivor could never
   mint a key matching the returner's; one integer on the existing channel), and
   a bounded top-K per-session depth list
   (K=10, byte-capped) so the respawn arm is implementable (round-2: with only an
   aggregate, "the affected sessions it can identify" was the empty set)): on lease
   failover with nonzero last-heartbeat depth, the new holder raises ONE
   loss-SUSPECTED item (copy: nickname, ~N, heartbeat age, "suspected — the machine
   may have delivered some of these before going dark"; the copy frames the action
   as SESSION RECOVERY WITHOUT MESSAGE REPLAY, round-6 external — the queued
   messages themselves are not recovered, and the next user message lands in a
   fresh session without that context) and triggers re-placement
   for the top-K listed sessions — **each as a synthetic owner-dead re-placement
   through the router path** (`PlacementExecutor.decide` honoring pins and the
   suspect filter → CAS → spawn on the CHOSEN machine → `confirmClaim`); "respawn"
   means "re-place now instead of waiting for the next message," NEVER "spawn
   locally on the survivor" (round-3: a local spawn bypasses the ownership CAS —
   the registry still says the dead machine owns the topic, so the next message
   re-places onto a possibly different machine, orphaning the survivor's session;
   and it would violate pins). Capped (`maxFailoverRespawns` 5), staggered,
   recency-filtered (activity within `entryTtlMs`); the rest rely on lazy
   respawn-on-next-message. Two-machine test: a pinned-to-dead-machine topic in the
   top-K list is never spawned on the survivor.
   Heartbeat scope: **mesh capacity path only** (the quotaState precedent exactly);
   the git-synced `MachineHeartbeat` record is NOT extended (round-2: the claimed
   precedent never existed on that path and its 30-min cadence made the data
   useless) — a mesh-less peer's depth is honestly unknown and the item says so.
   If the "dead" machine returns: its residue takes the tenure clamp (§3.5) and its
   expiry report shares an episode key (machineId + acquisition generation — the
   dead machine's TENURE per §3.5, a vocabulary both sides observably share;
   round-7: "lease epoch" here was the un-propagated residue of the round-6
   tenure fix — a renewal-advancing epoch would essentially never match between
   the survivor's read and the returner's rows, silently degrading "superseded"
   into duplicate attention items) with the
   survivor's item — superseded, not duplicated.
2. **Reboot.** Boot sweep: `claimed` → receipt? `delivered` : `queued`; tenure
   clamp applies; TTL with loss reports. Sweep runs regardless of lease; only
   dispatch is gated.
3. **Queue dispatch will not run this boot** — trigger is NOT just
   `inboundQueue.enabled:false` but ANY gate that keeps the drain unconstructed:
   sessionPool disabled, stage `'dark'`, no mesh identity (round-2: the flag-only
   trigger resurrected the round-1 unreachable-accounting bug through three other
   doors). The sweep is keyed on store-file existence alone, placed on the
   **unconditional** boot path outside the mesh-gated block, runs as one
   transaction before any drain start, and its loss reason names the gate
   (`feature-disabled` / `pool-dark` / `no-mesh-identity`). **Fail-open**: a
   corrupt/locked store never blocks boot — catch, log once, quarantine-rename, one
   attention item. Quarantine renames + expired-quarantine deletions go through
   SafeFsExecutor (L12 — the destructive-fs funnel; round-6, lessons-aware). **Quarantine hygiene (round-3, deletion re-homed round-4)**: the
   rename moves the main file AND both `-wal`/`-shm` sidecars, preserves 0600, lands
   on a path covered by the backup exclusion, and expired quarantines (age > 7 days)
   are deleted **by this same unconditional boot-path sweep on every boot** — the
   backstop tick is only the steady-state second layer (round-4, two reviewers: the
   tick belongs to the drain, which is unconstructed in exactly the gate states that
   produce quarantines — a disabled install would have kept payload plaintext
   forever). E2E case: disabled boot with a stale quarantine → file deleted. **Flag semantics pinned**:
   `enabled`/`dryRun` are boot-read (rollback = flip + the normal restart, which
   fires this sweep); no live-flip path exists to strand rows silently.
4. **Receipt-then-no-inject** (direct-inject path, §3.4 table row 2): bounded to
   a process-crash instant OR a caught inject-error instant (round-6 — the
   non-crash throw path is reported at error time, not just by the boot sweep);
   the row reads `delivered` but the state is distinctly counted
   (`possiblyNotInjected`); enumerated
   honestly as the cost of closing the double-inject window on the other side.
   **Operator recovery is manual and the copy says so** (round-5): the boot sweep's
   "possibly not injected" report names the topic and says "if this message went
   unanswered, resend it" — no automatic recovery exists and none is implied.
5. **Backup/restore**: store + sidecars + quarantined copies excluded from
   BackupManager snapshots (in-flight per-machine state). Mechanically (round-3):
   BackupManager is allowlist-based, so exclusion is satisfied by NOT adding the
   files to `includeFiles` — there is no exclude knob to invoke; as a hard
   invariant against a future allowlist addition, the `state/pending-inbound.`
   prefix (stateDir-relative — a bare basename prefix never matches; round-4) and
   the quarantine path's prefix are added to the **unconditional**
   `BLOCKED_PATH_PREFIXES` set — explicitly NOT the `isRemediationEnabled()`-gated
   F-7 list, which is inert on agents with remediation off.
   Restore-to-new-machine forfeits custody **SILENTLY on the restored machine**
   (round-7, integration: the store is excluded from the very snapshot being
   restored, so no file lands and the file-existence-keyed window-3 sweep cannot
   fire — the previously claimed "sweep reports on first boot" was
   named-but-unreachable). The report fires only on the SOURCE machine's own next
   boot if it ever returns; the multi-machine case is covered by window 1's
   survivor item; single-machine restore-after-disk-death is the enumerated
   unreportable residue, consistent with the glossary's "does NOT survive
   permanent loss of this machine's disk."
6. **Peer crash between receipt-commit and inject** (forwarded path, round-8):
   the sender's row is terminal `delivered` on the remote ACK and every
   redispatch is deduped by the peer's receipt — so the loss is invisible to the
   SENDER by design. Closed on the PEER side: the receipt row's `injected`
   marker (§3.4 remote path) makes it boot-detectable; the peer's boot sweep
   reports unflipped receipts ("possibly not injected — resend if unanswered"),
   a peer-side caught inject failure reports AT ERROR TIME (round-9 — the
   non-crash variant, symmetric with the local path), and receipt pruning never
   silently prunes an unflipped receipt (reports at prune time as the backstop —
   episode-aggregated, skipped if already reported at error time; report once,
   then prune, retention never extended; round-10).
   Bounded to the peer's crash instant OR caught inject-error instant — both
   reported; version skew: an old peer has no
   marker — for the upgrade window the path keeps the prior posture
   (unreported), named.

**Duplicate windows (the glossary's cross-reference, fulfilled):**

1. Survivor respawn after a stale heartbeat — the dead machine may have delivered
   some entries after its last beat; history-injection can re-surface handled text.
   Bounded by the top-K cap + recency filter; named in the item copy.
2. Version-skew receipt boundary (§2.1) — at most one redelivery per in-flight
   message across the upgrade.
3. Claim-stale recovery racing a slow in-flight dispatch — closed in the common
   case by §3.4 receipts + the §4.6 claimStale validation invariant; residual:
   a remote forward whose ACK is lost after peer-side receipt → the redispatch is
   deduped by the peer's receipt (canonical id) — named, closed. **The dedup
   spans TWO machines' configs (round-8, adversarial: each machine's seam
   validates only its own knobs — a sender legally tuned to a long redispatch
   horizon paired with a peer legally tuned to short receipt retention satisfied
   both local seams while re-opening this window), so the closure is anchored to
   a PROTOCOL CONSTANT, not to paired tuning: `PROTOCOL_REDISPATCH_HORIZON_MAX`
   (12h, in code) — every machine's seam validates BOTH that its own redispatch
   horizon (`entryTtlMs + Σbackoff + claimStaleMs + pauseMaxMs + boot-sweep
   window`) ≤ the constant AND that its own `deliveredRetentionMs` ≥ the
   constant. Two locally-validated machines therefore compose safely under ANY
   legal tuning; the constant is not operator-tunable.**
4. Route-throw fail-open — closed by the §2.2 custody-aware catch; the residual is
   a point-read ERROR (not no-row) inside the catch, which fails open to
   fall-through — a bounded duplicate window when the row actually existed; named,
   episode-latched logged.
5. **PIS post-inject-pre-clear crash (round-6, lessons-aware foundation audit)** —
   the spawn-inject path delegates crash replay to PendingInjectStore, whose
   documented semantics are deliberately AT-LEAST-ONCE: a crash after the inject
   ran but before the PIS clear is indistinguishable at boot from "inject never
   ran," and the sweep re-injects — a duplicate, bounded to a process-crash
   instant (the mirror-image of loss window 4 on the other path). This asymmetry
   is DELIBERATE, not an oversight — with its honest scope (round-7): for fresh
   non-resume spawns the duplicate is the session's own kickoff message, not a
   new instruction into unrelated in-flight work — the lowest
   duplicate-acting-risk inject class. The RESUME-respawn subset (§3.1 respawn
   sub-paths that `--resume` a prior conversation) inherits REAL duplicate-acting
   exposure — a replayed kickoff lands in a conversation with live context —
   accepted for v1 because it is bounded to a process-crash instant; if live
   counters show incidence, the named follow-up <!-- tracked: CMT-1118 --> is routing resume-respawn injects
   through the direct-inject receipt-first discipline (loss-direction, matching
   §3.4's live-session posture) instead of PIS replay. The direct path into a
   LIVE session keeps loss-over-duplicate (§3.4) today. Renegotiating PIS's
   shipped semantics is a foundation change out of this spec's scope, named.

**Sender re-validation**: from-queue dispatch re-validates the stored sender against
the current users registry where the platform supports it; failure → terminal
`expired`, reason `sender-deauthorized`, loss-reported without payload.

### 6. Clock discipline

TTL/hold/backoff arithmetic uses a sleep-compensated monotonic source **within a
boot session** (`enqueued_mono` + `boot_session_id`; a persisted wall↔mono
calibration is written per boot). Cross-reboot, monotonic deadlines are NOT
reconstructed — wall-clock plus the post-reboot tenure clamp (§3.5) govern, which
bounds any skew abuse to `staleCustodyTtlMs`. On detected wake (SleepWakeDetector):

- `next_attempt_at` and `claimed_at` (claim staleness is sleep-compensated too)
  shift by the sleep span.
- **Lease first, then probe**: the wake sequence runs a FRESH lease pull before any
  queue activity (a cached `holdsLease` is stale at exactly this moment). A
  **failed/indeterminate pull is UNKNOWN, not moved** (round-3: the common wake has
  no network yet; classifying failure as moved would reboot-clamp perfectly
  recoverable custody on a single-machine agent) — queue activity stays idle and
  the pull retries within the settle grace; the moved/retained branches apply only
  on a successful pull. Lease moved during the nap → no probe; entries take the
  tenure clamp. Lease retained (the single-machine case, named) → bounded normal
  passes serve as the probe, with
  per-entry expiry postponement: TTL/hold expiry applies to an entry only after ≥1
  post-wake dispatch attempt (`lastProbeEpoch` stamp) — boundedness and
  no-mass-expiry compose (round-2: "ONE pass" could not cover 500 entries at batch
  25).
- A settle grace precedes the first post-wake pass (first successful registry
  refresh or a short fixed grace); probe failures inside the grace do NOT
  `markOwnerSuspect` (a wake into a not-yet-connected network must not paint the
  mesh suspect — the swap storm §6 exists to prevent).
- Wall-age bound: sleep span > `maxNapDeliveryAgeMs` (default 10 min) → residual
  custody is treated under the reboot-clamp rules (round-2: a 6-hour lid-close is,
  to the user, a reboot; delivering 6-hour-old chat verbatim contradicted the
  clamp's own rationale).

### 7. placing/transferring + router attention aggregation

The branch already calls `queueMessage`; entries become custody and the
ownership-transition trigger delivers on confirm. Bug-#11 amplification →
≤ `maxPerSession` rows + one item. The two per-message `raiseAttention` calls in
`placeAndClaim` are folded into a per-sessionKey FailureEpisodeLatch (P17 emitter
aggregation; burst-invariant-tested).

### Config (under `multiMachine.sessionPool`)

```jsonc
"inboundQueue": {
  "enabled": false, "dryRun": true,            // boot-read
  "maxPerSession": 50, "maxTotal": 500, "hardMaxTotal": 1000,
  "maxHeldTotal": 150, "maxPayloadBytes": 65536,
  "entryTtlMs": 1800000, "staleCustodyTtlMs": 120000,
  "maxNapDeliveryAgeMs": 600000, "deliveredRetentionMs": 86400000,
  "drainTickMs": 15000, "drainBatchSize": 25, "drainConcurrency": 3,
  "minInterPassMs": 500, "passDeadlineMs": 60000,
  "baseBackoffMs": 5000, "maxBackoffMs": 300000, "maxAttempts": 10,
  "claimStaleMs": 120000, "refusalNegativeCacheMs": 60000,
  "maxFailoverRespawns": 5, "maxFailoverReleasesPerTick": 5,
  "dispatchDeadlineMs": 60000, "pauseMaxMs": 14400000
},
"holdForStability": {
  "enabled": false, "holdMaxMs": 90000, "holdRecheckMs": 10000,
  "flapThresholdPerHour": 6
}
```

Defaults via `ConfigDefaults` `SHARED_DEFAULTS.multiMachine.sessionPool` —
`migrateConfig()`/`applyDefaults()` recursion verified to deliver nested new blocks
to existing agents with no extra migration code.

**Config-seam validation (round-5 — the cross-knob invariants in one enforced
set)**: every cross-component timing invariant named in this spec is validated in
ONE seam at construction (boot), not scattered: (1) drain-rate invariant (§3.2);
(2) `dispatchDeadlineMs < claimStaleMs` (§3.4); (3) `deliveredRetentionMs >
entryTtlMs + Σbackoff + claimStaleMs + boot-sweep window **+ pauseMaxMs**` (§3.4
receipt-outlives-redispatch floor; the `pauseMaxMs` term is §3.6's pause-floor —
frozen time extends a row's redispatch horizon, and omitting it would let a legal
tuning re-open the §3.6 double-inject window; round-6, two reviewers); (4)
`holdMaxMs < entryTtlMs` and `holdRecheckMs < holdMaxMs`;
(5) `staleCustodyTtlMs ≤ entryTtlMs`; (6) the cross-machine protocol anchors
(round-8): own redispatch horizon ≤ `PROTOCOL_REDISPATCH_HORIZON_MAX` (12h, code
constant, not operator-tunable) AND `deliveredRetentionMs` ≥ that constant — the
pair that makes any two legally-tuned machines compose safely (§5 duplicate
window 3). A violated invariant does NOT boot the queue
with broken timing: the queue stays OFF for that boot, one loud config-error line +
attention item names the violated inequality (fail-safe — OFF is byte-for-byte
today's behavior, never a half-configured queue). The shipped defaults satisfy all
six by construction and are the only tested configuration in v1 — the validation
seam is what makes operator retuning safe rather than forbidden.

### Gate × behavior matrix (round-3 external ask — the fail-open surface in one table)

| State | Enqueue | Custody-ack | Dispatch | Boot sweep |
|---|---|---|---|---|
| enabled, lease held | ✓ | ✓ | ✓ | normal (receipts → delivered) |
| enabled, lease NOT held | refused → fall-through | ✗ | ✗ | normal; residue → tenure clamp |
| dry-run | ✗ (counters only) | ✗ | ✗ | §5.3 if residual rows |
| disabled / pool-dark / no-mesh-identity | ✗ | ✗ | ✗ | §5.3 expire-all + report (gate named) |
| corrupt store | refused → fall-through | ✗ | ✗ | quarantine-rename + one item, boot proceeds |
| route() throws | n/a | n/a | catch: per-message point-read fall-through (§2.2); a point-read ERROR (vs no-row) fails open to fall-through — bounded duplicate window, §5-enumerated, episode-latched log | n/a |

### Hold-verdict table (input → verdict → queue action → user-visible outcome)

| Owner state | Verdict | Queue action | User sees |
|---|---|---|---|
| heartbeat offline | failover | re-place now | swap (today's behavior) |
| suspect+online, entry held < holdMaxMs, flap calm | hold | enqueue `owner-suspect-hold`, excluded from selection | ≤90s delay, then reply from same machine |
| suspect+online, entry held ≥ holdMaxMs | failover | release to re-place | swap after the hold |
| suspect+online, flap rate ≥ threshold | failover | re-place now | swap + one flap notice |
| not suspect (exhaustion site) | deliver | enqueue, drain retries | brief delay, no swap |
| hold refused at maxHeldTotal | failover | re-place now | swap, counted with reason |

### Wake-detection confidence fallback (§6 adjunct)

If SleepWakeDetector signals low confidence (missed/double-counted sleep), the wake
sequence degrades to the REBOOT rules: tenure clamp on residual custody, no
monotonic shift trust — wall-clock + clamps bound the damage exactly as a restart
would. One log line names the degraded path.

### Supervision tier (P7)

**Tier 0**: every disposition is deterministic over an enumerable domain; no LLM
call exists in the pipeline; every lossy outcome surfaces to the human via
aggregated attention items — the operator is the supervisor of record. The
signal-vs-authority deterministic-evaluator carve-out applies.

### Observability & agent awareness

- `GET /pool/queue` (Bearer; 503 dark): enabled/dryRun, leaseGate, counts (queued/
  claimed/held/delivered24h/expired24h/droppedOverflow24h), holds (+reasons),
  dryRun counters, `orderingViolations`, `mirrorDrift`, `possiblyNotInjected`,
  `holdBypassedByAttemptsCap`, flap state,
  oldestQueuedAgeMs, perSession (capped 50, total included), and
  `custodyDurability: supported|unsupported|unknown` (round-8 external — the §1
  storage-assumption posture as a live field: detected storage class, never a
  silent assumption). `delivered24h` EXCLUDES possibly-not-injected rows (round-8
  external: success totals never overstate; the two are summed separately).
- Mesh capacity heartbeat: `queueDepth`, `oldestQueuedAt`, tenure id (§3.5/§5.1),
  top-K per-session depths
  (byte-capped). Old peers ignore unknown fields; absence reads unknown.
- **Dashboard**: Machines tab queue-depth badge (decided).
- **Guard manifest** (keys follow the key === configPath convention — round-2):
  `multiMachine.sessionPool.inboundQueue.enabled` (`kind:'config'`,
  `component: 'QueueDrainLoop'`, dryRunConfigPath, expectRuntime false) and
  `multiMachine.sessionPool.holdForStability.enabled` (**`expectRuntime: true`**,
  `component: 'OwnerHoldVerdict'`, runtime getter per §4.2); PendingInboundStore =
  NOT_A_GUARD (data layer). `QueueDrainLoop` is added to the guard-lint
  `ADDITIONAL_CANDIDATES` (its name matches no filename-suffix heuristic — house
  convention for enabled-gated boot constructs). The two new `enabled: false`
  ConfigDefaults entries also register in `DEV_GATED_FEATURES` (or classify in
  `DARK_GATE_EXCLUSIONS`) per `lint-dev-agent-dark-gate` (round-7, integration —
  CI enforces this; named here so the build plans for it rather than discovering
  it at lint time).
- **CLAUDE.md template (P5 + Migration Parity item 3)**: `generateClaudeMd()` section
  (capability curl; proactive triggers: missing/late message → `/pool/queue` + loss
  reports + reap-log; "why 90s late?" → the hold policy) + `migrateClaudeMd()`
  content-sniffed migration. Ships in the feature PR.
- Drain: one summary line per pass; per-entry at debug (ids + lengths only).

### Decision points touched

`queueMessage` no-op → required durable custody with a consumption site that
actually consumes it. Suspect-owner dispatch gains a bounded `hold`. The drain
re-enters the SAME dispatch core live messages use, below interception — it never
re-interprets stored data as commands, never re-binds principals, and never makes a
placement decision the router wouldn't. Signal-vs-authority clean.

### Testing (three tiers; the round-2 additions named)

- **Unit**: store (PK collision; bounds incl. hardMaxTotal carve-out boundary;
  AUTOINCREMENT across prunes; claim CAS; eviction-skips-claimed; payload nulling +
  sanitized last_error leaves no payload bytes; tri-state incl. terminal-row
  semantics; negative-cache composite key incl. cross-chat); drain
  (disposition-by-action; head-only selection — a due successor behind a backed-off
  head is NOT dispatched; held-row exclusion — 150 held rows + 1 deliverable
  session: the deliverable dispatches on the next tick; ledger-bypass — a drained
  entry whose ingress row is in any post-ingress state still injects; poison;
  pass-deadline release; maxAttempts → final forced re-place → expired only on
  failure); hold (verdict at all sites incl. exhaustion; `first_held_at` across ≥2
  episodes → failover never expired; flap-forced failover; maxHeldTotal → failover);
  custody-aware route-throw catch; no-throw-after-commit; wake (lease-moved → no
  probe; per-entry expiry postponement; grace suppresses markOwnerSuspect);
  mirror (read-through-on-zero; reconciliation corrects an injected drift).
- **Sustained-failure (P19 clause)**: wedged owner, fake clock, 1h — bounded
  attempts/log-lines/items, all entries terminally settled via the §3.3 ladder.
- **Storage faults (round-5)**: ENOSPC-during-enqueue → `refused` + fall-through
  (injected fs error); checkpoint-failure → degradation signal, committed rows
  readable; boot-with-stale-WAL (kill mid-write, reopen) → rows recovered; config
  seam: each of the six cross-knob invariants violated → queue OFF + named
  config-error (never half-boots).
- **Integration**: `/pool/queue`; enqueue→drain→deliver on real SQLite; consumption
  short-circuit; drained-local inject carries stored sender envelope; receipt-at-
  handover crash interleavings (crash between PIS-write and INJECT → exactly one
  inject; the post-inject pre-clear crash instant is duplicate window 5, asserted
  as ≤2 never silent-zero — round-6: the foundation's at-least-once replay makes
  "exactly one" unprovable for that instant); 50-drained-entries-one-topic → ≤1 confirmation send
  (burst-invariant, which also covers the §7 aggregation); off-flip sweep for EACH
  gate reason + corrupt-file quarantine boot; at-cap ordering carve-out +
  orderingViolations counter.
- **E2E**: prod init with feature on (route 200, file 0600, drain scheduled, guard
  rows present); disabled-with-rows boot (sweep fires); pool-dark-with-rows boot.
- **Wiring pins**: enabled ⇒ real store + short-circuit + real verdict + mesh
  timeout present + hold runtime getter registered; disabled ⇒ no-op + fall-through
  + always-failover verdict.
- **Two-machine**: transfer-window queue → exactly-once in-order delivery on
  target; planned-handoff final drain pass; lease-flap tenure clamp.

### Rollout

Per frontmatter (flat keys — round 2: the nested YAML block was unparseable by the
actual scanner and the flag path must name the BLOCK so dryRun is observable).
Stage ladder: dark → dev-dry-run → dev-live → fleet; holdForStability trails one
stage behind by operator discipline (the reconciler tracks one flag per spec — the
trailing ladder is body prose by design). Rollback = flip + restart; §5.3 sweep
guarantees the accounting.

### Non-goals

Placement weighting by queue depth; outbound/mesh-RPC queueing; cross-machine
custody replication (phase 2, triggered by live loss-report incidence); the §L4
platform-offset back-pressure project (see "Why this shape").

## Resolved questions

1. TTL 30 min stands — monotonic within boot, wall + clamps across reboot/nap.
2. Hold clock: per-entry cumulative `first_held_at` (round 2 broke per-episode).
3. Heartbeat depth: mesh path only, with bounded top-K per-session list; consumed
   by the survivor report + capped respawn.
4. `staleCustodyTtlMs` 2 min / `maxNapDeliveryAgeMs` 10 min defaults STAND
   (resolved round-5, agent decision per the standing design-fork directive): a
   cross-tenure instruction older than 2 min should not fire into a conversation
   another machine has been serving, and 10 min matches "stepped away" tolerance
   for chat. Both are operator-tunable under the config-seam validation, and the
   §5 loss/expiry counters give the data to retune from — cheap-to-change-after
   in the literal sense (a config knob behind a dark flag).
5. Flap attention item: OBSERVATION-ONLY in v1 (resolved round-5, same directive).
   Auto-suggesting a topic pin off a flapping machine is an authority step
   (signal-vs-authority) taken only after live flap data shows the suggestion
   would have been right; the item copy names the machine + rate so the operator
   can pin manually today.
6. Refusal fail-mode: v1 ships FALL-THROUGH ONLY (resolved round-9, same
   directive; raised by the GPT external twice). A `failClosedReport` mode
   (refuse + report instead of local dispatch, for acting-agent deployments
   that prefer loss over wrong-place acting) is a named post-v1 knob, gated on
   live refusal-counter data — adding a new deliberate-loss surface before any
   live data on refusal rates would trade a bounded known risk (today's exact
   behavior) for an unbounded unknown one.

## Open questions

> All questions resolved into the section above (round-5).

None.
