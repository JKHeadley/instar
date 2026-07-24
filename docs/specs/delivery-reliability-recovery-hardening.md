---
title: "Delivery Reliability Recovery Hardening"
slug: "delivery-reliability-recovery-hardening"
author: "instar-codey"
parent-principle: "Canonical Pipeline Operational Completeness — Accepted Intake Must Drain"
eli16-overview: "delivery-reliability-recovery-hardening.eli16.md"
approved: true
approved-by: "User dispatch 2026-07-24 — CMT-1002/CMT-1003 delivery-reliability lane"
approved-basis: "Explicit 2026-07-24 directive to fix CMT-1003 and CMT-1002: recover NULL-scheduled relay rows, escalate stale backlog once, add queue alarms, and reproduce/fix the dead-active liveness gap. The same directive conditionally authorized folding in the hanging attention route ('if scope allows'); convergence found it is the same accepted-intake-without-a-drain failure class, so it is included."
review-convergence: "2026-07-24T09:15:00-07:00"
lessons-engaged:
  - "P1 Structure > Willpower"
  - "P4 Testing Integrity"
  - "P10 Comprehensive-First"
  - "P14 Distrust Temporary Success"
  - "P17 Bounded Notification Surface"
  - "P18 Observation Needs Structure"
  - "P19 No Unbounded Loops"
  - "P20 Verify the State, Not Its Symbol"
  - "P21 An Instar Agent Is Always a Multi-Machine Entity"
  - "P22 Self-Heal Before Notify"
  - "P23 Notices Route to the Alerts Topic"
  - "Migration Parity"
  - "A Dark Feature Guards Nothing"
  - "A Refusal Stays a Refusal"
  - "Runtime End-to-End Proof"
  - "Canonical Pipeline Operational Completeness"
  - "Near-Silent Notifications"
  - "L6 Side-Effects Review"
  - "L7 Bug-Fix Evidence Bar"
  - "B22 Own the Lifecycle"
  - "B24 Gate Latency vs Client Timeout"
---

# Delivery Reliability Recovery Hardening

## Problem statement

Three production observations on Echo's Mini exposed one delivery-reliability class: durable state correctly recorded work that should eventually reach the operator, but the process responsible for advancing that state either never ran, suppressed its own detection, or coupled local acceptance to slow network I/O.

### Incident A — ordinary pending replies had no running owner

Echo's live `pending-relay.echo.sqlite` contained 33 ordinary rows in `state='queued'`, all with `next_attempt_at=NULL`. The oldest had been queued since 2026-06-03 and a 2026-07-19 reply for topic 29723 never reached the operator. One separate row is terminally labeled `superseded-resent-directly`; it is not claimable and must remain untouched.

The store query is not the defect: `PendingRelayStore.selectClaimable` has included
`next_attempt_at IS NULL` since the Layer-3 sentinel was introduced. The lifecycle
wiring is the defect. Echo runs the always-on `ReapNoticeDrain`, which deliberately
owns only `reap-notify:` rows. Ordinary rows are owned by
`DeliveryFailureSentinel`, but that component is still default-off and Echo has no
enabling config. Correct SQL in an inert component is not recovery.

The dormant component also has an unsafe startup policy: it deletes old claimable
rows after a short age threshold. That would replace one silent-loss mode with
another as soon as the component is activated. A weeks-old message must not be
delivered without context, but it also must not disappear.

### Incident B — a global queue pause hid an autonomous orphan

At 2026-07-24 14:36Z an age-limit reap removed the live session for a still-active
autonomous run with about three hours remaining. No replacement session existed
until 15:36Z. During that hour `GET /autonomous/liveness` showed
`respawnTotal: 0`, `observing: []`, and no would-respawn evidence.

The run-state/session join is healthy: the current `/autonomous/sessions` surface
resolves topic 29723 from the same run file the reconciler reads. The suppressor
was a durable ResumeQueue pause (`pauseReason: "autonomous stop-all"`). The
reconciler checks `queuePaused()` before it classifies any run and deletes its
observation state. An actuation brake was accidentally made a detection brake.
Dry-run therefore learned nothing precisely during the state it was deployed to
observe.

### Incident C — attention acceptance waited on Telegram

`POST /attention` awaited `TelegramAdapter.createAttentionItem`. In the default
single-alert-topic mode, that method sent to Telegram before inserting and saving
the attention item. A stalled Telegram request therefore kept the HTTP request
open beyond ten seconds and left no durable local item until the network call
returned. The source comment claimed the item was already recorded; execution
order contradicted the comment.

## Scope

This is a review-and-build amendment to the existing Telegram delivery robustness
and autonomous liveness designs. It changes:

1. ordinary pending-relay lifecycle ownership and stale policy;
2. queue health detection and bounded aggregate escalation;
3. the relationship between liveness detection and ResumeQueue actuation pause;
4. attention creation ordering and the HTTP acceptance contract.

It does not change Telegram authentication, message content policy, resume UUID
authority, autonomous ownership/lease gates, or the always-on `reap-notify:` lane.

## Proposed design

### 1. The ordinary relay monitor is always constructed, with a compatible master mode

`AgentServer` opens the per-agent pending-relay store and constructs
`DeliveryFailureSentinel` whenever the SQLite substrate and `stateDir` are
available. The component has a versioned master mode:

- `monitoring.deliveryFailureSentinel.mode: "recover"` — observe, recover fresh
  rows, withhold stale rows, and drain incident outbox records;
- `"observe"` — read-only queue health and status, with no row mutation and no
  outbound attention;
- `"off"` — no tick loop; guard/status says intentionally disabled.

The deprecated boolean remains a compatibility input only when `mode` is absent:
`enabled:true → recover`, `enabled:false → off`, omitted → `recover`. A
PostUpdateMigrator writes the resolved `mode` once, idempotently, so an explicit
legacy false remains deny-wins and distinguishable from the former omitted
default. An `off` or failed-start monitor is never reported healthy: the canonical
guard/status records `consumerUnavailable` and a boot degradation event. This
amendment explicitly supersedes §3i/§3j of the approved Telegram Delivery
Robustness spec: two months of production state now show the dark guard itself is
the failure—ordinary NULL-scheduled queues accumulated on three installed agents
(33 on Echo, 10 on Bob, 9 on Instar-codey) while the reap-only consumer stayed
healthy.

This makes lifecycle ownership explicit:

- `ReapNoticeDrain` owns claimable rows whose id is inside the `reap-notify:`
  prefix range.
- `DeliveryFailureSentinel` owns all other claimable rows.
- The two SQL predicates remain complementary and both treat
  `next_attempt_at=NULL` as due now.

In `recover` mode the monitor performs an immediate startup tick and keeps its
existing event-driven kick plus five-minute recovery watchdog. A separate
metadata-only health tick runs every 60 seconds so alarm latency is not coupled
to the five-minute retry backstop. Both tick entry points share one process-local
single-flight promise; overlapping startup/SSE/timer kicks coalesce.

### 2. Stale ordinary replies become scrubbed withheld tombstones with a transactional incident outbox

The default stale threshold is 24 hours (`staleEscalationAgeMs`). On every
recovery tick, before redelivery, the sentinel opens or resumes one durable stale
episode in the same SQLite database. The episode captures one immutable
generation cutoff, an opaque random episode id, the total stale count, affected
topic count, and oldest/newest timestamps before any transition. It processes at
most 1,024 rows per tick in indexed pages of 256 and keeps the same episode across
pages, concurrent kicks, and restarts.

A row is stale when:

- it is outside the `reap-notify:` range;
- its state is `queued`, or it is `claimed` with a syntactically valid,
  demonstrably expired lease;
- `attempted_at` is older than the threshold; and
- its scheduled hold is absent, also older than the threshold, or beyond the
  existing seven-day corruption clamp.

Malformed/invalid timestamps or leases are `unknown`, never proof of staleness;
they stay untouched and increment a corruption counter. The stale projection
does not select `text` or `error_body`.

For each stale row the transaction re-evaluates the full observed predicate,
including the exact `state`, `claimed_by`, `attempted_at`, and
`next_attempt_at` values. The sentinel takes the existing compare-and-swap claim,
then moves it to the new terminal state `stale-withheld`. In the same transaction
it:

- clears `claimed_by` and `next_attempt_at`;
- replaces the message body with a fixed `<stale-withheld>` tombstone and clears
  `error_body` so historical sensitive content is not retained;
- appends the metadata-only reason `stale-undelivered`; and
- inserts one metadata-only `stale-backlog` record into a new
  `relay_incident_outbox` table keyed by the durable episode id.

The outbox insertion and the first page of terminal transitions commit atomically.
If either fails, neither becomes visible. Later pages reuse the same outbox row;
the episode closes only when no rows inside its immutable generation cutoff
remain. A crash after terminalization cannot lose the alert because the SQLite
outbox remains claimable.

The existing destructive restore purge is removed. `stale-withheld` tombstones
are retained for 30 days, then purged by the bounded terminal-retention pass.
Older binaries treat the unknown string as non-claimable and therefore safe.
Non-claimable states—including
`superseded-resent-directly`, even though older binaries do not know that string
in their TypeScript union—are outside every mutation predicate.

The incident-outbox drain creates one aggregate HIGH attention item containing only:

- stale row count;
- distinct affected-topic count;
- oldest and newest attempted timestamps; and
- the plain-English consequence: the messages were not delivered and were held
  back because delivering them now could be misleading.

No delivery id, topic-by-topic list, message excerpt, error body, or secret is
included. The attention id is a domain-separated opaque episode id, not a hash
published from a delivery identifier. After the Attention store durably accepts
that same id, the relay transaction marks the outbox row accepted. A crash
between the two writes replays the same id; Attention's idempotency contract
deduplicates the identical payload. A genuinely later stale generation opens a
new episode only after the prior generation closes.

This is a data-loss class, so P22's critical exception applies: notify and
terminalize on the same detection tick. There is no safe self-heal that can make a
weeks-old conversational reply timely again.

### 3. Queue health is measured every tick and alarms only after bounded recovery

`PendingRelayStore` exposes indexed aggregate queries for ordinary rows:
total nonterminal depth, held depth, live-claimed depth, due/recoverable depth,
oldest due attempted time, and stale depth. Alarm authority uses only
due/recoverable rows; future holds and active claims are reported separately and
cannot trigger. Queries never load message bodies. The schema adds an index over
ordinary state/attempt time; an `EXPLAIN QUERY PLAN` contract test rejects an
unindexed sort/scan regression at the 10,000-row/50MB store ceiling.

The health tick first snapshots, requests/coalesces one normal drain, then
remeasures. A durable queue-health episode begins from that post-drain snapshot
when due/recoverable depth is at least 10 or oldest due age is at least 5 minutes.
It stores `firstObservedAt`, stable opaque id, baseline depth/age, and
non-improving count in SQLite. “Improvement” means due depth decreases or the
prior oldest due row leaves the due set.

The operator attention path is unreachable until the named fast-heal phase is
exhausted:

- three consecutive 60-second post-drain snapshots fail to improve; or
- 15 minutes elapse from `episode.firstObservedAt`.

Then one NORMAL attention outbox record is inserted and later accepted by the
shared Attention hub. The item states the origin agent/machine, due depth, oldest
age, that the fast recovery phase was exhausted, and the action: “Reply ‘check
pending replies’ and I’ll inspect the delivery path.” Slow policy retries may
continue, but operator notification is downstream of fast-heal exhaustion. The
episode latch closes when due depth returns to zero; the already-created operator
item is never auto-resolved. A later episode gets a new id.

P19 brakes:

- `max-attempts`: three non-improving ticks before the ordinary raise;
- `max-wall-clock`: 15 minutes before the latency backstop;
- `backoff`: 60-second health cadence plus existing policy backoff per row;
- `dedupe-key`: persisted opaque episode id;
- `breaker`: the existing sentinel escalation breaker, with the queue alarm
  remaining observable even while redelivery is suspended;
- `max-notification-latency`: 15 minutes from first post-drain detection;
- `audit-location`: queue health counters and metadata-only sentinel events;
- `remediation-actions`: claim, identity-check, tone-check, redeliver, and verify
  the terminal response using existing fenced/idempotent paths;
- compensation: failed sends release the row to `queued` with policy backoff;
  CAS and delivery-id dedupe prevent double delivery.

### 4. Autonomous orphan detection is independent of queue actuation pause

Both the live-session snapshot and `queuePaused()` become tri-state evidence.
Unreadable/uninitialized live-session evidence is `unknown` and cannot establish
“no live session.” Pause `unknown` blocks actuation but does not erase an
otherwise grounded orphan observation. `queuePaused()` moves from top-of-loop
candidate suppression to the final common actuation gate, after authoritative
candidate checks, debounce, pressure/quota/session/migration gates, resume UUID,
cwd, and binding resolution.

In dry-run:

- a dead active run is observed and debounced even while ResumeQueue is paused;
- the reconciler emits one `would-respawn` transition per orphan episode with
  `actuationBlocked: "resume-queue-paused"`;
- `wouldRespawnTotal` and `blockedQueuePausedTotal` each increment once for that
  episode and are exposed by
  `GET /autonomous/liveness`;
- no claim, spawn, queue mutation, or pause mutation occurs.
- repeated paused ticks update duration only; they do not emit another decision,
  record a shadow redie, or consume the dry-run respawn cap.

In live mode:

- the same state is observed and retained;
- after debounce it enters explicit condition `blocked-queue-paused`;
- no respawn occurs while the pause remains authoritative;
- the observation is not deleted, so unpausing permits the next tick to proceed
  without restarting the evidence window.

Pause evidence `unknown` produces `blocked-queue-state-unknown`, never a respawn.
When a pause clears, retained debounce evidence may avoid a new wait, but the
actuation instant must re-read: queue pause, generation, operator stop, live
session, ownership, lease, in-flight spawn, quota/session/migration, resume UUID,
cwd, and binding. Any unknown/disqualifying value aborts.

An operator stop, per-topic pause, move, owner/lease loss, or completed run remains
an authoritative disqualifier and resets observation exactly as before. This
change does not auto-resume the ResumeQueue and does not weaken its emergency
pause; it prevents that brake from erasing evidence about a separate desired-vs-
actual contradiction.

The exact regression fixture uses:

- run start `2026-07-23T17:36:09Z`;
- session age-limit reap at `2026-07-24T14:36:00Z`;
- run end `2026-07-24T17:36:09Z`;
- ResumeQueue paused with reason `autonomous stop-all`;
- no live topic session until `2026-07-24T15:36:00Z`;
- dry-run ticks on the production cadence/debounce.

It must produce a would-respawn decision during the gap and a recovered-live
follow-up when the session reappears. <!-- tracked: CMT-1002 -->

### 5. Attention creation becomes a persist-first canonical pipeline with a restart-owned drain

`TelegramAdapter` gains a synchronous durable-acceptance seam:

1. validate/deduplicate the id;
2. construct the OPEN item;
3. insert it into the in-memory map;
4. synchronously serialize, write a same-directory temp file, `fsync` it,
   rename it, and `fsync` the parent directory;
5. only then begin Telegram routing.

The in-memory insert is rolled back if any persistence step fails; routing does
not start and the HTTP route returns `503 attention-persistence-unavailable`.
The existing event-loop/synchronous writer is the single serialization owner.
Same id plus byte-identical canonical payload is idempotent; same id with a
different payload returns `409 attention-id-conflict`.

Newly accepted items carry durable routing fields:
`deliveryState: pending|sending|delivered|ambiguous|exhausted`,
`deliveryAttempts`, `nextDeliveryAttemptAt`, and a lease token. Existing legacy
items without these fields are not retroactively delivered.

Two public contracts sit on that seam:

- `createAttentionItem(...)` preserves the existing internal contract: it accepts
  durably, asks the drain to attempt routing, awaits that real attempt, and
  returns the enriched item.
  Existing callers/tests that need `topicId` continue to work.
- `enqueueAttentionItem(...)` is the HTTP/monitor contract: it accepts durably,
  starts routing in the background, and returns the accepted item immediately.

An `AttentionDeliveryDrain` is the one lifecycle owner. It performs an immediate
startup scan and a 30-second watchdog, claims due `pending` items with a lease,
and routes at most four concurrently. The underlying Telegram API already aborts
non-polling fetches after 15 seconds; the drain keeps the single-flight guard
until the real promise settles. It never uses `Promise.race` to release ownership.

- A definitely pre-send/connect failure returns to `pending` with exponential
  backoff.
- A timeout, process death while `sending`, or send-success/persist-failure is
  `ambiguous`: Telegram may have accepted it, so automatic retry is forbidden.
- A confirmed Telegram response is `delivered` with `topicId`/`coalesced`.
- Six definite failures or 24 hours becomes `exhausted`.

Ambiguous/exhausted items remain visible in the dashboard and emit a deduplicated
degradation record; they never recursively create another attention item. The
drain has a global concurrency cap of four, maximum six attempts, exponential
backoff capped at one hour, 24-hour wall clock, one breaker event after sustained
failure, and a 30-second floor. It is registered in
`docs/canonical-pipelines.json` as accepted intake with a real operated cadence.

`POST /attention` adds strict caps for every accepted string, retains the existing
request/body/admission rate limits, and enforces an Attention store ceiling of
10,000 items or 20MB after pruning DONE/WONT_DO items older than 30 days. The
ordinary Telegram path calls `enqueueAttentionItem` and returns `201` within
250ms after the tone/admission gates have completed. Its additive response fields
are `accepted:true` and `deliveryStatus:"pending"`; `topicId` is optional and no
remote-visibility claim is made. Existing vocabulary aliases remain unchanged.

The 250ms SLO is intentionally scoped to the ordinary post-gate Telegram branch.
The LLM-backed tone authority and special Threadline redirect retain their
existing bounded/ambiguous contracts and are measured separately; no claim is
made that those external branches complete within 250ms.

The relay incident-outbox drain uses this same acceptance contract. It marks its
SQLite outbox row accepted only after the Attention file fsync succeeds, closing
the recursive failure where a delivery alarm could itself wedge or disappear.

### 6. Alternatives considered

- **A generic job/workflow engine:** rejected for this amendment. Relay recovery
  requires SQLite row fencing, identity/tone revalidation, and delivery-id
  semantics; Attention routing requires hub/coalescing state and an
  ambiguous-send terminal. Flattening both into one abstraction would hide
  domain guarantees. Both instead implement the same audited
  detect→claim→attempt→verify→retry/finalize lifecycle and register as canonical
  pipelines.
- **Fire-and-forget after JSON persistence:** rejected because crash-after-accept
  recreates Incident A.
- **Late delivery of every historical reply:** rejected by the operator's
  explicit ~24-hour stale policy and the risk of presenting obsolete work as
  current.
- **Cross-machine replay of pending relay bodies:** unchanged from the original
  operator-approved design; see the exception in Multi-machine posture.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Whether `NULL next_attempt_at` is due | `invariant` | SQL scheduling semantics: absent schedule means no hold. |
| Whether a >24h conversational reply is redelivered | `judgment-candidate → principal-resolved policy` | The user explicitly chose ~24h stale escalation rather than weeks-late redelivery. Runtime implementation is deterministic. |
| Default activation / legacy false migration | `judgment-candidate → principal-resolved policy` | The user required structural recovery; deny-wins preserves explicit false while omitted defaults to recovery. |
| Stale terminal state, scrub, and 30-day retention | `judgment-candidate` | Floor: never call a withheld message delivered, never retain its body indefinitely, never silently delete the audit. The bounded policy is `stale-withheld` + scrubbed tombstone + 30 days. |
| Page and incident aggregation | `invariant` | The user required ONE aggregate. A persisted generation/episode is the structural implementation. |
| Whether an ordinary queue episode notifies | `judgment-candidate → principal-resolved policy` | The bounded floor is named fast-heal first, three non-improving ticks or 15m maximum latency, one aggregate item. |
| Whether an autonomous orphan is a candidate | `invariant` | Existing authoritative conjunction: active/current/not-stopped/owned/lease-held/no-live/not-inflight/unambiguous. |
| Whether a paused queue permits respawn | `invariant` | Never actuate while the explicit global pause holds; detection remains allowed. |
| Whether an attention HTTP request succeeded | `judgment-candidate → principal-resolved contract` | The conditional attention fix is in scope. 201 means fsync-backed local acceptance only; remote delivery is separate and cannot be inferred. |
| Attention timeout/retry disposition | `invariant` | An unknown remote outcome is ambiguous, never failure-shaped and never automatically retried. |
| Attention routing lifecycle owner | `invariant` | Accepted canonical intake must have exactly one startup/cadence drain. |
| User-facing wording | `judgment-candidate` | Fixed templates are code-reviewed policy. Floor: plain English, CTA, bounded metadata, no row text. |

## Frontloaded Decisions

1. The ordinary relay monitor resolves to `recover` by default; explicit legacy
   `enabled:false` migrates to master `mode:"off"` and remains deny-wins.
2. Stale means 24 hours and results in a scrubbed `stale-withheld` tombstone plus
   transactional incident outbox, not late delivery or success-shaped escalation.
3. Queue fast-heal observation begins at due depth 10 or oldest due age 5 minutes;
   operator attention follows three non-improving one-minute ticks or 15 minutes
   from first detection.
4. ResumeQueue pause blocks liveness actuation, not liveness detection.
5. `POST /attention` acknowledges fsync-backed local acceptance and never waits
   for Telegram completion; a restart-owned drain owns later routing.
6. Ambiguous Telegram outcomes are not automatically retried.
7. Stale tombstones retain metadata for 30 days; accepted Attention items are
   bounded by a 10,000-row/20MB store ceiling and terminal retention.

These choices touch durable side effects and a published HTTP contract and are
therefore not tagged cheap-to-change-after. They are authorized by the user's
explicit fix directive recorded in frontmatter.

## Open questions

*(none)*

## Multi-machine posture

- Pending relay rows: `machine-local`.
  `machine-local-justification: operator-ratified-exception` — the original
  operator-approved Telegram Delivery Robustness design at commit
  `f9b5e3bb15a615b2960bae6bd25bcbd763d29b56` explicitly excludes queue files
  from backup/replication and forbids cross-machine replay. This amendment does
  not silently widen body replication or identity authority. Consequence stated
  honestly: an offline origin cannot recover its local row until it returns;
  peers may show replicated health/attention state only after the origin emits
  it. A future unified body-transfer design requires its own identity,
  idempotency, and privacy review.
- Queue-health and stale attention items: `unified` at the user surface through
  the existing attention-pool merged read. The originating machine persists and
  sends one item; peers proxy/merge it rather than independently alarming.
- Autonomous liveness condition: `machine-local`.
  `machine-local-justification: operator-ratified-exception` — the approved
  Autonomous Liveness Reconciler at commit
  `08bb1b32ea457d84423d2f9ee36f41b09e85a0cf` defines condition/cap state as
  machine-local and lease/owner gated. Live sessions and the ResumeQueue pause
  are local physical-machine evidence; “global pause” in this spec means global
  to that machine's ResumeQueue, not fleet-global.
- Autonomous run desired state follows the existing local authoritative vantage
  plus replicated ownership/lease evidence; this change adds no new copy.
- Attention persistence: `proxied-on-read` through the existing Attention pool.
  Writes stay on the accepting machine; the dashboard merged read prevents a
  split user view while that origin is online. During an origin partition the
  view is explicitly eventual, not falsely called unified; the origin's restart
  drain resumes routing when it returns.

## Security and privacy

- No stale/backlog notice contains message text, hashes, delivery ids, error
  bodies, auth data, or a per-topic inventory.
- CAS claim fencing remains the only state-transition authority; live claims
  cannot be stolen by stale classification.
- The `reap-notify:` prefix boundary is enforced in SQL, not caller etiquette.
- Episode ids are random/domain-separated and do not expose delivery identifiers.
- Persist-first attention does not weaken route authentication, admission,
  outbound tone authority, or Threadline special routing.
- Attention persistence failures return non-success and roll back publication.
- Same-id/different-payload conflicts are rejected.
- Attention routing is fenced, globally capped, and ambiguous outcomes cannot
  overlap automatic retries.

## Observability

- Sentinel tick/status: ordinary total/held/live-claimed/due depth, stale count,
  oldest due age, master mode, consumer availability, episode/non-improving
  state, outbox depth, and last alarm time.
- Sentinel audit: stale batch count/timestamps/topics and queue alarm lifecycle,
  metadata only.
- Liveness status: `wouldRespawnTotal`, `blockedQueuePausedTotal`,
  `blocked-queue-paused`, and `blocked-queue-state-unknown`.
- Attention item is queryable immediately after HTTP 201 with an honest durable
  delivery state; drain status exposes pending/sending/ambiguous/exhausted,
  oldest age, attempts, and last tick.
- No metric equates durable acceptance with remote delivery.

## Testing plan

### Tier 1 — unit

- Store selector proves `NULL` schedules are due and prefix ownership is
  complementary.
- Stale classifier fences queued and expired-claim rows, skips active claims,
  malformed/unknown claims, future holds, `reap-notify:`, and
  `superseded-resent-directly`; full observed-field CAS races are covered.
- Queue-health aggregation distinguishes due/held/live-claimed, uses the index,
  and loads no body.
- A 10,000-row/multi-page/restart stale fixture produces one persistent episode,
  one outbox item, scrubbed tombstones, and no send.
- Queue alarm is unreachable on first recoverable detection, fires after bounded
  post-drain non-improvement/latency, survives restart, deduplicates, and resets
  its internal episode after recovery.
- Liveness exact timestamps plus paused queue produce `would-respawn`,
  both counters `=1`, no cap consumption/respawn, then recovered-live follow-up; <!-- tracked: CMT-1002 -->
  pause/live-snapshot unknown boundaries never actuate.
- Persist-first attention tests cover write/rename/fsync failure rollback,
  conflicting id, body/row/byte caps, and a blocked Telegram transport.
- Attention drain tests cover crash after accept, stale `sending → ambiguous`,
  timeout-late-success, definite retry, permanent rejection, breaker/cap, global
  concurrency, and restart.

### Tier 2 — integration

- PostUpdateMigrator covers omitted, explicit false, explicit true, and already
  migrated modes idempotently.
- AgentServer with omitted delivery-sentinel config starts the ordinary monitor
  and drains a copied production-shaped SQLite fixture containing
  `next_attempt_at=NULL`.
- A 25-hour fixture terminalizes into one attention item and never calls the
  Telegram reply transport; a fresh row redelivers.
- `POST /attention` ordinary post-gate path with a never-resolving Telegram send
  returns 201 within 250ms and `GET /attention/:id` immediately returns the item;
  persistence failure is 503 and id conflict is 409.
- Liveness route exposes the paused-queue blocked condition and
  both dry-run counters; pause/live-session read errors block actuation.

### Tier 3 — E2E lifecycle

- Hard-restart lifecycle: enqueue an ordinary row during HTTP 503 warming,
  restart with omitted legacy flag/migrated recover mode, and prove the fresh row
  reaches the real local recovery endpoint while stale companions transactionally
  become one aggregate outbox/attention across another crash.
- Autonomous incident lifecycle reproduces the 14:36Z reap, old global pause,
  hour-long no-session gap, and 15:36Z return through production wiring.
- Attention lifecycle crashes after HTTP acceptance, restarts the production
  adapter/drain, and proves pending delivery resumes; a crash while sending
  becomes ambiguous and is not duplicated.
- Canonical-pipeline positive control asserts startup plus operated cadence for
  both ordinary relay and accepted Attention intake.

### Deployed Test-as-Self proof

- Before mutation, inventory every local agent store and record metadata-only
  checksums/counts; snapshot Echo's 33 queued rows and the
  `superseded-resent-directly` row.
- Use copied production metadata fixtures for destructive proof. Use a fresh,
  isolated real Telegram test topic for one NULL-scheduled recovery and one
  Attention route; never send historical bodies.
- On Echo after deploy, prove: the superseded row checksum is unchanged; >24h
  rows are `stale-withheld` without reply sends; exactly one aggregate Attention
  item exists; a fresh synthetic row delivers once; liveness status observes the
  exact paused incident; ordinary attention acceptance stays under 250ms.
- Inventory Bob and Instar-codey before their updater applies the new mode and
  verify the same no-late-send boundary after update.

## Side effects and rollback

- Default activation can increase recovery traffic on agents that previously
  accumulated inert queues. Migration preserves explicit false/off. The
  24-hour stale split, 1,024-row tick cap, per-topic rate cap, CAS,
  tone gate, delivery-id dedupe, and circuit breaker bound that burst.
- Master `mode:"observe"` is a read-only operational rollback; `"off"` stops the
  loop. Neither mutates rows or sends alarms.
- Reverting the stale policy does not resurrect terminal `stale-withheld` rows; this
  is intentional because their timeliness window has expired.
- Persist-first items appear in the dashboard before Telegram has posted them.
  The additive delivery state describes that honestly. A downgrade ignores the
  optional fields and never retries them; the upgrade migrator is idempotent.

## Acceptance criteria

1. A production-shaped ordinary queued row with `next_attempt_at=NULL` is selected
   and recovered when the config omits the former Layer-3 flag.
2. A row older than 24 hours is never sent or deleted, becomes terminal with a
   `stale-withheld` reason/body scrub, and contributes through a transactional
   outbox to exactly one metadata-only attention item across pages/restarts.
3. A `superseded-resent-directly` row is byte-for-byte unchanged.
4. Due queue accumulation crosses a persistent deterministic alarm path after
   bounded fast-heal and cannot silently remain at depth 33; legitimate holds and
   live claims do not false-positive.
5. The exact 14:36Z–15:36Z dead-active sequence emits a dry-run would-respawn
   despite the old global queue pause, while live mode still does not actuate
   under that pause.
6. `POST /attention` returns after fsync-backed local acceptance while Telegram
   is indefinitely stalled; the item is immediately readable and a restart-owned
   bounded drain later routes or truthfully terminalizes it without duplicate
   sends.
7. All three test tiers, typecheck, lint, side-effects review, full repository
   suite, and independent security/integration/correctness reviews are green.
