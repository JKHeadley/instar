---
title: "Bounded Attention-Notification Surface — a ceiling on messages into an existing topic, and housekeeping that stops reaching the user"
slug: bounded-attention-notification-surface
parent-principle: "Bounded Blast Radius"
eli16-overview: bounded-attention-notification-surface.eli16.md
status: approved
approved: true
approval-context: "Approved by Justin (topic 7848, 2026-08-04 16:52 PDT): explicit 'Approved' in reply to the build-approval request, after reading the plain-English proposal and separately answering 'Silent' to the one design decision (housekeeping silent by default fleet-wide). The converged design, the named standards deviation, and the two honest limits (per-topic scope; outstanding second-pass review) were all presented in-channel before approval."
review-convergence: "2026-08-04T23:55:58.402Z"
review-iterations: 13
review-completed-at: "2026-08-04T23:55:58.402Z"
review-report: "docs/specs/reports/bounded-attention-notification-surface-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
---

> **Note on this document's history.** This spec was rewritten in full after review round 10. Ten rounds of section-by-section patching had left it describing **two incompatible architectures** — the settled ownership-based design in one section and the abandoned machine-count-divisor design in four others. The per-standard conformance gate returned clean on that document, because it evaluates one standard at a time and never reads for internal coherence; the whole-document cross-model reviewer caught it immediately. That is a lesson about the review tooling as much as about the spec, and it is recorded in §Review history rather than dropped.

## Problem (the incident this closes)

Operator report, 2026-08-04 (topic 7848): *"the attention messages have become completely unmanageable for pretty much all INSTAR agents that I can tell. We need to lock this down now."*

Measured the same day against the running install (v1.3.1125):

| Measurement | Echo | Codey |
|---|---|---|
| Messages into the attention topic, last 24h | 64 | 65 |
| …of which carry pure housekeeping | 25 | 33 |

Housekeeping means `⚠ <Component> has been on its heuristic fallback for ~16m`, `Using <fallback> in the meantime — everything else is working fine`, `Memory is getting tight (2.9GB free)`, `Job/A2A spawn refused under force-mode`. None of it names an action the operator can take. Two agents, independent workloads, the same proportions — shared-code behaviour, not one agent misbehaving.

The generator, from `logs/server.log` the same day: **781** `[DEGRADATION]` events, **182** of them `IntelligenceRouter` failure-swaps, driven by host memory pressure (swap 18.8GB used of 20.5GB; 52 instar processes at 4.1GB; three agent servers co-resident).

Existing suppression already drops ~97% (781 → 25). **The residual is the defect**: 25/day of content nobody acts on, and — the load-bearing part — *the volume scales with how degraded the system is*. The worse things get, the more the operator is told, in exactly the messages least worth reading.

### Why it cannot be turned off today

Verified against the running dist. Each negative is control-checked: the control symbols `topicCreationBudget`, `maxTopicsPerSource`, `attentionTopicGuard` all return non-zero from the same grep, proving the search reads the right tree.

1. **The batcher is constructed from literals, not config.** `src/commands/server.ts` builds `new NotificationBatcher({ enabled: true, summaryIntervalMinutes: 30, digestIntervalMinutes: 120 })`. No operator setting can reach any of the three.
2. **`enabled` is not honoured on this path.** `NotificationBatcher.enqueue()` never reads `this.config.enabled`. Three `TelegramAdapter` callsites *do* call `isEnabled()` — so the flag looks like a working lever and is not one here.
3. **No message-volume limit exists.** Searched under seven candidate names across five sources. The one real budget in this area, `topicCreationBudget`, bounds *auto-created topics*; messages into an existing topic were never covered.
4. **Cross-batch suppression does not survive a restart.** `lastSentContent` is an in-memory `Map`; the symbol appears 6× in the file and `writeFile|readFile|persist|stateDir` appears 0×.
5. **`DegradationReporter`'s user alert has no enable/disable gate.** Its only brake is a per-feature `ALERT_COOLDOWN_MS = 1 hour`. With ~8 components degraded that is up to 8 messages/hour.

The comment directly above the batcher construction states the intended principle: *"Log everything, notify selectively."* The degradation path is the one that does not.

## Non-goals

- **Not** fixing the memory pressure that generates the events — a real, separate capacity problem. <!-- tracked: CMT-1184 -->
- **Not** changing what `IMMEDIATE` delivers. Urgent notices keep reaching the operator.
- **Not** silencing the attention *queue*. `/attention` items via `TelegramAdapter.createAttentionItem` are a different path, unchanged.

## Design

Four changes in shared code. Each is independently reversible by config.

### C1 — `DegradationReporter` user alerts config-gated, default OFF

New config `monitoring.degradationReporter.notifyUser`, boolean, **default `false`**.

When false, `reportEvent()` skips *only* the `telegramSender` branch. The console `[DEGRADATION]` line, `persistToDisk()`, and the feedback submission are unchanged. The record is fully preserved; the operator stops receiving it.

A degradation event is *by construction* a report that the system fell back and kept working — the definition of housekeeping. Of 25 sampled, 0 were actionable. Default-ON would leave the operator opted in to noise by inertia, which is the state this spec ends.

**Reachability preserved.** A genuinely user-affecting degradation reaches the operator through the attention queue, the health-alert path, and `IMMEDIATE` — none of which this flag touches. It governs the cadenced fallback report, not the operator's ability to learn something broke.

### C2 — `enqueue()` honours `enabled`, and the batcher is built from config

When `enabled === false`, `SUMMARY` and `DIGEST` increment `suppressedCount` and are dropped. `IMMEDIATE` is unaffected — a kill-switch on batching must never become one on urgency.

The batcher is constructed from `notificationBatcher.*` (**top-level**, see §Config) instead of literals, each key falling back to today's value when absent, so absence preserves current behaviour byte-for-byte.

### C3 — Suppression state persists across restarts

`lastSentContent` is written to `<stateDir>/notification-suppression.json` on flush and read at construction. Entries carry a timestamp and expire after `suppressionTtlHours` (default 24), so a genuinely changed condition can re-notify and the file cannot grow unbounded.

An unreadable or corrupt file starts with an empty map and records one degradation event; a failed write is non-fatal. For a *suppression* map, losing it costs at most a repeat — never a lost actionable message.

**The two persisted states fail in opposite directions, and an earlier draft conflated them.** The cross-model reviewer found the contradiction: C3 said unreadable state fails open, while invariant I5 said persisted state can only ever reduce sends after a restart. Both cannot hold if the two states share one rule. They do not:

| Persisted state | If unreadable | Why |
|---|---|---|
| Suppression map (`notification-suppression.json`) | **Fail open** — start empty, send. | Losing it causes at most a duplicate. Failing closed would suppress notices that were never actually sent. |
| Rate-limit state (`sendTimes`) | **Fail closed** — hold the batched lane. | Losing it would mint fresh capacity, precisely the ceiling-bypass this spec exists to prevent. Holding housekeeping costs nothing recoverable. |

`IMMEDIATE` is unaffected by either, in both directions.

### C4 — One enforcer per topic, and a rolling-window limit

#### C4.1 The enforcer

> **Only the machine that owns a topic sends batched notifications into it.**

Instar already assigns every conversation exactly one owning machine — the pool's placement record (`GET /pool/placement?topic=N`), with a transfer protocol, a duplicate-session reconciler, and one-voice gating already built on it. C4 rides that.

With exactly one enforcer per topic the limiter is an ordinary single-process rate limit — no shared counter, no machine count, no divisor, and no cross-machine call on the send path.

**The guarantee, stated once and in full: exact under a single agreed owner; worst case 2× during a placement split-brain or a transfer inconsistency.** The re-review flagged that an earlier version put "exact" in the headline and the qualifier a paragraph later, which reads as exact to anyone skimming. The qualifier belongs in the claim.

**Exact UNDER PLACEMENT CONSISTENCY, and not otherwise.** The guarantee inherits whatever the placement record provides: if a split-brain or a stale replicated view yielded two machines each believing they own one topic, both would enforce independently and the operator could receive up to 2× the limit. That is a real dependency rather than a hidden assumption — but it is the *same* invariant the transfer protocol, the duplicate-session reconciler, and one-voice gating already depend on, so this change adds no new consistency requirement. It borrows an existing guarantee instead of inventing a weaker one.

Three earlier drafts instead divided a budget across machines, and all three were rejected — `max(1, floor(budget/N))` broke the bound for fleets larger than the budget; fractional token buckets fixed that but bounded only the average rate, leaving an idle burst of N and a stale-count window reaching N × budget. Each revision made the arithmetic better and the caveats longer, which was the signal that the *approach* was wrong: **approximating a shared quantity from N independent local views cannot produce an exact shared bound.** The multi-machine problem is not solved here — it is not created.

#### C4.2 The limit

A **rolling-window counter**, not a token bucket. The token bucket existed only to divide a budget across machines; with a single enforcer it is unnecessary machinery, and "rolling window" is the guarantee the plain reading of a limit implies.

Exactly one algorithm, stated once and referenced everywhere:

```
state:  sendTimes: number[]     // epoch ms of sends, per topic, persisted
window: windowMs = 3_600_000    // 60 minutes
limit:  maxMessagesPerTopicPerHour, default 4

onFlushAttempt(topicId, now):
  if limit === 0: SEND            // 0 disables the limiter entirely — see below
  if sendTimesUnreadable: HOLD    // fail-closed for the batched lane — see C3
  sendTimes = sendTimes.filter(t => now - t < windowMs)   // evict, then test
  if sendTimes.length >= limit: HOLD
  else: SEND; sendTimes.push(now)
```

**The `limit === 0` guard is explicit and load-bearing.** Frontloaded Decision 3 documents `0` as *disables the limit*, but without the guard `sendTimes.length >= 0` is always true and `0` would hold every batched message forever — the opposite of the documented meaning, and a silent muting of the operator's own escape hatch. The cross-model reviewer caught the contradiction between the prose and the algorithm. The guard is first in the sequence so the disable path cannot be reached by any other branch.

**Draining order is oldest-held-first.** When the window opens, previously held items drain before newly queued ones. Without a stated order a steady stream of new items could consume each freed slot and starve an older held item indefinitely — which would also make `maxHoldHours` fire on a topic that was in fact being served. One queue per topic, FIFO, held items at the head.

- **Guarantee:** no more than `limit` batched messages are sent into a topic in any 60-minute interval. No burst term, no initial-token question, no boundary ambiguity — eviction happens before the test, so the window is genuinely rolling rather than fixed.
- **Persistence:** `sendTimes` lives beside the suppression state. A restart therefore cannot mint capacity.
- **What the tests assert:** the rolling count itself. There is no second metric.

#### C4.3 The hold

- Held items stay queued and **release themselves** — the existing `checkFlush()` timer drains them at the first permitted moment. Nothing depends on the operator noticing or asking.
- **The hold sends the operator nothing.** No over-limit line. Two drafts proposed one and the gate rejected both — first under **The Agent Carries the Loop** (it asked the operator to request the held items), then under **Near-Silent Notifications** (the replacement was itself unactionable housekeeping). The second is the sharper lesson: *a change that bounds housekeeping must not add a housekeeping message announcing the bounding.*
- The hold is visible on `getStats()` (`heldCount`, `heldSince`, `notOwnerSkipped`, `notOwnerExpired`, `heldExpired`, `rateStateReadable`) and in `logs/notification-ceiling.jsonl`, one metadata-only row per hold, expiry, fold, and failed send. **No Silent Degradation** is satisfied by the audit trail, not by messaging the operator.

#### C4.4 Brakes (P19 — No Unbounded Loops)

| Brake | Value | Behaviour |
|---|---|---|
| `next-attempt` | computed | On a hold, the next attempt is scheduled for the instant the oldest in-window send expires, not polled blind each minute. |
| `max-hold` | `maxHoldHours`, default 6 | A topic blocked for a PERSISTENT reason drops its backlog with an audit row and a per-reason counter (`notOwnerExpired` / `heldExpired`). The queue has a terminal state; **nothing is sent on this path.** |
| `max-held-items` | `maxHeldItemsPerTopic`, default 200 | On overflow the **oldest** entries fold into one aggregate carrying their count. Memory is O(200) per topic regardless of producer behaviour. This is the one place "never dropped" is qualified, and deliberately: an unbounded buffer inside the thing built to bound a flood would reproduce the defect one layer down. |
| `dedupe-key` | existing `${topicId}:${dedupKey}` | Repeats collapse while held. |

**Two brakes were REMOVED at implementation time, not repaired.** An earlier version of this table specified a `max-hold` *collapse* (an aged hold sends one digest anyway) plus a *breaker* counting three collapses and dropping the topic to DIGEST cadence. Writing their tests showed both were **unreachable**: the rolling window is 1 hour and `maxHoldHours` is 6, so a rate-limit hold always drains when its window clears, hours before it could mature. The only holds that persist that long are ones whose REASON persists — foreign ownership, unresolved ownership, corrupt rate state — and every one of those must never age into a send, because that is exactly the fail-closed rule. The collapse could therefore only ever have fired in the cases where it was forbidden, and the breaker downstream of it could never trip.

A documented brake that cannot fire is worse than no brake: a reader, including a future audit, records it as protection that exists. This is the same class as the fallback that had never once been exercised and failed on the day it was needed. Both are gone, and the size bound is carried by `max-held-items`, which is reachable and tested.

**A degraded batched lane is visible outside this component.** When rate state is unreadable the lane holds everything, and with C1 defaulting degradation alerts off that could be invisible except in a local JSONL nobody reads — "the system may successfully bound messages while hiding that the bounding path itself is unhealthy" (re-review finding 2). Three surfaces carry it: a `console.warn` into `logs/server.log`, a `state-unreadable` row in `logs/notification-ceiling.jsonl`, and `rateStateReadable` on `getStats()`, which feeds the existing telemetry collector. Deliberately NOT a user-facing message: it is not something the operator can act on, and adding one would break the discipline this change establishes. Honest limit: an operator who reads none of those three learns of it only on asking why a topic went quiet — at which point `getStats()` answers.

**Corrupt rate state latches for the process lifetime.** When `sendTimes` cannot be read the batched lane holds, and a later successful *write* deliberately does NOT clear that state — the map being written is the empty one that failed to load, so clearing it would convert corrupt state into minted capacity inside the same process. Recovery is a restart, which loads the freshly-written valid file. Honest residual: one window of extra capacity, once, after that restart.

**A failed send is not a delivery.** The sink reports success or failure; items are dequeued, marked suppressed, and charged a rate-limit slot ONLY on a confirmed send. An earlier implementation treated every attempt as delivered, so a failed Telegram send dropped the item *and* suppressed it for 24 hours — silent loss, contradicting this spec's own "presence follows delivery" invariant. Caught by the Phase 5 second-pass review.

### The failure direction is per-tier

An earlier draft used "when in doubt, deliver" everywhere, reasoning that an unsent message is unbounded harm and an extra one is a single line. The gate rejected it under **Conservative Outbound: Act, Don't Notify**, correctly: that premise holds for an *actionable* message and is false for housekeeping, where an extra message is the entire harm being eliminated. The general rule had been inherited without checking whether its premise held for this lane.

| Lane | On any uncertainty | Why |
|---|---|---|
| `IMMEDIATE` / action-required | **Deliver.** Never gated by ownership, the limit, or any brake in C4. | An unsent urgent message is unbounded harm. This premise justifies fail-open, and only here. |
| `SUMMARY` / `DIGEST` housekeeping | **Hold, and record.** | Already durably written to logs, disk, and feedback. Non-delivery costs nothing recoverable; delivery costs exactly the noise being removed. |

## State machine and invariants

One batched item, one topic. `IMMEDIATE` never enters this machine.

| From | Event | To | Guard |
|---|---|---|---|
| — | `enqueue` | `dropped-disabled` | `enabled === false` |
| — | `enqueue` | `suppressed` | dedup key present and unexpired in suppression state |
| — | `enqueue` | `queued` | otherwise |
| `queued` | flush attempt, not owner | `not-sent-not-owner` | placement names another machine |
| `queued` | flush attempt, window full | `held` | `sendTimes.length >= limit` |
| `queued` | flush attempt, window open | `sent` | owner (or no contrary record) and window open |
| `held` | window opens | `sent` | — |
| `held` | held > `maxHoldHours` | `collapsed` → `sent` | — |
| `held` | queue > `maxHeldItemsPerTopic` | `folded` (oldest → aggregate) | — |

Invariants, each with a test:

- **I1** — `sent` implies the rolling in-window count was `< limit` at send time. *(No path increments without the guard.)*
- **I2** — **within a process lifetime**, every item reaches exactly one of `sent`, `suppressed`, `dropped-disabled`, `not-sent-not-owner`, or `folded`. No item is lost silently; each terminal state has a counter. **The queued and held backlog is deliberately not persisted** — a restart loses it. That is intended: the backlog is housekeeping whose content is already durably in the logs, disk records, and feedback submissions, so persisting a second copy would add a durability mechanism guaranteeing delivery of exactly the material this spec is trying not to deliver. The qualifier is stated rather than implied, because an unqualified I2 would be false at every restart.
- **I3** — `IMMEDIATE` never enters this machine, so no state here can delay or suppress it.
- **I4** — every transition other than `queued` and `sent` writes one audit row.
- **I5** — `sendTimes` can only ever *reduce* what is sent after a restart, never increase it. Scoped to `sendTimes` deliberately: the suppression map fails open by design (see the C3 table), so it is excluded from this invariant rather than silently violating it.

The state machine is here because the cross-model reviewer noted, fairly, that C4 accumulated enough stateful machinery for implementation bugs to be a realistic failure mode. Five states, five invariants, five tests is the answer to that.

### Why this is not a standard durable queue

Most of the machinery already exists in `NotificationBatcher` and is being *fixed*, not built: the queues, dedup key, coalescing, flush timer, and tiering are present today. This spec adds persistence for one map plus a `sendTimes` array, two bounds, an ownership check, and an audit line.

A general durable-queue dependency would replace working code with a new component and a new failure surface, to gain properties (cross-process durability, at-least-once delivery) that a notification digest does not need. Adopting one would be right if *delivery* guarantees were the requirement. Here the requirement is *bounded non-delivery*, which is the opposite.

## Multi-machine posture

Default posture is **unified**. Per surface:

### C4 limit — **unified**, via single-enforcer ownership

Covered in C4.1. Exactly one machine enforces per topic, so the bound is exact rather than approximated. Ownership resolution is a local read of the replicated placement record, not a call on the send path.

**Batched-lane fallback, stated once:**

| Ownership state | Batched lane |
|---|---|
| This machine is the owner | Send, subject to C4.2. |
| Another machine is the owner | Record, do not send (`notOwnerSkipped`). |
| Unresolvable, **and** a placement record names another owner | **Hold.** |
| Unresolvable, **and** no pool exists (single-machine install) | Send, subject to C4.2 — with no pool, this machine is trivially the owner. |
| Unresolvable, **and** a pool exists but placement is unreadable | **Hold**, and record `ownershipUnresolved`. |

#### What happens to a non-owner's batched items

`notOwnerSkipped` is **queue-deliberately**, not drop.

An earlier draft specified an outright drop. The cross-model reviewer asked only that the choice be made explicit, and accepted a documented drop as one valid answer — but the Standards-Conformance Gate then rejected it under **Ownership-Gated Side Effects**, which requires a non-owner to *forward, queue, or claim* deliberately rather than discard. The standard is the constitution and it wins over a reviewer's willingness to accept an alternative. That disagreement is worth recording rather than smoothing over: two reviewers can both be right about different questions, and the binding one is the standard.

The resolution needs no new mechanism — it reuses C4.3's existing hold:

- A non-owner's batched items are **held in that topic's existing queue**, exactly like an over-limit hold.
- They are subject to the **same `maxHoldHours` expiry and `maxHeldItemsPerTopic` bound**, so a non-owner cannot accumulate an unbounded or arbitrarily stale backlog.
- **If ownership arrives** within the window — a transfer, a failover — the queue drains normally, oldest first. The items are fresh by construction, because anything older has already expired.
- **If ownership never arrives**, they collapse and clear on the `maxHoldHours` brake like any other held backlog, counted as `notOwnerExpired`.
- They are **not forwarded** to the owner: forwarding would add a cross-machine dependency on the send path to deliver housekeeping that C1 already routes away from the operator by default.

This is strictly better than the drop it replaces. The staleness objection that motivated the drop is handled by the expiry that already existed, and the unbounded-retention objection by the bound that already existed. Content remains readable in that machine's logs regardless.

Holding rather than sending on an unresolved read is what makes the bound exact rather than approximate: two machines can never both emit housekeeping into one topic. It costs a delayed housekeeping digest, which is the outcome this spec is engineering toward.

### `IMMEDIATE` — ownership **consults**, never blocks

A blanket ownership exemption was rejected by the gate under **Ownership-Gated Side Effects**: an urgent topic-scoped side effect that never proves ownership is how two machines talk over each other. But gating urgency on an ownership read collides with **The Agent Is Always Reachable**. Both are satisfied by making ownership a *routing* input rather than a permission:

| Ownership state | `IMMEDIATE` |
|---|---|
| This machine is the owner | Send. |
| Another machine owns it and is reachable | Route through the owner — one voice. |
| Owner **unreachable** | **Claim first.** Attempt an ownership claim through the existing stale-owner-release path, which already carries its own evidence bar, quorum, and audit. On a successful claim, send as the owner — ownership proved, not bypassed. |
| Claim refused or not completed in time, or ownership **unresolvable** | **Send directly**, stamped with the originating machine, recorded as `ownershipBypasses`. |

Rows 3 and 4 are the correction to an earlier draft that went straight to a direct send. The gate rejected that under **Ownership-Gated Side Effects**, which requires a non-owner to forward, queue, or *claim* — and claim is exactly right here, because Instar already implements evidence-gated claiming for a dead owner. Reaching for it first turns most of what used to be a bypass into a proved ownership.

#### A standards conflict, named rather than worded around

Row 4 remains a genuine bypass, and it is the point where two constitutional standards pull in opposite directions:

- **Ownership-Gated Side Effects** says a machine that has not proven ownership must not perform the side effect.
- **The Agent Is Always Reachable** says an unresolvable internal condition must never be allowed to produce operator-facing silence.

For an `IMMEDIATE` notice with an unclaimable owner, every option satisfies exactly one of them. Forwarding is impossible (the owner is unreachable). Queueing converts an urgent notice into silence. Sending performs an unproved side effect.

This spec resolves it toward **reachability**, on the reasoning that the failure modes are not symmetric: an unproved-ownership send costs at most a duplicate urgent message, visibly stamped with its origin, while the alternative costs an operator not learning about an urgent condition — the failure class the reachability standard exists to prevent, and the one this whole spec treats as unacceptable.

The residual is stated plainly rather than defined away: **this spec knowingly deviates from Ownership-Gated Side Effects in row 4.** The deviation is narrow (unreachable *and* unclaimable, not merely slow), attributed (the operator sees which machine spoke), and audited (`ownershipBypasses`, with the claim attempt and its refusal reason recorded). Which standard should win in this specific case is a constitution-level question rather than a spec-level one, and it is registered as such rather than settled by an author's preference. <!-- tracked: CMT-1184 -->

### C3 suppression state — **machine-local**

`machine-local-justification: physical-credential-locality` — the key is `${topicId}:${dedupKey}`, and the topic id is a Telegram forum topic namespaced by the bot token that machine holds. The key is meaningful only within the machine holding that binding. Consequence: a repeat notice can cross machines once. C4's single enforcer bounds the operator's total regardless, so the failure mode is a duplicate within budget.

### C1 / C2 — **unified** by configuration

Both are config booleans, unified through the ordinary config surface. No new replication path.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| C1 — deliver a degradation report? | `invariant` | One config boolean. No competing signals, nothing to weigh. |
| C2 — deliver a batched notification? | `invariant` | Same shape. |
| C3 — is this a repeat? | `invariant` | Exact-match lookup on a normalized key. |
| C4.1 — is this machine the enforcer? | `invariant` | A lookup in an existing authoritative placement record. This spec *consumes* an ownership decision; it does not make one. |
| C4.2 — send or hold? | `invariant` | A count over a rolling window against a fixed bound. Deliberately content-blind: it never reads a message, so it cannot mis-judge one. Only failure mode is delay, bounded by the window, with `IMMEDIATE` exempt. Making this a judgment call would add a failure mode (a model mis-classifying urgency) in exchange for nothing the exemption does not already provide. |

No point chooses among competing signals, so none is a judgment-candidate. Per **Judgment Within Floors**, the floors are the config defaults and the `IMMEDIATE` exemption.

## Signal vs authority

C1, C2, C3 are **signal-suppression**: they change what is *delivered*, never what is *decided*. No detector's verdict changes.

C4 holds delivery authority and is deliberately the dumbest possible rule — a count over a rolling window, no content inspection, no classification, no model call. It cannot mis-judge a message because it never reads one. Per `docs/signal-vs-authority.md`, a brittle rule may hold authority only when its decision space is trivially small and its failure direction is safe. Here the direction is *later* for housekeeping and *never applied at all* to `IMMEDIATE`.

## Verify the state, not its symbol

| Surface | Symbol | State claimed | Corroboration | Unmeasurable |
|---|---|---|---|---|
| C4.2 limit | `sendTimes` in the rolling window | "the operator received N recently" | counted at the single `sendDirect` chokepoint the messages actually pass through — the count is the act, not a proxy | unreadable ⇒ **hold** the batched lane (recorded); `IMMEDIATE` unaffected |
| C4.1 ownership | placement record | "this machine is the one enforcer" | placement is the same authoritative record the transfer protocol and duplicate reconciler already act on — not a second proxy invented here | unreadable ⇒ hold if a pool exists, send if none; `ownershipUnresolved` recorded, never silently read as "I am the owner" |
| C3 suppression | key present in map | "already delivered" | the map is written only *after* a successful flush, so presence follows delivery rather than intent | unreadable ⇒ empty map ⇒ send (at most a repeat) |

Each unmeasurable case resolves per the per-tier rule, and none collapses to a flattering fabricated value: `ownershipUnresolved` stays explicitly unknown rather than defaulting to ownership.

## Self-heal before notify

This spec introduces no watcher and raises **no operator notice at all** — it only reduces an existing notice surface. C4 emits nothing to the operator; holds go to logs, stats, and the audit trail. Its own internal failures resolve per the per-tier rule and record a degradation event; none escalates, because none is something the operator can act on, which is the discipline this spec establishes.

## Config

The JSON below is the **literal shape on disk**. An earlier draft showed an illustrative path with the real one in prose underneath; the cross-model reviewer flagged that as a likely implementation/test mismatch. Illustrative config in a spec is a defect, not a convenience.

```jsonc
{
  "monitoring": { "degradationReporter": { "notifyUser": false } },
  "notificationBatcher": {
    "enabled": true,
    "summaryIntervalMinutes": 30,
    "digestIntervalMinutes": 120,
    "maxMessagesPerTopicPerHour": 4,
    "suppressionTtlHours": 24,
    "maxHoldHours": 6,
    "maxHeldItemsPerTopic": 200
  }
}
```

`notificationBatcher` is **top-level**, deliberately not nested under `messaging` — an array of adapters, where a nested key is unreachable (the trap already documented for `outboundAdvisory`). Spec, implementation, and tests use this one path.

## Frontloaded Decisions

Rewritten in full at the round-10 rewrite. The cross-model reviewer noted that builders treat this section as authoritative, and three of its items still described the abandoned divisor design.

1. **`notifyUser` default OFF.** Recommended with the measurement behind it (0 of 25 sampled were actionable) and **confirmed by the operator** — Justin, topic 7848, 2026-08-04, reply `"Silent"` to an explicit two-option choice.
2. **`IMMEDIATE` is exempt from C4 entirely** and gated by ownership only as routing, never as permission.
3. **Limit default 4/topic/hour**, rolling window. Against a measured 2.7/hour it binds without being punitive. `0` disables.
4. **One enforcer per topic via existing placement ownership.** No machine-count division, no divisor, no shared counter.
5. **Rolling-window counter, not a token bucket.** One algorithm, specified in C4.2, asserted directly by the tests.
6. **Held items are retained and self-releasing, bounded at `maxHeldItemsPerTopic`,** past which the oldest fold into a counted aggregate.
7. **Failure direction is per-tier**: deliver for `IMMEDIATE`, hold for batched housekeeping.
8. **Suppression TTL 24h.**
9. **Config key path: top-level `notificationBatcher`.**

Cheap-to-change-after tags claimed: **0**. Nothing hides behind a dark-ship label — this changes what the operator receives on the next release, which by the closed taxonomy is a published user-visible interface and therefore never cheap.

## Open questions

*(none)*

## Acceptance criteria

Every criterion pairs its assertion with a **control that must fail**. A check that cannot fail is not a check.

1. With defaults, a `DegradationReporter` event produces a console line, a disk record, and a feedback submission, and **zero** sends. *Control:* with `notifyUser: true` the same event produces exactly one send.
2. With `enabled: false`, `SUMMARY`/`DIGEST` increment `suppressedCount` and send nothing, while `IMMEDIATE` still sends. *Control:* with `enabled: true` the `SUMMARY` sends on flush.
3. A batcher flushed, destroyed, and reconstructed against the same `stateDir` suppresses a repeat of an already-sent key. *Control:* the same sequence against a *different* `stateDir` sends it — proving the assertion is about persistence, not the key.
4. With `maxMessagesPerTopicPerHour: 2`, the third flush in a window is held, items are retained, **zero** additional messages are sent, and `heldCount` is non-zero. *Control:* an `IMMEDIATE` in the same saturated window still sends — proving the assertion is about the limit, not a dead sender.
5. **The window is rolling, not fixed.** With `limit: 4`, four sends at t=0..t=45min, then a fifth at t=50min is **held**; at t=61min it **sends** because the t=0 entry has expired. *Control:* the same sequence with the eviction step removed holds at t=61min — proving the test measures eviction rather than the passage of time.
6. **Held items release with no user action.** With a saturated window, advancing the clock and running the existing timer drains the backlog. *Control:* without advancing the clock the items stay held.
7. **A restart cannot mint capacity.** A batcher at its limit, reconstructed against the same `stateDir`, still holds. *Control:* the same batcher after the window expires sends — proving persistence, not a stuck sender.
8. **Only the owner sends.** Two batchers on one topic where placement names machine A: A sends, B records `notOwnerSkipped` and sends nothing. *Control:* with placement naming B, the roles invert — proving the test reads placement rather than a fixed identity.
9. **Unresolvable ownership holds when a pool exists and sends when none does.** *Control:* the two configurations must produce *different* outcomes — a test passing under both is measuring nothing.
10. **`IMMEDIATE` is never blocked by ownership.** With placement naming another, unreachable machine, an `IMMEDIATE` still sends and records `ownershipBypasses`. *Control:* with that owner reachable it routes through the owner instead — proving reachability is read.
11. **The hold terminates without sending.** A topic held for a persistent reason (foreign ownership) past `maxHoldHours` drops its backlog, records `notOwnerExpired`, and sends **nothing**. *Control:* a rate-limit hold on an OWNED topic drains normally when its 1h window clears — distinguishing "expired because the reason persisted" from "drained because the window opened", which is the confusion that hid the unreachable-collapse defect.
11b. **A failed send changes no state.** With a throwing sink, the item stays queued, is not suppressed, and consumes no rate slot; when the sink recovers it delivers. *Control:* a succeeding send dequeues, suppresses, and consumes the slot.
11c. **Corrupt rate state never ages into a send.** A batcher loaded from a corrupt state file holds, and still holds after `maxHoldHours`, recording `heldExpired`. *Control:* a valid state file on the same path sends.
12. **The held queue is bounded.** 500 structurally distinct notices leave at most `maxHeldItemsPerTopic` entries plus one counted aggregate. *Control:* 500 *identical* notices leave 1 entry with count 500 — distinguishing the storage bound from the pre-existing dedup path.
13. **Every invariant I1–I5 has a test**, each with a control that fails when the guard is removed.
14. Absent config reproduces today's observable behaviour on every path above.
15. **Live proof on this agent.** After deploy, 24h of attention-topic traffic contains zero heuristic-fallback / "everything else is working fine" lines, while a deliberately raised attention item still arrives.

## Maturation plan

This change alters a fleet-wide default for what every operator receives, so it does **not** ship dark — a dark ship would leave the flood running everywhere while the fix sat inert, which is the state the operator asked to end. Instead it ships live with a config rollback on every lever, and the staged rollout is used to catch defects rather than to delay the benefit.

- **test-agent-live:** deploy to a throwaway agent via `/test-as-self`, drive the burst-invariant path, and confirm the audit rows and counters appear. Verifies the feature is alive before any real operator sees it.
- **dev-agent-live:** live on this agent (echo) first. The measured baseline here is 64 messages/24h with 25 housekeeping, so the signal is unambiguous: 24h post-deploy, the attention topic must contain zero heuristic-fallback / "everything else is working fine" lines while a deliberately raised attention item still arrives (acceptance criterion 15). This agent is also the multi-machine case, so it exercises the ownership path rather than only the single-machine shortcut.
- **fleet:** after the dev-agent 24h window passes clean, in the next ordinary release. No separate flag flip: the defaults ARE the change, and holding them back per-agent would mean the fleet keeps the defect while the fix exists.
- **graduation criterion:** on this agent, one clean 24h window meeting acceptance criterion 15, with `getStats()` showing a non-zero `suppressedCount` (proving the path ran, not that nothing happened) and `ownershipBypasses` consistent with the machine count. A zero-everywhere reading is treated as a **dead check, not a pass** — it would equally be produced by a batcher that never executed.
- **dark-window:** none for the defaults, deliberately, per the reasoning above. The `IMMEDIATE` ownership-claim path (§Multi-machine posture rows 3–4) is the one genuinely new behaviour with a failure mode the operator would feel, and it carries the dark window instead: it ships with the claim step disabled (direct send + audit, today's behaviour) until the dev-agent window shows the audit rows are clean, then the claim is enabled. That inverts the usual shape on purpose — the noise reduction is what the operator asked for and is fully reversible by config, whereas the claim path touches ownership and is not.

## Rollback

Reversible by config alone — no data migration, no agent-state repair:

- Restore today's user-facing behaviour: `monitoring.degradationReporter.notifyUser: true`.
- Remove the limit: `maxMessagesPerTopicPerHour: 0`.
- Remove persistence: delete `<stateDir>/notification-suppression.json`; it rebuilds empty.
- Full revert: the PR is a single squash commit.

## Implementation

- `src/monitoring/DegradationReporter.ts` — `notifyUser` gate in `reportEvent()`, plumbed via `connectDownstream()`.
- `src/messaging/NotificationBatcher.ts` — `enabled` honoured in `enqueue()`; rolling-window limiter; ownership check; persistence; brakes; audit rows; new `getStats()` counters.
- `src/commands/server.ts` — construct the batcher from config; pass `notifyUser`, `stateDir`, and the placement reader.
- `src/core/ConfigDefaults.ts` — defaults for the new keys.
- `src/core/PostUpdateMigrator.ts` — `migrateConfig()` adds missing keys only (Migration Parity Standard).
- `src/scaffold/templates.ts` — `generateClaudeMd()` gains a short section so agents know the levers exist (Agent Awareness Standard).
- Tests — unit, integration, and e2e per the Testing Integrity Standard, including a burst-invariant test asserting the limit holds under a 100-event burst.

## Review history

| Round | Reviewer | Findings | Outcome |
|---|---|---|---|
| 1 | Conformance gate | 1 | Undefended machine-local posture → redesigned |
| 2 | Conformance gate | 2 | Held-notice parked work on the operator; divisor unsafe under partition |
| 3 | Conformance gate | 1 | Replacement held-notice was itself housekeeping → removed entirely |
| 4 | Conformance gate | 2 | No brakes on the retry; unbounded held queue |
| 5 | Conformance gate | 1 | "Exactly bounded" overclaimed for independent buckets |
| 6 | Conformance gate | 0 | — |
| 1 | Cross-model (codex-cli:gpt-5.5) | 6 | Ceiling-vs-bucket mismatch; overclaim; internal contradiction; ambiguous config path; underexplored alternative; missing test controls |
| 7–9 | Conformance gate | 1 each | Divisor still approximate → **redesigned to single-enforcer ownership**; failure direction backwards for housekeeping; `IMMEDIATE` ownership exemption |
| 10 | Conformance gate | 0 | — |
| 2 | Cross-model (codex-cli:gpt-5.5) | 5 | **Two incompatible architectures left in one document**; rate-limit semantics still mixed; stale Frontloaded Decisions; ambiguous ownership fallback; state machine needed |
| — | Full rewrite | — | This document |

**The lesson about the tooling.** Round 10 of the per-standard gate returned clean on a document that described two mutually exclusive architectures. That is not a gate failure — it evaluates one standard at a time and never claims to read for coherence — but it is a real limit worth naming: *a clean per-standard pass is not evidence of a coherent document.* Iterative section-by-section patching is exactly the process that produces this failure, and only a whole-document reader catches it. Both reviewer kinds were necessary; neither would have sufficed.
