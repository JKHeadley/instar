---
title: "A send held for a lapsed lease renewal is retried within seconds, named, logged and counted"
slug: "lease-freshness-lapse-retry"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
parent-spec: "docs/specs/telegram-message-origin.md"
eli16-overview: "docs/specs/lease-freshness-lapse-retry.eli16.md"
lessons-engaged: "fb-20393429-c92 (N71, topic 145840 post-mortem), incident_laptop_stall_lead_grab_and_observe_only_stopgap, incident_wedge_sentinel_1ms_tick_telegram_holds, feedback_delivery_and_cost_outrank_gate_strictness, No Silent Degradation, Signal vs Authority, Self-Heal Before Notify (P22), No Unbounded Loops (P19), Verify the State Not Its Symbol (P20)"
tier: 1
clean-door-anthropic-review: "claude-code:claude-fable-5"
approved: true
approved-by: "echo, under the operator's standing rule (Justin, 2026-10-22 08:58 PDT: \"I should ONLY have to approve constitution changes\") and Approval Only Where Required; the change is post-mortem item N71 (topic 145840), assigned by the run lead with the Chief of Staff's direction to keep it small and keep the fence; no constitution or CODEOWNERS path touched; the convergence report (docs/specs/reports/lease-freshness-lapse-retry-convergence.md), including its round-3 findings resolved in the final edit, was read before approval"
review-convergence: "2026-11-21T20:01:34.428Z"
review-iterations: 3
review-completed-at: "2026-11-21T20:01:34.428Z"
review-report: "docs/specs/reports/lease-freshness-lapse-retry-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# A send held for a lapsed lease renewal is retried within seconds, named, logged and counted

## Problem statement

Post-mortem item N71 (topic 145840; feedback fb-20393429-c92). On 2026-11-21 eight Telegram bot sends on the
Echo Studio were refused locally with the hold reason `credential-capacity-unavailable` while traffic was about one
send per second, far under the ten-sends-per-window cap that reason is named for. The origin store
(`telegram_origin_outcome_details`) carries the eight refusals; nothing in the server log says why they happened,
and the held replies were sent minutes later by the recovery schedule.

Terms used below. The **lease** is the multi-machine lead: the one machine allowed to talk to Telegram for this
agent. **Holding** the lease means `LeaseCoordinator.holdsLease()` answers true. The coordinator attempts a renewal
every half lifetime (`clamp(ttl × 0.5, 5 s..60 s)`, 30 s at the default 60 s lifetime `ttlMs`). `holdsLease()`
answers false for exactly one of four reasons, checked in this order: the coordinator **self-suspended**; the
current view does **not show this machine as the holder at the current epoch** (another holder, a stale epoch, or a
record that does not verify); the lease **ran out without a confirmed renewal** (its wall-clock expiry passed, or
more than one lifetime has passed on the monotonic clock since the last confirmed renewal: together the **renewal
fence**, since the ordinary late renewal trips the wall clock a hair before the monotonic check); or a peer's
verified acknowledgement reported a **higher epoch** (superseded). A fenced
holder holds again when it re-acquires cleanly or a late renewal confirmation lands. The **send capacity**
(`OriginEgressCapacity`) is the one in-memory authority, per credential-owner process, that grants each outgoing
Telegram request a short start permit at the network boundary. It refuses a permit, checking in this order, when the
owner is **closed**, **not ready** (first 1.25 s after boot), when the machine does **not hold the lease**
(`ownsLease()` false), when the account is **unknown**, when a lease or account reader **throws**, or when the rolling
**rate window** (ten starts per 1.25 s) is full. A granted permit can also **expire** (250 ms) before or during its use, and `consume()` re-checks
liveness. Every one of these is thrown as `OriginCapacityUnavailable`, whose only text is
`credential-capacity-unavailable`, so the record cannot distinguish them.

**Which process this concerns.** The capacity owner is the process that owns the Telegram poll. On an agent where
the Lifeline holds the poll-owner lease file, the Lifeline's capacity `ownsLease()` is its own polling state and the
configuration flag `multiMachine.telegramPolling` (`TelegramLifeline.ts:491`, `telegramPollOwnership.ts:28`), not
the lease coordinator, and the server reaches it as an IPC client. On an agent where the server owns the poll (no
Lifeline poll-owner lease file, which is the Echo Studio's state), the server's capacity `ownsLease()` IS
`MultiMachineCoordinator.holdsLease()`. This change names and shortens the lease-related refusals of that
server-owner path; the IPC client path keeps today's unexplained refusal (Frontloaded Decision 6).

**The hypothesis the records support but cannot prove.** `holdsLease()` returns false the moment more than one
lifetime has passed since the last confirmed renewal, even while this machine is the uncontested holder. One delayed
renewal alone does not cross the fence: a renewal confirmed at 0 s and the next delayed from 30 s to 35 s leaves 25 s
of lifetime. Crossing it takes a stall longer than the remaining headroom (about 30 s), or one unconfirmed renewal
followed by a late one. Both shapes were present on 2026-11-21 (main-thread stalls of minutes were recorded on the
pool that day: incident_laptop_stall_lead_grab_and_observe_only_stopgap), and the lease headroom is exactly one
missed renewal. The eight rows do not say which cause refused them; this change makes the cause measurable (the
coordinator's own verdict, the new reasons and the logged gap) so the next lapse is a fact, not a guess. Treating
the symptom this way is a deliberate choice (Frontloaded Decision 8); the headroom question itself is filed.

Each refused send is today:

- recorded as `known-failed` / `credential-capacity-unavailable` with its next attempt 30 s away
  (`nextOriginLocalRefusal`, the first rung of `BACKOFF_SCHEDULE_MS`); the transport attempt budget is not charged;
  the operation row stays `admitted` with a `queued` child;
- picked up by the recovery pass (`TelegramOriginRuntime.recoverHeld`, run every 30 s by the delivery-failure
  sentinel), which reserves a recovery attempt and advances the per-operation review ladder
  (30 s, 60 s, 2 min, 5 min, then 15 min) whether or not the lease is back;
- reported to the user at once as "a reply needs delivery attention" (the `onSessionDeliveryHeld` live notice fires
  for every session hold reason except `lease-not-held`, `destination-not-authorized` and
  `original-operation-unresolved`); that notice is itself a send through the same refused capacity, so it is held as
  server automation and lands later, stale, after the reply it warned about;
- never logged: the server log holds no line for it.

The fence is correct and stays. What is wrong is the naming, the silence, a notice that fires before any self-heal,
and a retry cadence that treats a seconds-long lapse like a sustained outage.

## Proposed design

Three small changes, all on the machine that refused its own send. None of them lets a send go out while
`holdsLease()` is false.

### 1. Name the refusal by its cause, captured in the refusing decision

- `LeaseCoordinator` gains two read-only readers beside the existing `msSinceConfirmedRenewal()`:
  `holdVerdict()` returns which check answered (`holding`, `suspended`, `not-current-holder`, `renewal-lapsed`,
  `superseded`) in the exact order `holdsLease()` evaluates them, and `renewalFreshness()` returns
  `{ msSinceConfirmedRenewal, ttlMs, verdict }`. `MultiMachineCoordinator.leaseFreshness()` surfaces it (null without
  a lease coordinator). Nothing in the fence changes.
- `OriginEgressCapacity` gains `reserveExplained(accountId)`, which evaluates liveness and the window **once** and
  returns either the grant or the cause it refused for: `owner-closed`, `owner-not-ready`, `lease-not-held`,
  `account-unknown`, `owner-check-failed` (a reader threw) or `rate-window-full`, in that precedence (the order
  `#live()` already evaluates, then the window). `reserve()` becomes `reserveExplained()` without the cause, so its
  contract and fail-closed answers are unchanged. **One snapshot:** where the host provides a freshness reader
  (`leaseFreshness` option), the lease check IS that reader: permission is `verdict === 'holding'` and the cause's
  freshness is the same sample, so a flip between two reads cannot pair cause `lease-not-held` with verdict
  `holding`. The reader walks the coordinator's view once, exactly as `holdsLease()` does, so the hot path pays no
  second walk. Without a reader (the Lifeline, tests) `ownsLease()` is read and the refusal carries null freshness.
- `OriginCapacityAuthority` gains `reserveExplained` as an optional method. The egress (`OriginBotEgress`) calls it
  when present and falls back to `reserve()` otherwise (the IPC client). The refusal it throws is the one from that
  evaluation: the request-bound proof is set on the thrown `OriginCapacityUnavailable` itself, never on a fresh one,
  so its `refusal` field survives to the send site. The two post-grant refusals the egress makes (`grant-expired`
  when the 250 ms permit ran out before or after `consume()`, `consume-refused` when `consume()` re-checked liveness
  and said no) are explained with those causes but stay under the old durable name: they mean the lease or the
  window moved within a quarter second of a grant, which is not the lapse being named.
- At the send site (`TelegramOriginService`, the local-refusal branch), the durable outcome reason is written from
  the observed state:
  - **`lease-freshness-lapsed`** when the cause is `lease-not-held` AND the coordinator's verdict in the same read is
    `renewal-lapsed`: the renewal fence is what refused.
  - **`lease-not-held-at-send`** when the cause is `lease-not-held` and the verdict is anything else (superseded,
    suspended, not the current holder: a real loss between `authorize` and the boundary) or there is no reader.
  - `credential-capacity-unavailable` for every other cause, the two post-grant causes, and an unexplained refusal.
    Those are not the defect being named: owner state is visible in `/health → telegramOriginStorage`, the rate
    window is the cap the name was coined for.
- The two new reasons plus the old one form `ORIGIN_LOCAL_REFUSAL_REASONS`; the two new ones alone form
  `ORIGIN_LEASE_REFUSAL_REASONS`. `credential-capacity-unavailable` stays accepted everywhere it is matched today.
  The store's local-refusal write (`recordOutcome` with `localRefusal: true`) accepts any reason in the list,
  `TelegramAdapter.OWNER_DM_RETRIED_HOLDS` lists all three, and the existing lists-in-sync unit test asserts
  `OWNER_DM_RETRIED_HOLDS ⊇ RECOVERABLE_HOLD_REASONS ∪ ORIGIN_LOCAL_REFUSAL_REASONS`. `RECOVERABLE_HOLD_REASONS`
  (the in-memory replay list) is unchanged: like `credential-capacity-unavailable`, the new reasons are replayed from
  their durable row by the recovery pass (`takeRecoverableAdmissions`), never from the memory buffer, so an admitted
  operation is never re-admitted. The notice lane (`TelegramOriginOutageNotifier`) keeps the old name for its own
  requeue; it is not a session reply.
- **The lease reasons join the sticky lease-held set.** `#hold` adds an operation held for a lease reason to
  `#leaseHeldIds` exactly as it does for `lease-not-held` (and `wasLeaseHeldInMemory()`'s past-the-cap fallback
  matches the lease reasons too), so the §2(b) age bound (`staleAtSendSite`, 30 minutes from first preparation)
  covers a reply refused at the boundary the same way it covers one refused at `authorize`: a machine that never
  regains the lease hands the reply back at 30 minutes with the existing hand-back item and session line, not at the
  6-hour deadline. After a process restart the memory set is empty, so a lapse hold younger than 30 minutes at
  restart is on today's path (the deadline), the same as any capacity hold today; the durable marker is written only
  once a row is found stale.
- **One log line per lease refusal**, at the send site:
  `[telegram-origin] <reason>: held <operationId> at the network boundary; lease verdict <verdict>, <gap> ms since
  the last confirmed lease renewal (lease lifetime <ttl> ms) — retried within seconds once the lease is held again`,
  with `lease verdict unknown, renewal gap unknown` when there is no reader. The line carries the operation id, the
  verdict and the two durations and nothing else: no token, no chat id, no text.
- The second capacity hold site, where a granted permit expired before the request started (`prepared.valid()`
  false, no outcome row, claim released), keeps its in-memory reason but logs one line
  (`[telegram-origin] credential-capacity-unavailable: start permit expired before send for <operationId>`), so
  the cause incident_wedge_sentinel_1ms_tick_telegram_holds measured as the commonest one stops being invisible.

### 2. Retry within seconds once the lease is held again, gated on the lease

- `OriginRetry` gains `LEASE_LAPSE_RETRY_SCHEDULE_MS = [2000, 5000, 10000, 30000]` and
  `nextOriginLeaseLapse(now, deadlineAt)` = `now + 2000` bounded by the operation's deadline (undefined past it,
  exactly like `nextOriginLocalRefusal`). A lease-reason outcome is written with that next attempt, so the durable
  row is eligible again in 2 s instead of 30 s. The transport attempt budget is not charged (the existing
  `localRefusal: true` rule); the deadline and maximum attempts are untouched. **A replay refused for the lease is
  paced the same way:** in the same `recordOutcome` transaction the store moves the operation's review-schedule row
  (`telegram_origin_recovery_schedule.next_attempt_at`, written at the 30 s rung by `reserveRecoveryAttempt`
  before the replay) to the same 2 s, keeping its attempt count. An attempt that never reached the network was not
  charged, so the ladder must not hold the row either; without this the second refusal would wait out the rung.
- The runtime (`TelegramOriginRuntime`) arms **one** bounded retry timer (an **episode**) when it sees a lease-reason
  hold (through the service's existing `onHold` callback). At each step the timer reads `holdsLease()`:
  - lease held → it runs the existing `recoverHeld()` pass; if a pass is already running it waits for that pass to
    end (`#passDone`, the seam the operator retire already uses) and then runs one, so a wake is never lost to a
    pass that had already taken its candidates. After the pass, if lease-reason holds remain in the service's
    in-memory hold map, the timer moves to the next step; when none remain it disarms. A replayed reply clears its
    in-memory hold: the direct replay sends through `telegramFetch` → `OriginBotEgress` →
    `service.executePreparedBot`, the method whose completion deletes the hold after the accepted outcome is
    recorded, so "none remain" is reached by delivery. A pass takes the rows due at or before its own clock, so a
    row due at exactly the step may land on the following step: replies held a moment apart (A at 0 s, B at 1.9 s)
    are both covered, B's row being due at 3.9 s and sent at the 5 s step.
  - lease still away → it moves to the next step (2 s, 5 s, 10 s, 30 s).
  - **The fourth step always ends the episode**, whatever it observed. If the lease was away it logs one line
    (`lease still not held after 47 s; the regular recovery pass takes over`); if holds remain with the lease held
    (more than ten due rows, or a late flip) it logs that the sentinel carries the rest. No attention item is raised
    at that point: a hold that persists is already reported by the existing five-minute durable scan, whose
    aged-`admitted` branch covers these rows and raises a **record-only** HIGH attention item (never a topic
    message), and the §2(b) bound hands the reply back at 30 minutes. The operator hears about a lease loss once,
    through those existing channels, and never about a two-second blip.
  - A new lease-reason hold while a timer is armed does not add a timer or reset the step. **Rolling wake budget:**
    at most four timer wakes per lease lifetime (the `ttlMs` from the freshness reader, or 60 s when there is
    none), whether or not a wake ran a pass; a new episode may start while wakes remain, and a hold that arrives
    with the budget spent waits for the sentinel pass. A flapping or absent lease thus costs at most four
    `holdsLease()` reads and at most four extra passes per lifetime on top of the sentinel's two, a bounded rate
    rather than a bound that grows. The timer is `unref`'d and cleared on `close()`.
- Inside `recoverHeld()`, a direct-path candidate whose in-memory hold reason (`service.heldReason`) is a lease
  reason first runs the §2(b) age check (`staleAtSendSite`, so a reply past 30 minutes is handed back even while the
  lease is away) and is then **skipped while `holdsLease()` is false**, before `markLateDirect` and
  `reserveRecoveryAttempt`, so neither a store write nor a review-ladder step is spent on an attempt certain to be
  refused at the boundary. This mirrors the existing `lease-not-held` branch, check for check. The in-memory reason is used rather than the durable outcome row
  because the candidate carries only its admission, and a restart (which empties the map) is followed by the
  coordinator's own re-acquire at boot; the restart case falls back to today's ladder. Once the lease is held, the
  candidate takes the ordinary replay path (claim fence, `authorize`, policy, capacity, transport) unchanged.
- **Honest bound.** "Within seconds" is the ordinary case, not a guarantee: after a `renewal-lapsed` verdict the
  coordinator is self-suspended and holds again on its 5 s pull tick or a late confirmation, so the 5 s step is the
  realistic first delivery, not the 2 s one; `takeRecoverableAdmissions` serves ten rows per pass in cursor order,
  so a backlog of more than ten due rows spreads over passes; a hold that arrives with the wake budget spent waits
  up to 30 s for the sentinel; and after the four steps the sentinel's 30 s pass is the floor.
- **No first-detection notice.** The two lease reasons join `lease-not-held` in the `onHold` exclusion from the
  live `onSessionDeliveryHeld` notice: a hold the runtime expects to clear in seconds must not post "a reply needs
  delivery attention" and open a HIGH attention item before any self-heal ran (Self-Heal Before Notify; the
  operator's standing rule that an over-eager hold notice IS the incident; the Needs-you list is for things the user
  acts on). A hold that outlives the retry reaches the operator through the existing five-minute durable scan
  (record-only item, deduplicated per operation, cleared on delivery) and the 30-minute hand-back.
- **Fallback.** Nothing else changes: the sentinel still runs the pass every 30 s, the durable row stays eligible, a
  process restart (which forgets the in-memory reason and the timer) leaves the row on today's path, and a reply
  whose lease never returns is handed back at the §2(b) bound or, after a restart, ages out at the 6-hour deadline
  exactly as a `credential-capacity-unavailable` hold does today.

### 3. Count each lease refusal in the never-silent record

- `NeverSilentStore` keeps a new list, `sendHolds[]`, in the same `never-silent.json` file beside `obligations` and
  `incidents` (the schema string is unchanged; `load()` only requires the two existing arrays and defaults a missing
  list to empty, so a file from before this change loads and an older reader keeps the list untouched and inert).
  The list counts **distinct replies held** (one row per operation id); the per-refusal record is the log line, so
  three refusals of one reply are one row and three lines. A send-hold row is
  `{ id, platform, conversationKey, operationId, reason, heldAt, deadlineAt, deliveredAt?, closedAt?, closedReason? }`.
  `recordSendHold(platform, conversationKey, { operationId, reason, heldAt, deadlineAt })` opens one (idempotent on
  the operation id). `recordSendHoldDelivered(operationId, deliveredAt)` closes it with
  `closedReason: delivered-after-hold` and `closedAt = deliveredAt`, matched by the durable operation id so a restart
  in between loses nothing; an id with no open row performs no write. An undelivered row past its operation deadline
  is closed as **`hold-unobserved-past-deadline`** (this store did not see a delivery; it does not claim there was
  none) at the next store write, and at `snapshot()` (which then flushes only if it closed something), so open rows
  stay bounded on a quiet agent too. Closed rows are kept seven days under their own cap (200, the figure the judged
  incidents already use; a dropped closed row is history, not state).
- Send holds are observability only. They are not incidents: the silence judge, the notices and the automatic
  actions never see them, `openIncident()` and `counts.openIncidents` are unchanged, and no `SilenceClass` is added.
  `GET /never-silent/incidents` gains `sendHolds` (the open ones under `?open=1`, else the last 200) and
  `counts.openSendHolds`. A conversation key of the form `chat:<chatId>` is never resolved to a session (the
  resolver reads only incident and obligation keys); it lives in the 0600 state file behind the authenticated route.
- **Delivery is bound to the recorded receipt.** `TelegramOriginService` gains an optional `onDelivered` callback
  fired at the completion of `executePreparedBot`, after `recordOutcome(accepted)` returned `recorded: true` and
  the in-memory hold is cleared (first sends and recovery replays both end there), never from a counter. The runtime
  forwards it to `sendHoldIncidents.delivered` for every completed operation.
- **Wiring.** The runtime option `sendHoldIncidents` (`held`, `delivered`) is assigned late by the server
  (`telegramOriginBoot.runtime.options.sendHoldIncidents = …`, the precedent being `readDetectorHealth`) right
  after never-silent is built, because the origin runtime boots before never-silent exists. The server-side
  recorder maps the destination to the never-silent conversation key the way the server already does for the
  delivery notice: the topic id (`1` for the general topic) for the main chat, the offset topic id for the issues
  chat, and `chat:<chatId>` for any other authorized destination (owner DM, demo chat), so every lease refusal is
  counted. The recorder no-ops while `monitoring.neverSilent.enabled` reads false; an unassigned option means the
  runtime records nothing (the route answers 503 in that case, which is "do nothing"). While never-silent is off the
  log line is the record. The Lifeline assigns nothing. A recorder failure is caught and logged; it can never change
  the send outcome.

### What does not change

- The fence: no send leaves a machine whose `holdsLease()` is false. The capacity still refuses; `authorize` still
  refuses; the retry only asks "is the lease held again?" before re-running the same gates.
- The rate window, the ten-per-window cap, the owner-boot binding, grant lifetimes, the IPC between server and
  Lifeline (the client keeps today's unexplained refusal).
- The review ladder values, `BACKOFF_SCHEDULE_MS`, the sentinel cadence, the 6-hour deadline, the attempt budget.
- `lease-not-held` (the pre-admission refusal when `authorize` sees no lease) and its durable `holdReason` path.
- The lease coordinator's renewal cadence and fence (Frontloaded Decision 8).
- The never-silent incidents, obligations, judge, notices and actions.

## Decision points touched

| Decision point | Classification | Basis and justification |
|---|---|---|
| The capacity refuses a grant while `ownsLease()` is false (unchanged; the cause is captured in the same evaluation) | invariant | basis: irreversible-consequence; evidence: a Telegram send from a machine that is not the lead cannot be recalled and produces the double voice the lease exists to prevent (docs/specs/telegram-message-origin.md binding 5); the change adds no path around the refusal |
| Durable reason from the observed state: `lease-freshness-lapsed` only for cause `lease-not-held` with coordinator verdict `renewal-lapsed`; `lease-not-held-at-send` for cause `lease-not-held` otherwise; `credential-capacity-unavailable` for the other five reserve causes, the two post-grant causes, the expired-permit site, and an unexplained refusal | invariant | basis: enumerable-domain; evidence: the refusing evaluation has six causes in a fixed precedence, the egress adds two post-grant causes and one pre-start site, and the coordinator names which of its four checks answered; each name states only what was observed |
| First retry at 2 s, then 5 s, 10 s, 30 s, then stop; at most four timer passes per lease lifetime | judgment-candidate | floor: the timer never sends, is bounded to four passes per lifetime, never resets on repeat refusals, and the 30 s sentinel pass remains underneath; arbiter: none needed, a static heuristic inside a complete floor; the 2 s first step is the time a late renewal confirmation needs to land once a stall ends, the 47 s total spans one renewal cadence (30 s) plus confirmation latency, after which the lease is either held (the sentinel pass finds it) or really gone |
| A lease-reason candidate is skipped in the recovery pass while the lease is away (after the §2(b) age check, before any store write or reservation), and the timer wakes the pass only when `holdsLease()` is true | invariant | basis: external-constraint; evidence: the capacity will refuse the same candidate at the boundary (`ownsLease()` is the same `holdsLease()`), so an attempt while the lease is away can only advance `RECOVERY_REVIEW_LADDER_MS` and spend a store transaction with no chance of delivery; the one-way read cannot send anything by itself |
| A lease-reason local refusal moves the operation's review-schedule row to the same 2 s next attempt, keeping its attempt count | invariant | basis: external-constraint; evidence: the review ladder paces attempts that reached the network; the existing `localRefusal` rule already declines to charge a refusal that did not, and a schedule row written before that refusal would otherwise hold the reply for the 30 s rung the refusal never earned |
| The two lease reasons are excluded from the first-detection live delivery notice; no new item is raised at episode end; the existing five-minute scan and the 30-minute §2(b) hand-back report a hold that persists | invariant | basis: external-constraint; evidence: the live notice is a send through the same refused capacity, so at first detection it is held by the same lapse and lands after the retry has already delivered the reply; the scan already raises the same record-only item id for a persisting row, so a second item at 47 s could only duplicate it |
| The lease reasons join the sticky lease-held set (`#leaseHeldIds`) | invariant | basis: enumerable-domain; evidence: the set means "this reply was held for the lease"; a boundary refusal for the lease is that fact observed one gate later than `authorize`, so excluding it would make the hand-back bound depend on which gate noticed first |

## Frontloaded Decisions

1. **Two new durable reasons, from the observed state, not five.** Only the lease cause is renamed, split by the
   coordinator's own verdict; `credential-capacity-unavailable` stays for the owner-closed, not-ready,
   account-unknown, reader-threw, rate-window, post-grant and expired-permit cases. The reason strings are a
   published interface (outcome rows, `GET /telegram/origins…`, the owner-DM outcome, `OWNER_DM_RETRIED_HOLDS`):
   every consumer matches by the shared list, and the old string stays accepted, so the change is additive rather
   than cheap.
2. **The retry is a timer inside the runtime that calls the existing pass**, not a second send loop and not a
   change to the sentinel's cadence. The pass stays single-flight and keeps every gate; the timer waits for a running
   pass instead of dropping its wake.
3. **Durable next attempt 2 s** for the lease reasons (today 30 s). The transport budget is still not charged; the
   deadline bound is kept.
4. **The log lines carry the verdict, durations and the operation id only.** No destination, no text, no token.
5. **Send holds are a list in the never-silent store, not incidents.** They share the file and the route, carry
   their own count and retention, and never reach the judge or the notices. `sendHolds` and `openSendHolds` are new
   published fields of `GET /never-silent/incidents`; the capability text for that route and the origin awareness
   text name the new reasons and the list.
6. **The Lifeline is unchanged in behavior**: its capacity reads its polling state and a configuration flag, not the
   lease, so the lapse cannot arise there; the server's IPC client in that deployment keeps the unexplained refusal
   and the old name. No send holds are recorded by the Lifeline.
7. **No in-memory delivery map.** Delivery is reported for every completed operation and matched by durable
   operation id in the never-silent store, so neither a restart nor a missed callback can turn a delivered reply into
   an "undelivered" record; what the store did not observe is closed as unobserved.
8. **Retry-after, not lapse prevention, in this change.** A shorter renewal cadence (ttl/3) or a synchronous
   renewal attempt at the boundary would shrink the lapse itself, but both change the lease coordinator's safety
   behavior (the subsystem #3612 just changed) and the second would put a network wait on the send path. The
   headroom question (one missed renewal) is filed to the feedback queue as its own item (fb-5422a875-8e4); this
   change makes the lapse measurable so that item has data.
9. **Exhaustion reaches the operator through the channels that already exist.** When four steps end with the lease
   still away, the runtime logs and stops; the five-minute durable scan raises its record-only item for the
   persisting row and the 30-minute hand-back follows. No new item and no topic message, because the only sender is
   the refused capacity (the message would land stale) and a per-reply item burst would be noise about one fact.
10. **Fixed limits** (judgment-candidates within the floors above, or inherited): the four-step schedule and the
    four-wakes-per-lifetime budget with its 60 s fallback lifetime (declared above); the 200-row retention cap for
    closed send holds (mirrors the existing judged-incident cap; a dropped closed row is history, not state); the
    deadline-based close of undelivered holds (inherits the operation's own 6-hour deadline).

## Verify the State, Not Its Symbol

| Detector / value | Symbol read | State claimed | Independent corroboration | When unmeasurable |
|---|---|---|---|---|
| Cause `lease-not-held` from `reserveExplained` | `ownsLease()` false in the evaluation that refused | this machine did not hold the lead at the boundary | the coordinator's `holdVerdict()`, read in the same evaluation, names which of its four checks answered, and the gap against `ttlMs` is logged beside it; `lease-freshness-lapsed` is written only for `renewal-lapsed` | no reader: reason `lease-not-held-at-send` (only the boundary fact is claimed), log says `lease verdict unknown, renewal gap unknown` |
| `holdsLease()` true at a retry step | the coordinator's fenced view | this machine may send | the recovery pass re-runs `authorize` and the capacity, which read the same fence at the moment of the send; a flip between the read and the send is refused again and the step simply continues | `holdsLease` not wired (option absent): treated as true, which is today's behavior for the pass |
| `delivered` close of a send hold | `onDelivered` at the completion of `executePreparedBot` | Telegram accepted the held reply | the service reaches that point only after `recordOutcome(accepted)` returned `recorded: true` for a correlated receipt (an unrecorded acceptance throws before it); first sends and recovery replays both end there | process restart between the receipt and the callback, or a delivery this store never saw: the row is closed at its deadline as `hold-unobserved-past-deadline`, never as delivered and never as undelivered |
| "No lease-reason holds remain" at a timer step | the service's in-memory hold map | every lease-refused reply was delivered, retired or expired | the map entry is deleted only at `executePreparedBot` completion (after the recorded receipt), by a retirement, or by the deadline prune of expired holds; a reply still queued keeps its entry | a restart empties the map: the timer is gone too, and the sentinel pass carries the rows |

## Multi-machine posture

- **Machine-local by design.** Each machine's send capacity, its refusals, its retry timer and its log lines describe
  that machine's own attempts against its own copy of the fence. The reply itself is already durable in that
  machine's origin store and follows the existing recovery, hand-back and forward paths, which this change does not
  touch.
  - machine-local-justification: physical-credential-locality
  - The Telegram bot token and the lease that decides which process may use it are bound to one credential-owner
    process at a time (an in-memory authority keyed by `ownerBootId`); a peer's refusal count says nothing about
    this machine's boundary.
- **Send holds** are written to the never-silent store of the machine that held the send, which is the machine that
  holds (or just lost) the lead and therefore runs the conversation; a lease-refused row never forwards to another
  machine for this reason. They follow today's never-silent posture (machine-local store, read through
  `GET /never-silent/incidents` on that machine). No user-facing message or item is emitted by this change (one
  message is removed from first detection), so no one-voice gating is added; no URL is generated.
- **Status surfaces:** `GET /never-silent/incidents` gains `sendHolds` and `counts.openSendHolds`; the verdict is for
  this machine (the holder), as every row of that route already is, and a dark holder is unreadable rather than
  shown as healthy. `/health` and `/status` keep their answers.

## Testing

Targeted unit tests only (Tier 1):

- `tests/unit/telegram-origin/egress-capacity.test.ts` — `reserveExplained` returns each cause in precedence (not
  ready, lease not held with and without freshness, account unknown, reader threw, window full, closed) and a grant
  when live; `reserve` behavior unchanged.
- `tests/unit/telegram-origin/known-failure-retry.test.ts` — `nextOriginLeaseLapse` (2 s, deadline bound) and the
  schedule shape (ascending, four steps, last 30 s).
- `tests/unit/telegram-owner-dm-outcome.test.ts` — the lists stay in sync including the new reasons; a lease-reason
  hold with an operation id is waited for.
- `tests/unit/telegram-origin/lease-freshness-lapse.test.ts` (new; real runtime, worker and store, a fake freshness
  reader whose verdict is the lease, fake send-hold recorder, remote Bot API stubbed, an injectable retry schedule
  as the test seam): a send with the lease away at the boundary and verdict `renewal-lapsed` is held as
  `lease-freshness-lapsed` with a 2 s next attempt and no transport attempt charged; verdict `superseded` or no
  reader gives `lease-not-held-at-send`; one log line with the verdict and gap and no token; the recorder's `held`
  is called and the live delivery notice is not; the hold is in the lease-held set; while the lease stays away the
  pass skips the row (no reservation, no network call, no ladder row); when the lease returns the reply is sent once,
  the in-memory hold clears, and the recorder's `delivered` fires; the armed timer delivers by itself once the lease
  is back; a lease refusal during a replay moves the review-schedule row to 2 s so the next pass takes it; with the
  lease never returning the episode ends after its last step with no attention item and no further wake; a refusal
  with another cause keeps `credential-capacity-unavailable`.
- `tests/unit/neverSilent-send-hold.test.ts` (new): a send hold opens a row that is not an incident
  (`openIncident` null, `counts.openIncidents` 0, `openSendHolds` 1); a repeat is idempotent; delivery closes it with
  the delivery time; an unknown id performs no write; the deadline check closes an undelivered one as unobserved at
  the next write and at `snapshot()`; an older file shape loads with an empty list; the recorder no-ops while
  disabled.
- `tests/unit/LeaseCoordinator.test.ts` — `renewalFreshness()` and `holdVerdict()`: on an injected monotonic clock a
  renewal confirmed at 35 s keeps `holdsLease()` true (`holding`), a gap past 60 s turns it false with
  `renewal-lapsed`, and a view showing another holder answers `not-current-holder` (the timelines from the problem
  statement).

Not run: the full suite, Local Verify, any live machine. Nothing here changes a live config or version. The
Live-User-Channel Proof and Bug-Fix Evidence standards are not met by this PR by itself: the live proof (a held
reply reaching Telegram once, within seconds, on the Studio after a real lapse) belongs to the post-mortem run
lead's verification of N71 once this ships, and the logged verdict and gap are the evidence that proof reads.

## Rollback

Pure code change: a revert restores the old name, the 30 s first retry, the silent lapse and the first-detection
notice. Rows written with the new reasons remain readable: every reader matches the reason by string and the store's
retry logic reads the row's `next_attempt_at`, not the reason. The `sendHolds` list left in a never-silent file is
ignored by the old reader and carried along by its writer until the file is next rewritten; it is inert.

## Left behind

- Why a renewal was late (the main-thread stall itself) is the subject of other post-mortem items; the renewal
  headroom (one missed renewal at ttl/2) is filed to the feedback queue as fb-5422a875-8e4 (Frontloaded Decision 8).
- The Lifeline's IPC client could carry the explanation over the socket so a Lifeline-owner deployment names its
  refusals too; today the Lifeline's capacity reads its polling state, so the lapse case does not arise there.
- A renewal confirmed just after a timer step waits for the next step (polling); a push from the coordinator would
  need a new coupling and is not worth it for a bound of a few seconds.
- The expired-permit hold site keeps its reason and writes no outcome row, so it stays outside the send-hold count
  and the owner-DM wait list; it now logs, which is what the measurement needs first.
- After a process restart the lease reasons are not in the memory lease-held set, so the §2(b) bound does not apply
  to those rows until they are held again; they fall back to the 6-hour deadline exactly as capacity holds do today.

## Maturation plan

Ships live (a narrow fix to the send path, no switch; a revert fully undoes it).

- **ladder:** not applicable: no switch, a narrow live fix to the Telegram origin send path that a revert undoes
- **dark-window:** none; the fix is live on every machine that holds the lead from the release that carries it.
- **test-agent-live:** the unit tests in this change (real origin runtime, worker and store; a fake lease reader with
  a verdict; the never-silent store on a temporary directory) reproduce a boundary refusal with the lease away and
  its retry when the lease returns.
- **dev-agent-live:** the Echo pool after the update: `lease-freshness-lapsed` / `lease-not-held-at-send` lines in
  the server log with their verdict and gap, `sendHolds` rows on `GET /never-silent/incidents` with
  `deliveredAt - heldAt` in seconds, and no `credential-capacity-unavailable` outcome row whose cause was the lease.
- **fleet:** the same release carries it to every agent; nothing to turn on.
- **graduation criterion:** on the Echo pool, over the two weeks after the update, every lease-reason send hold is
  delivered within the four retry steps or handed back by the 30-minute bound, and no first-detection delivery notice
  is posted for one; if a lease hold is instead found waiting for the sentinel with the lease held, the retry design
  is wrong and this spec is reopened.

## Open questions

*(none)*
