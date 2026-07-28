---
title: "Slack Outbound Delivery Robustness — channel-typed relay queue, funnel-routed sentinel lane, durable delivery-id idempotency, refused slack-forward (roadmap Phase 2.1)"
slug: "slack-outbound-robustness"
author: "echo"
status: "review-closed: architecture-converged-with-build-residual (round 8, 2026-07-03) — see review-disposition; the build stays gated on the keystone registry + deliverToConversation increments MERGING"
parent-principle: "The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery — via its named OUTBOUND extension *Guards Degrade, Not Outage*: a safety/delivery layer on the user-facing path may never convert its own infra failure into the user's silence. (The Operator-Channel-Sacred rule text governs the INBOUND consume gate; this spec governs the OUTBOUND delivery/queue path — the same principle, outbound side. Re-anchored round 2 per the conformance gate.)"
sibling-principles: "The Operator Channel Is Sacred (sibling context — the inbound twin of this spec's fail-toward-delivery posture); Structure > Willpower (a durable queue, not a session remembering to retry); A Refusal Stays a Refusal / P18 (every drop is a counter + ledger row, never silent); Bounded Notification Surface (P17 — one deduped escalation per failure episode); Bounded Blast Radius (P19 — breaker on every loop, PER-CHANNEL suspension state §2.3); Migration Parity (additive SQLite columns, never destructive); Verify the State, Not Its Symbol (delivery state machine over 'the curl said ok'); Signal vs Authority (the sentinel never overrides the tone gate); Near-Silent Notifications (§2.3 — recovery chatter decision stated, unreachable-conversation escalations out-of-band)"
constitution: "The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery (docs/STANDARDS-REGISTRY.md); Guards Degrade, Not Outage; Bounded Notification Surface (P17); A Refusal Stays a Refusal (P18); Bounded Blast Radius (P19); Migration Parity Standard; Testing Integrity Standard"
lessons-engaged: "2026-06-05 restore-purge silent deletion (five queued outbound messages eaten at boot — delivery-failure-sentinel.ts:83-90; every purge here is LOUD, channel-tagged, AND scoped to live lanes + unheld rows — round-1 C2 caught the lesson recurring one level up; round-2 C1/C2 caught it a THIRD time inside the folds (stampede consumption + hold-arithmetic purge), driving the §2.2a durable HOLD disposition) · 2026-06-06 duplicate-message fix (byte-identical status 13.5 min apart — OutboundContentDedup.ts:5-12; the same dedup now covers Slack) · 2026-06-05 restart-cascade never-drains (immediate first drain on start — delivery-failure-sentinel.ts:258-271; inherited by the Slack lane unchanged) · outbound-gate-tiered-fail-direction (fail direction argued per failure point, §3) · Maturation Path — Every Feature Ships Enabled on Developer Agents (§6 rollout ladder)"
earned-from: "docs/audits/slack-ai-employee-audit-2026-07.md §3.1 'Outbound robustness (queue/retry/dedup/idempotency/formatter): MISSING (tone gate only; one internal route bypasses even that)'; live incident record in telegram-delivery-robustness.md (the Telegram lane exists because these exact losses happened there first)"
roadmap: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md Phase 2.1 — live proof: 'Kill network mid-reply; message arrives exactly once with a sentinel audit row'"
parent-spec: "docs/specs/telegram-delivery-robustness.md (Layers 1-3 — this spec generalizes them); docs/roadmaps/instar-two-goal-roadmap-2026-07.md (Phase 2, depends on Phase 1)"
depends-on: "docs/specs/durable-conversation-identity.md — the Phase-1 KEYSTONE, CONVERGED round 11 (worktree .worktrees/conversation-identity, commit aa5086eb8, review-convergence 2026-07-03, approved: true). THIS SPEC'S BUILD remains gated on the keystone's BUILD LANDING (its registry + `deliverToConversation` funnel increments merged — review convergence is now met): every conversation address in this spec is a Phase-1 minted id (`topic_id < 0` ⇄ tuple (slack, channelId, threadTs?) ⇄ canonical key slack:<teamId>:<channelId>[:<threadTs>]), resolved through the ConversationRegistry; §11.1 of the keystone explicitly defers this exact lane here and its §5 tail pins that this lane 'slots in UNDER the funnel without changing its callers' — §2.3 honors that literally (the Slack redrive IS a funnel caller). Also: pending-relay-store (src/messaging/pending-relay-store.ts — Layer 2, extended additively); DeliveryFailureSentinel (src/monitoring/delivery-failure-sentinel.ts — Layer 3, channel-typed); recovery-policy pure module (src/monitoring/delivery-failure-sentinel/recovery-policy.ts — reused byte-unchanged; Slack rows feed it through the §2.3 typed-result mapping); MessagingToneGate + checkOutboundMessage (src/core/MessagingToneGate.ts; src/server/routes.ts:2103); OutboundContentDedup (src/messaging/OutboundContentDedup.ts); slack-reply.sh template refresh machinery (src/core/PostUpdateMigrator.ts:7792-7799)"
supervision: "tier0 — a DELIBERATE, standard-aware exception declared per the keystone §6.2 pattern (P7): the queue drain + recovery state machine is a byte-deterministic pipeline with no judgment call to wrap (policy is the pure recovery-policy module, exhaustively table-testable; the §2.3 typed-result mapping is a static table); the LLM judgment call in the path is the EXISTING MessagingToneGate, which keeps its own supervision posture. NAMED supervisor-equivalent: the §7 three-tier suite + the live-proof scenario — they verify the exact property an LLM validator would eyeball (did the state machine converge each row to the one correct terminal?), mechanically."
eli16-overview: "slack-outbound-robustness.eli16.md"
project: "two-goal-roadmap Phase 2.1 (topic 29836)"
review-convergence: "2026-07-03 — architecture-converged-with-build-residual (round 8); review ceremony CLOSED under standing Session-A operator preapproval (topic 29836). Not the 0C/0M form — the single accepted residual (R8-M1) is carried into the build as its first test-backed increment (see review-disposition + accepted-build-residual)."
approved: true  # build-authorization approval: the operator ratified closing the review at architecture-converged-with-build-residual and authorized the build (Session-A preapproval, topic 29836, 2026-07-03 — recorded verbatim in review-disposition below). Not a claim of 0C/0M convergence; it authorizes the build increments carrying R8-M1 as their first tested task.
review-disposition: "architecture-converged-with-build-residual — 8-round /spec-converge ceremony (internal six-lens panel + two external cross-model doors per round: pi→openai-codex/gpt-5.5, gemini-cli/gemini-2.5-pro; codex-cli honestly absent). Trajectory of blocking findings: 3C+6M → 2C+3M → 2C+2M → 0C+1M → 1C+1M → 1C+1M → 0C+2M → 0C+1M. Round 8 verdict NOT 0C/0M, so NOT `approved: true` — instead CLOSED at architecture-converged under the standing Session-A operator preapproval (topic 29836, 2026-07-03). All load-bearing structural decisions (funnel-hop delivery authority, HOLD-as-durable-disposition + partition order, pre-POST delivery-id mint, notice_pending durability, per-channel breaker, fail directions) survived 4-8 adversarial re-walk rounds unchanged (cores finding-free rounds 4-8). The remaining risk is a single accepted build-phase pin-class RESIDUAL — see `accepted-build-residual` below."
accepted-build-residual: "R8-M1 (round-8 findings §The blocking finding; docs/specs/reports/slack-outbound-robustness-round8-findings.md): the reservation's new `409 delivery-in-flight` status + the in-reservation adapter-timeout outcome do not compose with the DEPLOYED recovery-policy / script classifiers on every lane. The build increment MUST: (a) classify structured `409 delivery-in-flight` → RETRY on BOTH lanes — recovery-policy.ts gains ONE named 409 branch (reconciling the 'recovery-policy byte-untouched' claim as a single tested exception, NOT a silent one), OR the Telegram redrive lane routes 409 through a translation shim before `evaluatePolicy` (recovery-policy.ts:189 currently escalates all unlisted 4xx incl. 409); (b) the adapter-timeout handler RESPONDS 408 (→ finalize-ambiguous, never re-posted), NOT the deployed 500 catch-all (routes.ts:12250 → retry → double-post); (c) both reply-script classifiers treat 409 as NON-LOSING. Each arm is a deterministic truth-table entry with its §7 test already specified in shape — resolved and TESTED in code under the Testing Integrity Standard (Tier-1 recovery-policy table tests + Tier-2 real-middleware route tests + full-pipeline redrive tests), which is strictly stronger enforcement than a further prose round. Accepted per operator decision 2026-07-03 (standing Session-A preapproval) as the first build-increment task carrying its own test."
review-disposition-date: "2026-07-03"
single-run-completable: false
---

# Slack Outbound Delivery Robustness (roadmap Phase 2.1)

> **Review disposition (2026-07-03) — CEREMONY CLOSED, `architecture-converged-with-build-residual`.**
> An 8-round `/spec-converge` ceremony (internal six-lens panel + pi gpt-5.5
> and gemini-2.5-pro external doors each round) drove blocking findings
> 3C+6M → … → 0C+1M. The architecture is converged (all structural
> decisions finding-free rounds 4-8). Round 8 did not reach 0C/0M, so this
> spec is **NOT `approved: true`** — it is CLOSED at architecture-converged
> under the standing Session-A operator preapproval (topic 29836), carrying
> exactly ONE accepted build-phase residual (**R8-M1**, the reservation
> `409`/adapter-timeout status composition — see the `accepted-build-residual`
> frontmatter key and `docs/specs/reports/slack-outbound-robustness-round8-findings.md`).
> The residual is resolved and TESTED in code under §7 Testing Integrity
> gates (stronger than a further prose round). **The BUILD stays gated on the
> keystone (durable-conversation-identity) registry + `deliverToConversation`
> increments MERGING** — a Session-B item, not authorized by this closure.

## 0. Operator-visible properties (what the review ceremony defends)

These are the guarantees an operator can hold this feature to. Each is asserted
by a named test in §7 and each failure of one is a bug, not a tuning issue.

1. **Exactly-once per delivery-id.** A Slack reply that carries an
   `X-Instar-DeliveryId` is delivered to the channel AT MOST once per id at the
   server (24h DURABLE id-ledger + hot in-memory LRU, §2.4 — upgraded from the
   Telegram lane's in-memory-only LRU, whose restart wipe left a derivable
   double-post window; round-1 M4), and AT LEAST once via the durable queue +
   sentinel redrive — converging to exactly-once, with THREE honestly-named
   residuals: (a) an **ambiguous** outcome (HTTP 408 / response-lost after the
   Slack API may have accepted the post) finalizes as `delivered-ambiguous`
   and is NEVER blindly re-posted — on the script lane via
   `recovery-policy.ts` `finalize-ambiguous` (`slack-reply.sh:108-117` already
   prints the AMBIGUOUS guidance), and on the FUNNEL lane via the §2.3
   ambiguous typed result mapped to the same terminal (round-2 M1 — the
   funnel must surface ambiguity distinctly; a retried ambiguous send is only
   accidentally safe); (b) the **crash-between-accept-and-record window**
   (round-2 M1): if the process dies after Slack accepts a post but before
   the durable id-ledger records it, ONE duplicate of that message is
   derivable at the next redrive — bounded, visible, the same accepted
   residual class as the keystone's R8-M1 ("at most one duplicate per
   crash-during-send"); (c) **the id-ledger degradation window** (round-3
   M2): when the durable ledger fails to open, §2.4 deliberately degrades to
   in-memory-only rather than blocking delivery — while degraded, the
   restart-window double-post of round-2 M4 is live again until the ledger
   heals (the degradation is loudly reported the moment it happens). Content
   dedup (§2.5) is the second net under all three windows. The
   at-LEAST-once arm is bounded by the LOUD terminal paths (round-5 m1) —
   the tone-gate verdict (property 5), TTL / held-retention escalation
   (properties 2, §5), the boot staleness purge for never-classified rows
   (§2.3 decision), and stampede consolidation (property 3) — every one a
   P18 counter + ledger row (property 4), never a silent drop.
2. **Bounded retry with backoff.** Redrives follow the deployed 9-step schedule
   (30s → 4h, `recovery-policy.ts:60-70`) with a hard 24h TTL
   (`recovery-policy.ts:72`) — reused BYTE-UNCHANGED. No new schedule is
   invented for Slack.
3. **One deduped escalation per failure episode (P17).** When retries exhaust,
   the operator hears about it ONCE per delivery (the `escalated` terminal
   state), and a per-conversation stampede collapses to ONE digest
   (`delivery-failure-sentinel.ts:648-668` — inherited; grouping keys on
   `topic_id`, which under Phase 1 is the minted id, so it already groups
   per-conversation for Slack with zero changes).
4. **Every drop is a counter + ledger row (P18).** There is NO silent-deletion
   path: restore-purge lists victims and reports a degradation before deleting
   (`delivery-failure-sentinel.ts:670-705` — the 2026-06-05 lesson, inherited)
   AND is SCOPED to live-enabled channels + `hold_reason IS NULL` rows (§5 —
   a lane or row that was never allowed to drain can never have its rows
   purged, by durable DISPOSITION rather than timing; round-1 C2 + round-2
   C1/C2);
   every state transition additionally lands one JSONL row in
   `logs/delivery-recovery.jsonl` (§4.2, NEW — this is the "sentinel audit row"
   of the roadmap's live-proof clause), channel-tagged.
5. **Fail direction argued at every failure point (§3).** The delivery layer
   fails toward DELIVERY for conversational replies — per the constitution
   standard *"The Operator Channel Is Sacred — Critical-Path Gates Fail Toward
   Delivery"* (docs/STANDARDS-REGISTRY.md:136) and its sibling *"Guards
   Degrade, Not Outage."* Concretely: a queue-open failure degrades to today's
   direct send (never capture-and-drop); a sentinel failure leaves rows queued
   (never deleted); ONLY the tone gate's own content verdict may withhold a
   message, and the sentinel never overrides it (signal-vs-authority,
   `delivery-failure-sentinel.ts:21-24`).
6. **No unbounded loops (P19) — with PER-CHANNEL blast radius.** The
   escalation circuit breaker mechanism
   (`delivery-failure-sentinel.ts:592-614` — N consecutive escalation failures
   in a window trips suspension; config-rotation or manual `resume()` unsuspends)
   is inherited by the Slack lane, but escalation-failure accounting and the
   suspension state become PER-CHANNEL (§2.3 point 5 — round-1 M2: a Slack
   channel-state outage must never suspend Telegram redrives); the per-topic
   rate cap (`perTopicRateMs`, `:66-67`) and `maxConcurrent` (`:68-69`) bound
   drain throughput; the selector is LIMIT-bounded
   (`pending-relay-store.ts:375-390`).
7. **One delivery authority (round-1 M1).** Every Slack delivery this spec
   causes — redrive, escalation, stampede digest, recovered marker, tone-gate
   meta-notice — goes through the keystone's `deliverToConversation` funnel
   (ownership §5.0, id↔tuple coherence §3.5.2, permanent-error classification
   §5.1, P17 budgets §5.2, E1 content-hash lane §5.0(a)). The sentinel never
   re-implements a resolve-and-POST beside the funnel. Telegram rows keep
   `defaultPostReply` byte-identically.

## 1. Problem — the grounded gaps (every claim cited)

The Telegram outbound path is a seven-layer robustness stack. The Slack
outbound path is a single ungated-or-once-gated HTTP hop. Side by side:

| Property | Telegram (deployed) | Slack (deployed) |
|---|---|---|
| Tone gate on the reply route | `/telegram/reply/:topicId` → `checkOutboundMessage` (`routes.ts:11286-11298`) | `/slack/reply/:channelId` → `checkOutboundMessage` (`routes.ts:12176-12186`) — **present** |
| Tone gate on the internal route | `/internal/telegram-forward` is INBOUND (session inject + sentinel intercept + exactly-once ledger, `routes.ts:16961+`) | **`/internal/slack-forward` calls `ctx.slack.sendToChannel(channelId, text)` with NO gate, NO dedup, NO delivery-id** (`routes.ts:12233-12251`) — the audit's "one internal route bypasses even that" |
| Delivery-id idempotency | `X-Instar-DeliveryId` 24h LRU (`routes.ts:1615-1641`, checked `:11173-11180`, recorded `:11372-11376`) | **absent** — `/slack/reply` never reads the header |
| Content dedup (same text, fresh id) | `OutboundContentDedup`, SQLite-backed, before the gate (`routes.ts:1644-1660`, `:11272-11276`, recorded `:11324`) | **absent** — a Slack re-announce after restart double-posts |
| Durable failure queue (Layer 2) | script-side SQLite enqueue + `POST /events/delivery-failed` (`src/templates/scripts/telegram-reply.sh:391-666`; store `src/messaging/pending-relay-store.ts`) | **absent** — `slack-reply.sh` exits 1 and the message is GONE (`src/templates/scripts/slack-reply.sh:128-131`) |
| Recovery sentinel (Layer 3) | `DeliveryFailureSentinel` — state machine, backoff, breaker, restore-purge (`src/monitoring/delivery-failure-sentinel.ts`) | **absent** — and the sentinel is structurally Telegram-only today (below) |
| Adapter-level send | `sendToTopic` with relay/dedup/kind-metadata layers | `chat.postMessage`, one shot, no retry (`src/messaging/slack/SlackAdapter.ts:565-579`) |

The sentinel's Telegram hardcodes (what "channel-typed" must actually touch):

1. **Tone-gate channel**: `checkToneLocally(this.deps.toneGate, text, { channel: 'telegram' })`
   — `delivery-failure-sentinel.ts:439-441`. (The keystone's consumer
   inventory flags exactly this — durable-conversation-identity.md §6.0 row 5.)
2. **Redrive target**: `defaultPostReply` POSTs `/telegram/reply/${topicId}`
   (`delivery-failure-sentinel.ts:770`), with Telegram-shaped headers.
3. **Escalation/stampede/recovered-marker sends** all reuse the same
   `postReply` → Telegram (`:513`, `:575`, `:657`, `:492`).
4. **Schema**: `topic_id INTEGER NOT NULL` (`pending-relay-store.ts:111`) and
   no channel discriminator anywhere in the row (`:61-83`).

Everything else in the sentinel — the lease/claim CAS, the pure recovery
policy, the breaker, the restore-purge, the stampede digest, per-topic rate
caps — is channel-generic already. The generalization is small and additive.

### 1.1 Why this is Phase 2.1 and not earlier

Until Phase 1 lands, a Slack conversation has NO durable address to queue
under: the routing key `C…[:thread_ts]` is a transient string and the
negative-hash bridge is triplicated and collision-blind
(durable-conversation-identity.md §1). The keystone mints a stable NEGATIVE
integer id per Slack conversation and makes the registry the join table
(key ⇄ tuple ⇄ minted id). That single fact is what makes this spec cheap:
**`topic_id INTEGER NOT NULL` can carry a Slack conversation UNCHANGED.**
The keystone explicitly defers this lane here (durable-conversation-identity.md
§11.1) and provides the resolve primitive the sentinel needs (§6.0 row 5).

**Build gate (depends-on, restated normatively):** the keystone CONVERGED at
round 11 (commit aa5086eb8, `review-convergence: 2026-07-03`,
`approved: true`) — condition (a) is MET. This spec's BUILD must still not
start until (b) the keystone's registry + `deliverToConversation` funnel
increments are merged. Every `registry.resolve(id)` and every
`deliverToConversation(...)` call below is against that landed code.

## 2. Design

### 2.0 Shape of the change (one paragraph)

Extend the EXISTING three layers rather than building parallel Slack ones.
Layer 2 (`PendingRelayStore`) gains six additive columns — `channel`
(default `'telegram'`), `conversation_ref` (audit + drain-time coherence
input, never delivery authority), `hold_reason` + `hold_started_at` (the
durable HOLD disposition and its retention anchor, §2.2a), `released_at`
(the release purge-grace breadcrumb), and `notice_pending` (the terminal
out-of-band notice marker) — via the store's existing idempotent-ALTER
machinery. Layer 1 (`slack-reply.sh`) gains the same recoverable-failure
classifier + enqueue + `POST /events/delivery-failed` tail that
`telegram-reply.sh` already has, writing `channel:'slack'` rows addressed by a
TUPLE-VALIDATED minted id (§2.6 — no id, no enqueue). Layer 3
(`DeliveryFailureSentinel`) dispatches per-row on `channel`: Telegram rows keep
`defaultPostReply` byte-identically; Slack rows deliver THROUGH the keystone's
`deliverToConversation` funnel, whose typed results feed the untouched pure
policy via a pinned mapping table (§2.3); escalation-failure accounting and
restore-purge become channel-scoped. `/slack/reply` gains delivery-id
idempotency (durable ledger + hot LRU) + content dedup like the Telegram
route; `/internal/slack-forward` becomes a typed refusal until Phase 2.2
re-points it. One new JSONL audit ledger records every transition.

### 2.1 Addressing — everything is a minted id (the Phase-1 contract)

- **The queue row's primary address is `topic_id`**, unchanged. For Slack rows
  it holds the keystone's minted NEGATIVE id (`id < 0` ⇄
  `(slack, channelId, threadTs?)`; durable-conversation-identity.md §0, §2).
  Positive ids remain Telegram verbatim. NO string channel-id column becomes a
  routing key — reach the transport address by `registry.resolve(id)` at DRAIN
  time, never by persisting `C…:<ts>` as authority.
- **Resolve at drain time, not enqueue time — and delivery happens INSIDE the
  funnel (round-1 M1).** A row can sit queued for up to 24h; delivering at
  redrive through `deliverToConversation(row.topic_id, …)` means a teamId
  backfill or registry heal that happened meanwhile is honored, and the
  funnel's own guards (ownership §5.0, coherence §3.5.2, permanent-error
  classification §5.1) run on every attempt. An UNRESOLVABLE minted id at
  drain time is the funnel's typed failure, mapped to a HOLD (§2.3) — never a
  silent drop, never a guess-delivery (keystone §5, `id<0` unresolvable arm).
- **`conversation_ref` (new column) is audit + drain-time COHERENCE INPUT —
  never delivery authority (round-1 M1, keystone §3.5.2 R5-M2/R6-M4 parity).**
  It stores the canonical key string
  (`slack:<teamId>:<channelId>[:<threadTs>]`) captured at enqueue — built
  from the SCRIPT'S OWN `CHANNEL_ID[:THREAD_TS]` argument, NEVER from session
  context (round-2 m2: the drain-time check's entire value is that the ref
  records where the send was actually AIMED; a ref sourced from the context
  pair would validate a forged/stale pair against itself). At drain, the
  `(channelId[,threadTs])` TAIL of `conversation_ref` must match the tuple
  `resolve(row.topic_id)` yields AND the teamIds must be COMPATIBLE (round-2
  M2): a `_` placeholder on either side matching a concrete teamId is benign
  (the `_`→teamId upgrade path); a CONCRETE-vs-CONCRETE teamId mismatch is
  incoherent even when the tail matches — no legal registry transition
  rewrites one concrete teamId to another, so per the keystone's R6-M4 logic
  the pair affirmatively proves corruption. Any mismatch (tail or concrete
  teamId) is the typed `conversation-binding-incoherent` verdict — a HOLD +
  ONE deduped attention item, NEVER a delivery on either field (mirroring the
  keystone's bind-pin delivery-time coherence check: an id and its captured
  tuple disagreeing is the C3-class misdelivery signature, and the converged
  posture is refusal, not diagnosis-and-deliver). A NULL `conversation_ref`
  on a `channel:'slack'` row fails CLOSED to the same incoherent HOLD +
  attention item (round-3 m4): no legacy Slack rows can exist — the column
  ships with the lane and the script always writes it — so NULL there is
  anomalous by construction (Telegram rows are exempt; the check is
  Slack-scoped). The ref is never itself resolved to deliver.
- **Thread delivery**: the funnel's `id < 0 (normal)` arm already resolves
  `threadTs?` and POSTs `/slack/reply/:channelId` with `thread_ts`, so a
  thread conversation delivers IN-THREAD (durable-conversation-identity.md §5)
  — the redrive inherits it by being a funnel caller.
- **Relationship to the keystone's E1 funnel guard (restated to the CONVERGED
  §5.0(a) — round-1 M3; the draft's beacon-only description was written
  against the round-6 snapshot).** E1 is a TWO-LANE ambiguous-outcome
  idempotency guard covering ALL `id<0` funnel callers: (a) a
  RETIREMENT-scoped logical lane keyed `(conversationId,
  commitmentId:sendSeq)` for beacon traffic, and (b) a 15-min WINDOW
  content-hash lane for identity-less callers (attention items, reap notices,
  and — via §2.3 — this sentinel's own escalations/digests/markers), with
  durable `send-intent` journaling before each guarded transport handoff and a
  LANE-SCOPED crash-window boot conversion (a crash-orphaned one-off-notice
  intent resolves toward RETRY so the notice is never silently lost; a beacon
  intent suppresses-on-unknown, superseded by its next cadence tick). The
  layering this spec pins: FUNNEL callers are protected by E1 + the route's
  §2.4/§2.5 idempotency (which the funnel hop passes through); SCRIPT sends
  are protected by the queue state machine + §2.4/§2.5. The funnel mints NO
  delivery-id of its own — `X-Instar-DeliveryId` reaches the route only when
  a caller passes one via `opts.deliveryId` (the §2.3 redrive does; beacon
  sends do not, and rely on E1). Neither layer replaces the other.

### 2.2 Layer 2 — channel-typed `PendingRelayStore` (additive, migration-parity)

Schema change, riding the deployed idempotent `COLUMN_ADDS` pattern
(`pending-relay-store.ts:134-143` — "if column missing, ALTER TABLE ADD
COLUMN", duplicate-column errors swallowed):

```sql
ALTER TABLE entries ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE entries ADD COLUMN conversation_ref TEXT;  -- canonical key: audit + drain-time coherence input (§2.1)
ALTER TABLE entries ADD COLUMN hold_reason TEXT;       -- durable HOLD disposition (§2.2a) — NULL = deliverable
ALTER TABLE entries ADD COLUMN hold_started_at TEXT;   -- when the current continuous hold began (§2.2a, round-3 M1)
ALTER TABLE entries ADD COLUMN released_at TEXT;       -- when the last hold was RELEASED (§2.2a, round-5 C1) — purge grace anchor
ALTER TABLE entries ADD COLUMN notice_pending INTEGER NOT NULL DEFAULT 0;  -- terminal row's out-of-band notice not yet accepted (§2.3, round-5 M1)
```

- **Never destructive.** No column is renamed, retyped, or dropped; no row is
  rewritten. Every legacy row reads as `channel='telegram'` by DEFAULT — the
  existing Telegram lanes (DFS Telegram drain, ReapNoticeDrain's
  `reap-notify:` PK-range lane, `pending-relay-store.ts:399-414`) are
  byte-identically served. A ROLLED-BACK binary ignores the six unknown
  columns and keeps working (SQLite reads by name) — the same
  forward/backward-compat argument the `message_metadata` column shipped with
  (`pending-relay-store.ts:139-142`). **Rollback honesty for SLACK rows
  (round-3 L2):** a rolled-back sentinel has no channel dispatch and would
  redrive a queued Slack row via `POST /telegram/reply/<negative id>` — which
  the keystone's pinned guard answers 400, and the deployed policy classifies
  400 as `escalate` (terminal). Loud, never a misdelivery, never a retry
  loop — the rollback degrades queued Slack rows to loud escalation, not
  silence.
- `PendingRelayRow` gains `channel: string`, `conversation_ref: string | null`,
  `hold_reason: string | null`, `hold_started_at: string | null`,
  `released_at: string | null`, and `notice_pending: 0 | 1`; `EnqueueInput` gains optional `channel`
  (default `'telegram'`) and `conversation_ref`. `enqueue()` idempotency on
  `delivery_id` is unchanged (`pending-relay-store.ts:236-271`).

**§2.2a HOLD is a durable DISPOSITION, not a timestamp accident (round-2
C1/C2 — the load-bearing round-3 change).** Round 2 falsified the round-1
folds' protection mechanism: held rows were protected only by
`next_attempt_at` arithmetic (which the boot purge outruns across a downtime)
and by dropping out of the selector (which the stampede path outruns at first
sight). The fix is structural: every held row carries an explicit
`hold_reason` (`disabled-channel` | `dry-run` | `non-owning` | `unresolvable`
| `binding-incoherent` | `no-adapter` | `funnel-budget`) plus a
`hold_started_at` timestamp (round-3 M1 — set when `hold_reason` transitions
NULL→non-NULL, PRESERVED across reason relabels so a row bouncing
`non-owning`→`funnel-budget` is still continuously held, cleared only on
release-to-deliverable; no existing column can carry "held since" —
`attempted_at` mismeasures a row that retried live for hours before being
held, and `next_attempt_at` is the pushed liveness knob). Both fields are written ATOMICALLY in the
same `transition()` write (single transaction — round-4 m2), stored as
ISO-8601 UTC strings (`YYYY-MM-DDTHH:mm:ss.sssZ`, the store's existing
timestamp convention — round-4 L1); defensively, a held row observed with
`hold_started_at NULL` (corruption, partial migration) gets the anchor
repaired to the row's `attempted_at` — NEVER `now` (round-5 m2: repairing
at observation RESETS the retention clock, handing a corrupt 6-day-held row
a fresh 7 days, repeatably; `attempted_at` is never LATER than the truth,
so the conservative error direction is an EARLY, loud long-stop) — plus one
ledger row. The second-observation detector needs NO separate memory
(round-6 m3): the repair's durable write IS the state — observing NULL
again on a later tick proves the previous repair did not stick (storage
corruption) and the row escalates immediately; an in-cycle
repair-transaction FAILURE likewise escalates immediately rather than
looping. No corrupt-held row can
sit purge-exempt outside the long-stop (round-4 m2 + round-5 m2). The reason is set
the moment the disposition is decided and CLEARED when the row is released
for a real attempt. Three consumers key on it:

1. **The purge predicate** (§5) skips any row with a live `hold_reason` — in
   ADDITION to being scoped to LIVE-enabled channels — and its staleness
   base for a PREVIOUSLY-HELD row is `max(attempted_at,
   COALESCE(released_at, attempted_at))` — the COALESCE is load-bearing
   (round-6 m1: SQLite scalar `max()` returns NULL when any argument is
   NULL; the naive translation would disable the staleness predicate for
   every never-held row, an ancient-message-delivery regression on the
   Telegram lane the spec forbids — §7 pins the Telegram-parity case: a
   never-held row >60min old still purges at boot). `released_at` gets the
   SAME far-future corruption clamp `next_attempt_at` has (round-6 m1).
   The grace gives a released backlog a fresh 60-min drain window —
   **honest arithmetic (round-6 m4): the watchdog-only drain moves ~4
   rows/5-min tick ≈ 48/hour, so the grace covers realistic soak backlogs
   (dozens of rows); a mass backlog's tail past the grace purges LOUDLY at
   the next restart — a stated decision (P18-loud, preferable to
   hours-late delivery per the staleness philosophy), not an accident** —
   while the 24h TTL stays anchored on `attempted_at` (release grants
   purge GRACE, never extended deliverability — the §5 held-past-TTL
   decision is unchanged). Held rows
   are bounded by the §5 held-retention long-stop (loud escalation, never a
   silent delete), not by the 60-min staleness purge.
2. **The drain's DISPOSITION PARTITION runs on the selector's results BEFORE
   stampede grouping** (round-2 C1 — the placement is pinned, resolving the
   §2.2/§5 ambiguity round 2 flagged). Per selected row, in order:
   1. **Known-channel validation FIRST** (round-3 m2 — resolves the §2.3-6 /
      §5 ordering contradiction): a `channel` outside the known enum
      (`telegram`, `slack`) is the immediate `escalated:
      unsupported-channel` terminal (P19) — a corrupt value never parks to
      the long-stop.
   2. **Long-stop check** (round-3 M1): a held row with
      `now − hold_started_at ≥ heldRetentionMs` exits here — `escalated:
      held-retention-exceeded` + the §5 out-of-band item — BEFORE any
      re-hold.
   3. **HOLD RELEASE is re-evaluated per reason — a durable hold has a
      durable release rule (round-3 C2; the round-3 text's
      "prior-verdict-left-a-live-hold ⇒ re-hold" reading self-deadlocked
      every verdict-hold, including a LIVE-lane `funnel-budget` hold that
      would have parked a deliverable message to the 7-day terminal).**
      CONFIG-holds (`disabled-channel`, `dry-run`) release when the
      partition's config check says the lane is LIVE-enabled; VERDICT-holds
      (`non-owning`, `unresolvable`, `binding-incoherent`, `no-adapter`,
      `funnel-budget`) are RE-EVALUATED by their CHEAP LOCAL predicate — the
      keystone §5.0 `ownsConversation(id)` is a local adapter + local-origin
      registry read; the §2.1 ref coherence compare is local; adapter
      presence is local; the P17 budget window is local. Condition cleared →
      CLEAR `hold_reason` + `hold_started_at` AND STAMP `released_at = now`
      (round-5 C1 — release must leave a durable breadcrumb: a released
      soak/dark-lane row is >60 min old BY CONSTRUCTION, and without the
      breadcrumb it is indistinguishable from a genuinely-stale row to the
      boot purge — a restart during the rate-capped post-flip drain window
      would purge the exact backlog the hold architecture protects) → the
      row enters the NORMAL flow this tick (grouping included — it is now
      genuinely deliverable, so live-lane stampede semantics legitimately
      apply); condition persists → RE-HELD (push `next_attempt_at` by the §5 hold-recheck
      cadence, emit the dryRun would-redrive ledger row when applicable).
   4. Rows to hold (fresh disabled/dry rows, persisting verdict-holds) NEVER
      enter `groupByTopic` — so stampede accounting, digest posting, and the
      all-but-newest `delivered-ambiguous` consumption apply ONLY to rows
      the drain may actually deliver on this tick. §7 pins the
      burst-in-held-posture shape (6+ held rows on one conversation → zero
      TERMINAL (`delivered-*`/`escalated`) transitions, zero posts — the
      re-hold itself is a bookkeeping `transition()` write) AND the heal
      shapes (a `non-owning` hold delivers within one recheck cadence of
      ownership arriving; a `funnel-budget` hold delivers after its window;
      no verdict-hold is ever re-held while its predicate is clear — the
      deadlock regression).
3. **The §4.1 status surface** counts held rows by `hold_reason`.

- **Selectors stay channel-agnostic in SQL; the DRAIN is channel-aware.**
  `selectClaimable` (`:375-390`) returns rows of every channel; the SENTINEL
  partitions by disposition (§2.2a) then dispatches per-row (§2.3). A row
  whose channel is NOT in the enabled `channels` set is held via §2.2a
  (`hold_reason:'disabled-channel'` — purge-exempt by DISPOSITION, counted on
  the §4.1 disabled-backlog surface; round-1 C2 + round-2 C1/C2). Rationale
  for one loop: one claim/lease path and one rate-cap bookkeeping — while
  breaker SUSPENSION state is per-channel (§2.3 point 5, P19). The
  reap-notify PK-range exclusion is untouched.
- New index: none required. The dedup-window query
  `findByTopicAndHashWithin` (`:285-299`) already keys on
  `(topic_id, text_hash)` which is unique across channels because minted ids
  are globally unique (keystone §3.3 mint rule); the §2.3 terminal notice
  sweep gets ONE new PARTIAL index (round-7 m2 — corrects round-6 L2's
  "fully served" overclaim: `notice_pending` is a post-filter on the
  state-prefix, and terminal rows accumulate, so months of escalated rows
  would force broad scans per tick):
  `CREATE INDEX IF NOT EXISTS idx_notice_pending ON entries(state,
  next_attempt_at) WHERE notice_pending = 1` — tiny by construction (only
  pending-notice rows), idempotent via the existing schema machinery.
- The dual writer parity note: `telegram-reply.sh` embeds its own schema
  bootstrap + INSERT (`src/templates/scripts/telegram-reply.sh:500-560, 604-625`).
  Its CREATE/ALTER mirror gains the same six columns; `slack-reply.sh`'s new
  enqueue path (§2.6) shares that exact embedded SQL shape. The
  TemplatesDriftVerifier (Layer 7) covers both scripts already.

### 2.3 Layer 3 — `DeliveryFailureSentinel` channel dispatch (the funnel IS the Slack hop — round-1 M1/M2)

The sentinel gains a small per-channel delivery table; everything stateful is
shared. The load-bearing round-2 change: **for `channel:'slack'` rows the
delivery hop is `deliverToConversation`** — the keystone's one delivery
authority — never a bespoke resolve-and-POST. This buys, with zero
re-implementation: the §5.0 `ownsConversation(id)` gate (a non-owning machine
STANDS DOWN instead of burning the TTL — keystone stand-down semantics), the
§3.5.2 delivery-time id↔tuple coherence refusal, the §5.1 permanent-error
classification (`is_archived` / `channel_not_found` / `not_in_channel` →
`conversation-unreachable`, with the drift canary), the §5.2 per-conversation
+ global P17 budgets, and the §5.0(a) E1 content-hash lane for the sentinel's
own notices. Per row:

1. **Tone gate (pre-check)**: `checkToneLocally(gate, text, { channel:
   row.channel })` — replacing the hardcode at
   `delivery-failure-sentinel.ts:439-441`. The gate already accepts a string
   channel (`src/core/MessagingToneGate.ts:525`; `/slack/reply` passes
   `'slack'` today, `routes.ts:12177`). Deployed semantics kept EXACTLY
   (round-1 M5): a clean `passed:false` verdict finalizes
   `delivered-tone-gated`; a gate ERROR fails OPEN at this pre-check
   (`src/messaging/local-tone-check.ts` — `passed:true, failedOpen:true`,
   the sentinel proceeds) and the ROUTE-side gate then owns the availability-failure
   direction (`failClosedMode` tri-state, `src/core/MessagingToneGate.ts:608-621`);
   the policy layer classifies whatever status the route returns. No behavior
   change is proposed on either channel.
2. **Redrive**: `deps.postReply` becomes `deps.postReplyFor(channel)` —
   `'telegram'` keeps `defaultPostReply` (`:734-793`) verbatim; `'slack'`
   calls `deliverToConversation(row.topic_id, text, { deliveryId:
   row.delivery_id, metadata: row.message_metadata (forwarded WHOLE — kind,
   allowDuplicate, formatMode ride there, matching defaultPostReply's parity;
   round-1 MINOR-4), systemTemplate: <true for fixed templates> })`. THREE
   ADDITIVE funnel opts are pinned here (round-2 L1 — the keystone's opts
   contract is extensible by design, and this spec owns scoping every
   extension it consumes): `deliveryId` — forwarded to the route as
   `X-Instar-DeliveryId` so §2.4 idempotency sees the redrive;
   `systemTemplate` — forwarded as `X-Instar-System`, where the ROUTE's
   compiled-in membership check (`matchesSystemTemplate` + build-time SHA
   integrity) remains the sole bypass authority (the flag is a transport
   marker, never trust); and `metadata` — the queue row's serialized kind
   blob, forwarded to the route body's `metadata` field (the funnel maps it
   through; its `allowDuplicate`/`messageKind` fields land exactly where the
   keystone's pinned per-field opts land). **Two ADDITIVE funnel TYPED-RESULT
   requirements are pinned the same way (round-2 M1 — the mapping table below
   consumes result vocabulary the keystone deliberately left to this lane):**
   (a) an ambiguous/likely-posted transport outcome (route 408, or
   accepted-but-ack-lost observed by the funnel) is surfaced DISTINCTLY
   (e.g. `not-delivered` with pinned reason `ambiguous-likely-posted`), never
   folded into plain transient; (b) a route tone-gate VERDICT (422) is
   surfaced DISTINCTLY — without it a tone-gated Slack row is
   indistinguishable from transient and would burn the 24h TTL before
   escalating. Before the funnel call, the drain runs the `conversation_ref`
   tail+teamId coherence check (§2.1) — mismatch is the typed incoherent
   HOLD, no funnel call.
3. **Typed-result → policy mapping (pinned; replaces raw-HTTP classification
   for Slack rows — the pure `evaluatePolicy` stays byte-untouched, fed
   through this static table):**

   | Funnel result | Row disposition |
   |---|---|
   | delivered | `finalize-success` (+ §2.4 ledger record rides the route) |
   | `already-delivered-recently` (E1/route dedup suppression) | `finalize-success` — DELIVERED-EQUIVALENT, keystone R7-M1 posture |
   | ambiguous / likely-posted (`ambiguous-likely-posted` — the pinned additive surfacing above; round-2 M1) | `finalize-ambiguous` — terminal, NEVER re-posted (Telegram-lane parity; §0 property 1). The E1 entry + §2.4 id-ledger remain the nets if a caller manually resends |
   | tone-gate VERDICT withhold (route 422 — the pinned additive surfacing above) | `finalize-tone-gated` + meta-notice (unchanged semantics) |
   | `conversation-unreachable` (§5.1 PERMANENT) | terminal `escalated` with reason `conversation-unreachable` — NO 24h retry burn; the operator notice goes OUT-OF-BAND (below) |
   | non-owning / unresolvable / `conversation-binding-incoherent` / no local Slack adapter | **HOLD** (§2.2a — `hold_reason` set; `next_attempt_at` pushed to the §5 hold-recheck cadence); NO attempt increment, NO breaker arm, NO escalation (keystone stand-down: a by-design refusal is not a delivery failure) + ONE deduped attention item per row-class episode |
   | §5.2 budget-coalesced / overflow (round-2 m4) | **HOLD** (`hold_reason:'funnel-budget'`) — a P17 budget refusal is a by-design refusal, not a delivery failure: NO attempt increment, NO breaker arm, never a terminal; the row retries after the window |
   | `delivery-in-flight` (route 409 — the §2.4 single-flight reservation; round-7 m5) | policy retry — a routine transient race, NO attention item (explicitly NOT the unmapped-result default below), NO breaker arm |
   | transient `not-delivered` | policy retry — backoff schedule unchanged |
   | dryRun / fleet-dark typed `not-delivered` | **HOLD** (`hold_reason:'dry-run'`), ledger row tagged `dryRun:true` (§5 — never success-shaped) |

   The table is TOTAL over the funnel's result vocabulary as consumed by this
   lane (round-2 M1/m4): any future funnel result not listed here maps to the
   transient row (retry — the direction that never loses a message) plus ONE
   deduped attention item naming the unmapped result, mirroring the keystone's
   drift-canary posture.

4. **Escalation / stampede digest / recovered marker / tone-gate-rejection
   notice** (`:513`, `:575`, `:657`, `:492`): for Slack rows these are
   identity-less one-off notices and ride `deliverToConversation` too —
   landing on the E1 content-hash lane + the §5.2 budgets (round-1 M1 arm).
   Fixed templates (`system-templates.ts`) are channel-neutral text and pass
   the `/slack/reply` gate under the same `X-Instar-System` membership check
   the Telegram route applies (`routes.ts:11182-11191`) — **which
   `/slack/reply` must therefore also implement** (§2.4 adds it, restricted
   to the same compiled-in template set, no runtime registration, §7-pinned).
   **Out-of-band exception (round-1 M2):** the escalation/dead-letter notice
   for a `conversation-unreachable` row does NOT target the failing
   conversation (structurally undeliverable — the archived-channel trap); it
   raises ONE deduped ATTENTION item (which aggregates mass events — the
   keystone's 60s coalescing-window posture) instead. **This path bypasses
   the escalation MACHINERY entirely (round-3 m5):** the unreachable
   terminalization writes the `escalated` transition and raises the
   attention item directly — it never invokes the deployed `escalate()`
   (the 2-attempt in-conversation post, `:571-580`) and never calls
   `recordEscalationFailure`, so an attention-surface hiccup on this path
   can never arm the per-channel breaker (it is a delivery-failure
   CLASSIFICATION, not a failure of the escalation machinery). **The notice
   itself is DURABLE, not best-effort (round-4 M1; mechanics pinned round-5
   M1 — both externals independently proved the round-5 text non-functional
   against the deployed selector):** the terminalization sets
   `notice_pending = 1` (the §2.2 column) in the SAME transition, and the
   attention raise gets deployed-parity bounded retry (2 attempts) in-line.
   Because the drain's claimable selector returns `queued`/`claimed` rows
   ONLY (a terminal row is invisible to it — `pending-relay-store.ts:
   375-390`), the re-raise runs on its OWN dedicated bounded selector —
   `state = 'escalated' AND notice_pending = 1 AND (next_attempt_at IS NULL
   OR next_attempt_at <= now)`, LIMIT-bounded, oldest-due-first, served by
   the new partial `idx_notice_pending` index (§2.2, round-7 m2 — the
   `notice_pending` predicate is not covered by the `(state,
   next_attempt_at)` prefix alone) — executed once
   per tick beside the claimable drain. **The sweep carries its own retry
   discipline (round-6 M1 — found independently by both externals; the
   path bypasses the per-channel breaker, so it must bring its own P19
   bound):** a TRANSIENT-failed raise pushes the terminal row's
   `next_attempt_at` forward per the existing 9-step backoff schedule,
   then holds a 4h floor cadence — `next_attempt_at` is FREE on a terminal
   row, so the backoff anchor is a reused column, not new state. **The
   step counter is the terminal row's `attempts` column, also free —
   frozen at escalation, incremented per failed raise from there; the
   schedule indexes `min(attempts, 8)` and converges to the floor
   naturally (round-7 m1; the hold-lifecycle ledger rows disambiguate the
   field's dual meaning on terminal rows). A PERMANENT-shaped raise
   rejection (4xx excluding 408/429 — the house permanent/transient split;
   round-7 m3) never retries: `notice_pending` clears with a P18 ledger
   row `notice-failed-permanent` + one loud DegradationReporter line, and
   the §4.1 status carries a distinct failed-notice count — never
   infinite, never silent.** Failed rows back off while
   fresh episodes get attempts (a poison row can never starve a later
   episode — the due-predicate + oldest-due-first ordering guarantee it),
   the retry rate against a down attention surface is schedule-bounded
   (never tick-frequency hammering), and nothing is ever silently
   abandoned — the marker plus the §4.1 pending count are the durable
   record. The attention item id is STABLE PER EPISODE,
   derived from `(conversation, delivery_id)` — a re-raise no-ops against
   the already-accepted item, while a DISTINCT later unreachable episode
   (a new row dying on the same conversation) raises a fresh item; mass
   episodes still aggregate under the keystone's 60s coalescing window. The
   marker clears ONLY on a 2xx from the attention surface, in its own
   transition. Honest bound (round-5 M1(d) + round-6 m2, mirroring property 1(b)): the
   notice is NEVER SILENTLY FORGOTTEN — retried until accepted, with the
   pending count surfaced on the §4.1 status (while the attention surface
   itself is down, the notice is pending-and-visible there, not delivered
   — the honest wording) — and at most ONE duplicate is possible per
   crash-between-accept-and-clear window; §7 pins the terminal-sweep path,
   the distinct-episode key, the transient-failure shape (raise fails once
   → the notice lands on a later tick), the poison-row fairness shape, and
   the outage shape (raises back off; on recovery all pending notices
   land). **Near-silent decision
   (conformance-gate flag, stated):** recovered markers and tone-gate
   meta-notices KEEP their in-conversation delivery for Telegram parity —
   each is a single short fixed template explaining a late/withheld message
   the user was actively missing (user-serving context, not lifecycle
   chatter), P17-bounded; routine recovery state otherwise stays in the
   ledger + `GET /delivery-recovery/status`.
5. **Per-channel breaker state (round-1 M2, P19).** `recordEscalationFailure`
   keys its failure window AND the `suspended` flag by channel: a Slack
   escalation-failure storm suspends the SLACK lane only; Telegram redrives
   continue (and vice versa). One breaker implementation, per-channel state;
   `maybeResume` config-rotation and manual `resume()` clear per-channel.
   §7 pins the isolation.
   **Accepted fairness bound (round-1 LOW-3, stated):** the single
   oldest-first LIMIT-100 selector means a large one-channel backlog can
   delay the other channel's redrives by ticks — bounded by `maxConcurrent`,
   the per-topic rate cap, and the 5-min watchdog cadence; accepted to keep
   ONE claim/lease path, revisited only if the §7 e2e shows starvation.
6. **An unknown `channel` value** (a future platform, or corruption) is a
   typed terminal: transition to `escalated` with reason
   `unsupported-channel`, one P18 ledger row, one degradation report — never a
   crash loop over the same row (P19).

Unchanged and shared: claim CAS + lease format (`:398-405`, `:385-395`),
`evaluatePolicy` and the backoff schedule (`recovery-policy.ts` —
byte-untouched), restore-purge semantics incl. the far-future clamp
(`pending-relay-store.ts:478-541`) — now scoped to LIVE-enabled channels AND
`hold_reason IS NULL` per §5 (round-1 C2 + round-2 C2), stampede grouping
(keys on `topic_id` = minted id — already per-conversation) — now fed ONLY
deliverable rows by the §2.2a disposition partition (round-2 C1: the deployed
stampede path consumes all-but-newest as `delivered-ambiguous` and posts a
digest, which must never touch a held/dark/dry row), per-topic rate cap
(`lastTopicDelivery` Map keyed by number — minted ids fit).

**Whoami gate scope**: the `/whoami` identity check (`:410-432`) protects
against replying through a rotated/foreign server config; it is
channel-independent and runs for Slack rows unchanged.

**Multi-machine posture, declared (integration mandatory-check).** The queue
is MACHINE-LOCAL BY DESIGN (a per-agent SQLite file beside the process whose
send failed — the failure and its retry belong to the machine that owns the
conversation's socket). The funnel's ownership gate makes that safe rather
than assumed: a row that lands on (or is orphaned on) a machine that does not
own the conversation HOLDS under stand-down semantics (§2.2a — once
CLASSIFIED, a durable disposition the boot purge cannot outrun; round-2 C2 +
round-4 m1 scoping) instead of burning
retries, and heals when ownership arrives (adapter comes up / topic moves
back) or ages out LOUDLY at the §5 held-retention long-stop with the
out-of-band notice (round-2 m1: the 24h TTL is drain-evaluated and cannot
bound a row that never drains — the long-stop is the honest ceiling for held
rows). **A NEVER-classified row is outside that guarantee BY DESIGN (round-4
m1):** a live-lane row enqueued while the server is down that is already
older than the 60-min staleness cutoff at boot is purged LOUDLY before its
first classification — byte-for-byte the deployed Telegram staleness
judgment (`restorePurgeAgeMs`, delivery-failure-sentinel.ts:80-90: not
redelivering genuinely ancient messages after a long outage beats late
delivery), inherited deliberately, with the honest residual named: in a
future multi-machine posture, a row that WOULD have classified as a
stand-down HOLD (ownership moved while the server was down) is purged as
stale instead — loud, never misdelivered, and unreachable in today's
single-Slack-machine reality. In today's single-Slack-machine reality the
holding case never occurs; active-active reconciliation is out of scope here —
it is owned by the keystone spec §11.2 (durable-conversation-identity.md),
already tracked there.

### 2.4 `/slack/reply` — delivery-id idempotency (DURABLE) + system-template bypass

Mirroring `/telegram/reply`'s helpers — with one deliberate upgrade both
routes share (round-1 M4):

- Read `X-Instar-DeliveryId`; if seen within 24h → `200 { ok, idempotent:
  true }` WITHOUT posting (`routes.ts:1615-1641` helpers are already
  route-file-scoped; the Slack route calls the same functions).
- **Single-flight per delivery-id (round-6 C1; ordering pinned round-7
  M2):** before calling `sendToChannel`, the route writes a short-TTL
  IN-FLIGHT reservation for the id into the durable ledger. **The TTL is
  pinned STRICTLY ABOVE the handler's maximum send lifetime** — the
  adapter call made under a reservation carries an explicit timeout
  (pinned: adapter-call timeout 30s < reservation TTL 60s), because the
  deployed route budget produces a 408 RESPONSE without aborting the
  in-flight handler (`routes.ts:1965-1985` budget seam), so without the
  ordering a still-alive handler could outlive its reservation and race
  the retry — the exact double-post the reservation exists to close. A
  handler that somehow exceeds its adapter timeout treats its OWN outcome
  as AMBIGUOUS: it must NOT record the id and must NOT claim success (its
  reservation is presumed lost). A concurrent POST with the SAME id while
  the reservation is live gets a typed `409 delivery-in-flight` — the
  funnel surfaces it as transient, so the sentinel retries at backoff
  (≥30s), by which time the first call has resolved (recorded →
  `idempotent:true`, or failed → retryable). **A DEFINITIVE send failure
  explicitly DELETES its reservation in the failure path (round-7 m4)** —
  relying on TTL expiry would feed the sentinel's ≥30s retry a spurious
  409 that burns a real recovery attempt (attempts feed MAX_ATTEMPTS) and
  inflates the backoff; a crash is the only case expiry exists for. This
  closes the
  in-flight race the `--max-time` pin opened: the script abandons a slow
  call, enqueues the same id, the event kick redrives within seconds — and
  record-after-success alone cannot see the still-in-flight first call.
- Record the id (reservation → recorded) only AFTER `sendToChannel` returns
  a `ts` (paralleling `routes.ts:11372-11376` — a failed send must not
  poison the id; the reservation expiring restores retryability).
- **The id record becomes DURABLE (resolves OQ-4 — the round-6-era "not
  needed" rationale was falsified in round 1):** the derivable window — a
  redrive delivers but the ack is lost (row stays claimed; id recorded
  in-memory only) → restart (instar restarts on every auto-update — the
  keystone's R4-M2 argument verbatim) → LRU empty → next redrive at a backoff
  step ≥15 min → the content-dedup window (15 min) has lapsed → double-post.
  The row state machine does NOT cover it (the row never transitioned — the
  2xx never reached the sentinel). Fix: a small SQLite delivery-id ledger
  beside `SqliteOutboundDedupStore` (same stateDir, same fail-open-to-
  in-memory degradation posture), **25h TTL — deliberately one hour LONGER
  than the row's 24h retry TTL (round-4 L2): both clocks anchor at the
  initial send, so a strictly greater ledger TTL makes the
  redrive-races-a-just-pruned-entry boundary impossible by construction** —
  size-capped, shared by `/telegram/reply` AND `/slack/reply`; the in-memory LRU stays as the hot
  cache in front of it. Additive; a ledger open-failure degrades to today's
  in-memory-only behavior with a degradation report (fail toward delivery,
  never capture-and-drop).
- `X-Instar-System: true` + `matchesSystemTemplate(text)` bypasses the tone
  gate for the sentinel's compiled-in templates only (paralleling
  `routes.ts:11182-11191`). Arbitrary text with the header still gates —
  membership is the exact compiled-in set with build-time SHA integrity, no
  runtime template registration; a spoofed header buys nothing (round-1
  MINOR-7; §7 pins both directions).

### 2.5 Dedup signal into the tone gate + content dedup for Slack

Two pieces, matching the Telegram precedent:

1. **Content dedup before the gate**: `outboundContentDedup.isDuplicate(id,
   text)` keyed on the MINTED id, called in `/slack/reply` before
   `checkOutboundMessage`, honoring `allowDuplicate`
   (metadata already parsed at `routes.ts:12179`), recording only after a
   successful send — the exact call pattern of `routes.ts:11272-11276` +
   `:11324`. The store instance is SHARED (one `OutboundContentDedup`,
   `routes.ts:1652-1660`, SQLite-backed, already keyed by numeric topic id —
   minted ids are numbers, zero changes to the module). Length floor +
   window defaults unchanged (`OutboundContentDedup.ts:42-47`). **This is an
   explicit `/slack/reply` HANDLER modification (round-2 m3 — the deployed
   route has no registry access and no topicId concept): the handler gains an
   in-process registry read** resolving the minted id from
   `(channelId, thread_ts)` (tuple lookup, keystone §3.1); when the
   conversation is not yet minted (pre-first-inbound edge), the route SKIPS
   content dedup for that send and omits `topicId` from the gate call —
   fail-open to delivery, never a block. (Round-1 MINOR-3 replaced the
   draft's string-hash fallback: `OutboundContentDedup` keys on a NUMBER, and
   a string-hash-as-number can collide with a real minted id or a Telegram
   topic id → cross-conversation suppression; skipping is honest, the window
   is one send per never-inbound conversation, and delivery-id idempotency
   still covers the re-POST class there.)
2. **The dedup SIGNAL into the gate**: `/telegram/reply` threads `topicId`
   into `checkOutboundMessage` so `evaluateOutbound` sees conversation context
   (`routes.ts:11290-11296`); `/slack/reply` today passes NO conversation key
   (`routes.ts:12176-12185`). Change: pass the minted id as `topicId` — the
   gate's duplicate-awareness and per-conversation signals then work for
   Slack with zero gate changes (the gate is channel-string-agnostic,
   `routes.ts:2103-2115`).

### 2.6 Layer 1 — `slack-reply.sh` gains the queue tail

Port the recoverable-failure tail of `telegram-reply.sh` (`:391-666`):

- **The `delivery_id` (UUIDv4) is minted BEFORE the first POST and sent as
  `X-Instar-DeliveryId` on the INITIAL send (round-3 C1 — the round's key
  catch, premise verified against deployed code).** Minting at enqueue time
  (the deployed `telegram-reply.sh:437` shape — the id is born only after
  the first POST already failed) leaves the FIRST send permanently outside
  the id-ledger guarantee: if the initial POST is ACCEPTED server-side but
  the response is lost to the script (curl `000` — a recoverable class), the
  script enqueues under a FRESH id, and a redrive past the 15-min content
  window (a held row released at a lane flip is the wide case — the §2.2a
  architecture is precisely what keeps such rows alive) POSTS THE SAME
  MESSAGE AGAIN with an id the ledger has never seen. Minting pre-POST
  closes it end-to-end: if the initial send actually landed, the route
  recorded THAT id durably (§2.4), and every redrive of the row is answered
  `idempotent:true`. **The enqueue's `attempted_at` is the PRE-POST MINT
  timestamp, not the enqueue instant (round-5 m3):** the 25h-ledger >
  24h-row-TTL margin (§2.4) holds only if both clocks anchor at the send —
  the script has the mint time and stamps it, closing the
  wedged-script/slept-laptop gap by construction; additionally the reply
  curl gains a pinned `--max-time` (both scripts, same refresh — the
  deployed initial curl has none, `slack-reply.sh:96`). An id-MINT failure
  (python3 unavailable) degrades to
  today's headerless send — fail toward delivery, never a refused send — and
  a subsequent recoverable failure then skips the enqueue with the loud
  stderr note, exactly the deployed `telegram-reply.sh:438-441` behavior. `telegram-reply.sh` gains the SAME pre-POST mint +
  initial-send header in the same template refresh (additive, strictly
  safer — it closes the identical latent gap on the deployed Telegram lane,
  which the old channel-blind purge was accidentally masking by eating
  >60-min rows; Migration Parity, one refresh for both scripts).
- On a RECOVERABLE outcome (curl exit ≠ 0 / HTTP 5xx / connection refused —
  the same classifier table), enqueue into
  the per-agent SQLite queue under that SAME pre-minted `delivery_id`, with
  `channel:'slack'`, `topic_id` = the
  TUPLE-VALIDATED minted id (below), `conversation_ref` = the canonical key,
  then best-effort `POST /events/delivery-failed` so the in-process sentinel
  reacts in <1s (`routes.ts:2741-2749` fan-out). **The deployed event
  VALIDATOR must change for this to work at all (round-2 M3 — found
  independently by both externals + the internal grounding sweep):**
  `createDeliveryFailedHandler` rejects `topic_id < 0` with a 400
  ("non-negative integer", `routes.ts:583-585`) and 400s ANY field outside
  its allowlist (`routes.ts:496-504`) — so as deployed, every Slack event
  kick (negative minted id + a `channel` field) fails on BOTH counts and the
  "<1s" property silently degrades to the 5-min watchdog. Pinned changes:
  `topic_id` accepts keystone minted ids (any non-zero integer; `0` stays
  rejected — the deleted C1 lane's key), and `channel` joins the allowlist
  (optional, enum `{'telegram','slack'}`, default `'telegram'`). §7 Tier-2
  pins both directions (a valid slack event kicks the tick; a `channel`
  outside the enum, or `topic_id: 0`, still 400s). The embedded enqueue also
  ports `telegram-reply.sh`'s 5-second same-`(topic_id, text_hash)` dedup
  (the tight-loop flood guard — round-1 LOW-2; distinct from the route's
  15-min window).
- **Where the script gets the minted id — TUPLE-VALIDATED against the
  script's OWN target (round-1 C1; resolves OQ-2).** `slack-reply.sh` takes
  an arbitrary `CHANNEL_ID[ THREAD_TS]` per invocation, so an id can NEVER be
  adopted blindly from session context: a session's own conversation id used
  for a proactive reply to a DIFFERENT channel would enqueue under the wrong
  conversation and REDELIVER INTO THE WRONG CHANNEL at drain (C3-class
  misdelivery). The rule, in order:
  1. The session context carries the minted id under the keystone's pinned
     metadata field `conversationId` (§6.3), PAIRED with its routing key
     (`channelId[:threadTs]` — the id's tuple tail; how the session hands the
     pair to the script — env vars, arguments — is an implementation
     mapping). The script uses the id ONLY when the paired routing key equals
     its own `CHANNEL_ID[:THREAD_TS]` argument — a pure OFFLINE string
     compare, so the dominant case (replying within the session's own
     conversation) needs no server round-trip and works exactly when the
     server is down (the case the queue exists for).
  2. Otherwise the script asks the server by KEY:
     `GET /conversations/resolve?key=slack:<team-or-_>:<channelId>[:<threadTs>]`
     (the keystone read route — `?key=`/`?sessionKey=`, and it MINTS NOTHING,
     keystone §8; a never-minted target therefore yields no id, by design —
     outbound is deliberately NOT a mint chokepoint, preserving the
     keystone's bounded mint-authority posture, §6.2/§6.3).
  3. **No validated id ⇒ NO enqueue** — the script exits 1 with the failure
     named on stderr (today's behavior, unchanged). The `topic_id = 0`
     ref-resolved lane from the draft is DELETED (round-1 C1: it was a
     misdelivery vector, a black hole for never-minted targets, and it
     conflated dedup/stampede/rate-cap state on key 0).
  **Honest residual, named:** a send whose target conversation cannot be
  resolved while the server is down (proactive cross-channel reply, or a
  never-inbound target) is NOT queue-protected — it fails loudly, exactly as
  every Slack send does today. The queue's loss-protection covers the
  dominant case (replying within a minted conversation, where the id+key
  pair rides the session context and validates offline against the argument
  tail — the eager-mint contract guarantees it exists from the first
  inbound). Loud non-capture beats silent misdelivery in every direction the
  round-1 panel walked.
- 422 (tone gate) remains terminal at the script (exit 1, revise-and-retry
  guidance — `slack-reply.sh:118-127` unchanged); 408 remains AMBIGUOUS
  guidance (`:108-117` unchanged) — never blind-enqueued (that would
  double-post; property 1). **A curl TIMEOUT (exit 28, the `--max-time`
  case) is classified PHASE-AWARE (round-6 C1(b), sharpened round-7 M1 —
  exit 28 fires regardless of phase, and the phases have opposite
  epistemics):** the script adds `-w '%{time_connect}'` (curl emits it
  even on failure). Exit 28 with an EMPTY/ZERO `time_connect` — the
  connection was never established, the request was never sent, the
  message DEFINITELY did not post — keeps the RECOVERABLE class and
  enqueues (the automated-recovery case the queue exists for). Exit 28
  with a NONZERO `time_connect` — the request may have been accepted —
  is the client-side twin of HTTP 408: exit 0 with the
  verify-before-resend guidance, NEVER a recoverable enqueue.
  Conn-refused/reset keep the recoverable
  class (the §2.4 in-flight reservation covers the
  reset-while-handler-in-flight variant).
- Non-recoverable (4xx auth/shape errors) remain exit-1 without enqueue.
- Migration parity for the script: the template refresh rides the existing
  `slack-reply.sh` refresh entry (`PostUpdateMigrator.ts:7792-7799`) with a
  NEW `featureMarker` (`slack-reply-feature: relay-queue`) so deployed agents
  get the tail on update, per the always-refresh scripts machinery.

### 2.7 `/internal/slack-forward` — typed refusal until Phase 2.2 re-points it (round-1 M6; resolves OQ-1)

As deployed, `POST /internal/slack-forward` takes `{channelId, text}` and
calls `ctx.slack.sendToChannel(channelId, text)` with NO tone gate, NO dedup,
NO delivery-id (`routes.ts:12233-12251`). The grounded anomaly: the route's
only caller is `SlackLifeline.forwardToServer`
(`src/lifeline/SlackLifeline.ts:182-204`), which forwards INBOUND user
messages (prefixed `[slack:<channel>] …`) when the socket lives in the
lifeline process — yet the route, as written, POSTS that text back OUT to the
channel. Since SlackLifeline is "written but never instantiated" (audit §3.1
org-readiness row), this echo path has never run live.

**Round-2 decision (both externals independently rejected gate-only):** the
route's ONLY semantic today is a bug — echoing inbound user text back out —
and it has ZERO live callers. Gating an echo defect still ships an echo
defect the day SlackLifeline is instantiated. So:

- The route keeps Bearer auth and returns a typed refusal: `409
  { error: 'misdirected-route', detail: 'inbound-shaped payload on an
  outbound route — re-point owned by Phase 2.2 (SlackLifeline / session
  injection parity with /internal/telegram-forward)' }`, plus a ONE-TIME
  deduped attention breadcrumb the first time it is hit per boot.
- Fail-toward-delivery does NOT apply here (decision argued, not assumed):
  there is no legitimate delivery through an echo bug — "delivering" this
  route's traffic means posting the user's own inbound text back at them.
  The refusal is the loss-free direction; the real inbound path (Phase 2.2's
  session injection, mirroring `/internal/telegram-forward`,
  `routes.ts:16961+`) is where fail-toward-delivery will live.
- The full re-point stays Phase 2.2 — it drags the Slack exactly-once ingress
  ledger + sentinel intercept in (the draft's original judgment, upheld);
  the refusal closes the hazard window until then without building 2.2 early.

### 2.8 What is deliberately NOT here (blast radius)

- SlackLifeline instantiation, socket-follows-lease, the Slack exactly-once
  INGRESS ledger — Phase 2.2 (roadmap), keyed on `(channel, ts)` or canonical
  key per the keystone's §11.2 note.
- The GFM→mrkdwn formatter — shipped (Phase 0.1, `SlackMrkdwnFormatter`).
- KYP/operator binding on Slack — Phase 3.1.
- Adapter-internal retry inside `SlackAdapter.sendToChannel` — the robustness
  lives in the queue + sentinel, not in doubling the HTTP layer.
- PromiseBeacon/commitments generalization — Phase 2.3 rides the keystone
  funnel; this spec only makes the funnel's `/slack/reply` hop robust.

## 3. Fail-direction table (argued per failure point)

Per the constitution standard (*The Operator Channel Is Sacred — Critical-Path
Gates Fail Toward Delivery*, docs/STANDARDS-REGISTRY.md:136) and its outbound
sibling (*Guards Degrade, Not Outage*): infra failures fail toward DELIVERY of
conversational replies; only a real content VERDICT withholds.

| Failure point | Direction | Mechanism |
|---|---|---|
| SQLite store won't open at boot | toward delivery | direct-send path untouched; degradation report (`assertSqliteAvailable`, `pending-relay-store.ts:610-658`; precedent `server.ts:7987-7997`) — a broken NET never becomes capture-and-drop |
| Script can't enqueue after a failed send | toward loudness | exit-1 semantics preserved (the agent SEES the failure and can resend) + stderr names the queue miss — same as `telegram-reply.sh:436-440` |
| Registry can't resolve a minted id at drain / non-owning machine / no local adapter | toward HOLD, then loud | funnel typed failure → stand-down HOLD (§2.2a durable disposition — no attempt burn, no breaker arm, purge-proof) + ONE deduped attention item; heals on ownership arrival or ages out LOUDLY at the §5 held-retention long-stop; never a guess-delivery |
| `conversation_ref` tail OR concrete teamId disagrees with `resolve(id)` at drain (round-2 M2) | toward typed REFUSAL | `conversation-binding-incoherent` HOLD + attention item — never a delivery on either field (keystone §3.5.2 R5-M2/R6-M4 parity; the C3 misdelivery signature); `_`↔concrete teamId stays benign (the upgrade path) |
| Tone gate 422 on redrive | WITHHOLD (verdict) | `delivered-tone-gated` terminal + fixed-template meta-notice — the sentinel never overrides the gate (`delivery-failure-sentinel.ts:439-444, 503-519`) |
| Tone gate UNAVAILABLE on redrive | layered, per deployed reality (round-1 M5) | the sentinel's LOCAL pre-check fails OPEN on a gate ERROR (`src/messaging/local-tone-check.ts` — `passed:true, failedOpen:true`, proceeds); the ROUTE-side gate then owns availability direction (`failClosedMode` tri-state, `src/core/MessagingToneGate.ts:608-621`); the policy layer classifies the route's resulting status. No behavior change on either channel |
| Slack API 5xx / network down (transient) | toward retry | recoverable class → backoff schedule (property 2) |
| Slack channel-state PERMANENT error (`is_archived` / `channel_not_found` / `not_in_channel`) | toward terminal-with-out-of-band-notice | funnel §5.1 classification → `escalated: conversation-unreachable` with NO 24h retry burn; the notice goes to the ATTENTION queue, never into the unreachable conversation (round-1 M2); unrecognized permanent-shaped codes stay transient + one deduped attention item (the keystone drift canary) |
| Slack API 408 / ambiguous | toward NOT double-posting | script lane: `delivered-ambiguous` terminal via recovery-policy; funnel lane: the pinned `ambiguous-likely-posted` typed surfacing → `finalize-ambiguous` (round-2 M1; property 1) — content dedup + the §2.4 id-ledger are the nets if a caller manually resends |
| Sentinel escalation itself fails repeatedly | toward pause-with-queue-intact, PER CHANNEL | P19 breaker suspends THAT channel's retries only (§2.3 point 5); rows stay queued (never deleted); degradation report names the resume levers (`:600-613`) |
| Server restart with queued rows | toward delivery | immediate first drain on `start()` (`:258-271`); restore-purge only beyond 60min staleness, LOUD, scoped to LIVE-enabled channels AND `hold_reason IS NULL` (§5 — round-1 C2 + round-2 C2: a held row is exempt by DISPOSITION, so a downtime that outlasts the hold arithmetic can never make it purge-bait) |
| Channel configured OFF (`channels` omits it) or in dryRun | toward HOLD, never purge, never fake-delivery, never stampede-consumption | rows held via §2.2a (`hold_reason` set pre-grouping — excluded from purge, stampede accounting, AND digest posting; round-2 C1); >24h backlog raises ONE deduped attention item; dryRun ticks log would-redrive (`dryRun:true` ledger rows) with NO `delivered-*` transition (§5 — round-1 C2/C3; keystone §5.1 never-success-shaped parity); held rows age out LOUDLY only at the §5 held-retention long-stop |
| Duplicate POST same delivery-id | toward idempotent-200 | durable id-ledger + hot LRU (§2.4) — "delivered once" beats "delivered again", across restarts (round-1 M4) |

## 4. Observability (P18 concretely)

### 4.1 Counters

The sentinel's per-tick counters (`processed/recovered/escalated`,
`delivery-failure-sentinel.ts:306-317`) gain a `byChannel` breakdown, surfaced
on the existing sentinel events and a small read route
`GET /delivery-recovery/status` (queue depth by channel+state, PER-CHANNEL
breaker state (§2.3 point 5), held backlog counts by `hold_reason` (§2.2a),
the PENDING out-of-band notice count (`notice_pending` — round-6 m2) and
the failed-notice count (`notice-failed-permanent` — round-7 m3), dryRun
posture, last tick — Registry First for "did my Slack reply make it?").

### 4.2 The audit ledger (the live-proof "sentinel audit row")

Every row state transition appends ONE line to
`logs/delivery-recovery.jsonl`:
`{ ts, channel, delivery_id, topic_id, conversation_ref?, from, to, attempts,
http_code?, reason }`. Written by the store's `transition()` caller (the
sentinel), best-effort, never blocking delivery. **Hold-lifecycle events are
audited BOUNDEDLY (round-3 m3):** one ledger row on hold SET (with
`hold_reason`), one on RELEASE, one on the long-stop escalation — and NONE
on the 15-min re-pushes (a week-held row must not write ~670 audit lines);
the dryRun would-redrive rows (§5) are additional to these. Bounded by size-rotation
(same pattern as `logs/sentinel-events.jsonl`). The roadmap's live proof
greps THIS file for the recovered row.

### 4.3 Existing surfaces

`status_history` per row (`pending-relay-store.ts:334`), DegradationReporter
events (suspension, restore-purge, unsupported-channel), and the per-feature
LLM metrics for the tone-gate calls (feature key unchanged) — no new
LLM-visible surface.

## 5. Config keys + defaults + migration parity

```jsonc
// .instar/config.json
{
  "monitoring": {
    "deliveryFailureSentinel": {
      "enabled": false,            // EXISTING master gate (unchanged; src/server/AgentServer.ts:3828-3829)
      "channels": ["telegram"],    // NEW — which channels the drain redrives.
                                   // OMITTED ⇒ ["telegram"] on the fleet;
                                   // ["telegram","slack"] on a development agent
                                   // (the developmentAgent gate pattern,
                                   // MultiMachineCoordinator.ts:113-118 precedent).
      "slackDryRun": true,         // NEW — HOLD-shaped dry run (§ below): would-redrive
                                   // verdicts logged (ledger rows tagged dryRun:true),
                                   // NO delivered-* transition, NO post, rows held.
      "holdRecheckMs": 900000,     // NEW (round-2 C2) — held-row recheck cadence (15 min).
                                   // Liveness knob only: the purge keys on hold_reason,
                                   // never on this timestamp.
      "heldRetentionMs": 604800000 // NEW (round-2 m1) — held-row LOUD long-stop (7 days):
                                   // escalated + P18 rows + one out-of-band attention item,
                                   // never a silent delete.
    }
  }
}
```

- **Disabled-channel semantics, pinned (round-1 C2 + round-2 C1/C2):**
  a row whose `channel` is NOT in `channels` is (a) held by the §2.2a
  disposition partition BEFORE stampede grouping (`hold_reason:
  'disabled-channel'` — never claimable, never stampede-consumed, never
  digest-triggering; round-2 C1), (b) EXEMPT from restore-purge —
  `listStaleClaimable` / `purgeStaleClaimable` gain BOTH filters so the purge
  is SCOPED to LIVE-enabled channels (enabled AND not in dryRun) AND to
  `hold_reason IS NULL` rows (the round-1 walk: unconditional enqueue + the
  fleet's telegram-only default + the deployed CHANNEL-BLIND purge would have
  deleted every queued Slack row at the first boot older than 60 min without
  one drain attempt — the 2026-06-05 silent-deletion lesson recurring one
  level up; the round-2 walk: a DRY lane is channel-ENABLED, so channel
  scoping alone left every fresh-or-lapsed-hold dry row purge-bait at the
  first boot after a long downtime — round-2 C2), and (c) surfaced: a
  disabled-channel backlog older than 24h raises ONE deduped attention item
  naming the config fix.
- **Hold-recheck cadence + held-retention long-stop, pinned (round-2 C2/m1 +
  round-3 M1):** a held row's `next_attempt_at` is pushed by `holdRecheckMs`
  (default 900000 = 15 min — bounded staleness for ownership arrival / a
  lane flip; since the purge keys on `hold_reason`, NOT on this timestamp,
  the cadence is a liveness tuning knob, never a safety parameter). A row
  whose `now − hold_started_at ≥ heldRetentionMs` (default 604800000 = 7
  days — the far-future-clamp scale; the anchor is the §2.2a
  `hold_started_at` column, measured from when the CURRENT continuous hold
  began, preserved across reason relabels) exits LOUDLY — the check runs in
  the §2.2a partition BEFORE any re-hold: transition to `escalated` with
  reason `held-retention-exceeded`, one P18 ledger row per row, and ONE
  deduped OUT-OF-BAND attention item per channel-episode (the lane can't
  deliver, so the notice never targets it) — never a silent delete. This
  replaces the draft's false claim that "the 24h TTL bounds" held rows (the
  TTL is evaluated at DRAIN time; a held row never drains, so nothing ever
  TTLed it — round-2 m1).
- **Held-past-TTL rows escalate at release instead of delivering — a
  DECISION, not an accident (round-3 m1):** a row released from hold (lane
  flip, ownership arrival) whose age already exceeds the 24h retry TTL
  escalates LOUDLY rather than delivering, because delivering a days-stale
  conversational message is WORSE than one clear "this never delivered"
  notice — the same judgment the deployed 60-min restore-purge encodes for
  ancient backlogs. A flip-burst of such escalations is bounded (the §5.2
  budgets + the out-of-band aggregation for undeliverable lanes). Rows
  younger than the TTL drain normally — and a release of >5 deliverable
  rows on one conversation lands in the deployed stampede semantics (ONE
  digest + all-but-newest dropped as `delivered-ambiguous`) BY DESIGN
  (round-3 L3): Telegram-parity backlog handling, a deliberate flood guard,
  not a loss bug.
- **dryRun semantics, pinned (round-1 C3 — the keystone §5.1 contract:
  "dryRun returns typed not-delivered, NEVER success-shaped"):** a dry tick
  logs the would-redrive verdict as a `dryRun:true` ledger row, makes NO
  `delivered-*` transition, increments NO attempt counter, arms NO breaker,
  and holds the row via §2.2a (`hold_reason:'dry-run'` + the hold-recheck
  push — the durable disposition IS the purge exemption; round-2 C2 replaced
  the draft's timestamp-arithmetic exemption, which a downtime longer than
  the hold push outran at the boot purge). Dry rows never enter stampede
  grouping (§2.2a — round-2 C1: the deployed stampede path would otherwise
  consume all-but-newest as `delivered-ambiguous` and post a real digest,
  both forbidden in a soak). Rows survive the whole soak intact; when the
  lane flips live the partition clears `hold_reason` and they drain for real,
  and rows already past TTL escalate LOUDLY (visible, never silent). A dry
  run can never fabricate a delivery record, feed the purge, or post.
- **Rollout ladder (Maturation Path):** dark on the fleet (`channels` omitted
  ⇒ telegram-only; Slack rows held + purge-exempt + surfaced per the pinned
  semantics above), live-in-dryRun on the dev agent, then `slackDryRun:false`
  on dev after the §7 live proof passes, then fleet default flip in a later
  release. Enqueue (Layers 1-2) ships UNCONDITIONALLY like Telegram's did
  (`delivery-failure-sentinel.ts:32-35` — "Layer 1 + Layer 2 ship
  unconditionally; Layer 3 is opt-in"): a queued-but-not-yet-drained row is
  strictly better than a lost message NOW THAT the disabled-channel semantics
  above make "not yet drained" a DURABLE held disposition rather than
  purge-bait or stampede-bait, and the held-retention long-stop bounds it
  loudly (round-2 m1).
- **`migrateConfig()` parity:** add-missing-only — `channels`,
  `slackDryRun`, `holdRecheckMs`, and `heldRetentionMs` are added ONLY when the `deliveryFailureSentinel` block
  already exists AND lacks them; the migration never materializes
  `enabled:false` into a config that omitted the block (the keystone's §9
  posture, and the standing migrateConfig rule). Idempotent by existence
  check.
- **Route-side pieces** (delivery-id idempotency incl. the durable ledger,
  content dedup, the slack-forward typed refusal) are NOT flagged — they are
  strict safety additions with the `allowDuplicate` escape hatch, matching how
  the Telegram equivalents shipped (default-on in code,
  `outboundContentDedup` config block already tunable, `routes.ts:1652-1654`).
  The durable id-ledger degrades to in-memory-only on open failure (§2.4) —
  never a delivery blocker.
- **SQLite columns** migrate lazily at `open()` via `COLUMN_ADDS` — no
  PostUpdateMigrator step needed (the store self-migrates on every boot,
  `pending-relay-store.ts:211-221`); the script-side embedded schema rides the
  script template refresh (§2.6).

## 6. Security notes

- The queue holds message BODIES on disk; mode 0600 + agent-id infix isolation
  are inherited (`pending-relay-store.ts:8-14, 196-201`). Slack rows add no
  new at-rest class.
- Redrive re-runs `redact()` before the tone gate
  (`delivery-failure-sentinel.ts:434-438`) — inherited for Slack rows.
- `/internal/slack-forward` keeps Bearer auth (it is inside the authed router)
  and becomes a typed refusal (§2.7) — ZERO outbound exposure through it,
  strictly less than today.
- `conversation_ref` is untrusted data in audit rows; rendered escaped
  anywhere it surfaces (keystone §7 label posture).
- The system-template bypass on `/slack/reply` is membership-checked against
  the compiled-in template set with build-time SHA integrity
  (`system-templates.ts` `verifyTemplateIntegrity`,
  `delivery-failure-sentinel.ts:213-227`) — a spoofed header buys nothing.

## 7. Test plan (Testing Integrity Standard — all three tiers)

**Tier 1 — unit (`tests/unit/`)**
- `pending-relay-store-channel.test.ts`: additive columns appear on open;
  legacy DB (fixture WITHOUT the columns) upgrades in place; legacy rows read
  `channel='telegram'`; enqueue with `channel:'slack'` round-trips;
  `findByTopicAndHashWithin` isolates by minted id; selectors return mixed
  channels; reap-notify exclusion unaffected.
- `delivery-failure-sentinel-slack.test.ts`: per-row dispatch — slack row →
  `deliverToConversation` with `deliveryId` + metadata forwarded WHOLE
  (MINOR-4) + `channel:'slack'` tone gate; telegram row byte-identical to
  today (regression); unknown channel → `escalated unsupported-channel` +
  ledger row, loop terminates (P19); the §2.3 typed-result mapping table —
  every row, both directions (delivered / already-delivered-recently /
  tone-verdict / conversation-unreachable / non-owning / incoherent /
  transient / dryRun); STAND-DOWN shape: a non-owning or unresolvable verdict
  HOLDS with NO attempt increment, NO breaker arm, ONE deduped attention
  item; COHERENCE shape: a `conversation_ref` tail mismatch refuses before
  the funnel call, never delivers on either field — AND the teamId arm
  (round-2 M2): concrete-vs-concrete teamId mismatch with a MATCHING tail
  refuses; `_`↔concrete passes (the upgrade path); AMBIGUOUS shape (round-2
  M1): the funnel's `ambiguous-likely-posted` result finalizes
  `delivered-ambiguous` — never a retry, never a re-post; BUDGET shape
  (round-2 m4): a §5.2 budget-coalesced result HOLDS with no attempt burn
  and no terminal; an UNMAPPED future funnel result maps to transient retry
  + one deduped attention item (table totality); NULL-REF shape (round-4
  m3): a `channel:'slack'` row with a NULL `conversation_ref` →
  `binding-incoherent` HOLD, asserted as its own case (telegram rows
  exempt); RELEASE-CLEARS-ANCHOR shape (round-4 m4 + round-5 C1): a row
  released from ANY hold has `hold_reason` AND `hold_started_at` both NULL
  AND `released_at` stamped (a later re-hold starts a fresh retention
  clock); RELEASE-PURGE-GRACE shape (round-5 C1): a released row older than
  the staleness cutoff (by `attempted_at`) but freshly released SURVIVES a
  boot purge within the release grace window and drains — the
  flip-mid-drain-restart walk asserted end-to-end (release N rows → restart
  before the drain completes → zero purged, remaining rows drain);
  NOTICE-DURABILITY shape (round-4 M1 + round-5 M1): a
  `conversation-unreachable` terminalization whose attention raise fails
  transiently keeps `notice_pending=1`; the DEDICATED terminal sweep
  (`state='escalated' AND notice_pending=1` — the claimable selector never
  returns terminals) re-raises on a later tick under the STABLE
  per-episode id `(conversation, delivery_id)` — never zero items, a
  re-raise no-ops against the accepted item, a DISTINCT later episode
  raises fresh, and the marker clears only on a 2xx in its own transition;
  PERMANENT shape:
  `conversation-unreachable` terminalizes with NO retry burn and its notice
  goes to the attention queue, never the failing conversation;
  escalation/stampede/recovered-marker ride the funnel for slack rows;
  **breaker isolation (round-1 M2): a Slack escalation-failure storm trips
  the SLACK suspension only — Telegram redrives continue (asserted both
  directions).**
- `recovery-policy` untouched — existing table tests prove byte-parity.
- `pending-relay-store` purge scoping (round-1 C2 + round-2 C2):
  `listStaleClaimable` / `purgeStaleClaimable` purge ONLY live-enabled-channel
  rows with `hold_reason IS NULL`; a disabled-channel row older than the
  cutoff SURVIVES the purge; a HELD row (any `hold_reason`) older than 3× the
  cutoff with a LAPSED `next_attempt_at` SURVIVES the boot purge (the
  boot-after-long-downtime shape — round-2 C2) and is re-held or drained on
  the next tick; a held row past `heldRetentionMs` escalates LOUDLY
  (`held-retention-exceeded` + out-of-band attention), never silently
  deleted (round-2 m1).
- dryRun shape (round-1 C3 + round-2 C1): a dry tick over a queued slack row
  → would-redrive ledger row tagged `dryRun:true`, row still `queued` with
  `hold_reason:'dry-run'`, zero attempts added, NO post; flip live → the
  same row drains for real exactly once. **Burst-in-held-posture (round-2
  C1):** 6+ queued rows on ONE conversation in a dark lane AND in a dry lane
  → the disposition partition holds ALL of them pre-grouping — ZERO
  `delivered-ambiguous` transitions, ZERO stampede digests, zero posts (the
  deployed stampede path consumes all-but-newest and posts a digest; this
  asserts held rows never reach it); the same burst on a LIVE lane keeps
  today's stampede semantics (digest + all-but-newest dropped, Telegram
  parity).
- Dedup: slack content-dedup keyed on minted id; length floor; allowDuplicate
  bypass; record-only-after-success; pre-mint send SKIPS content dedup
  (MINOR-3 — no string-hash keying, asserted).
- Durable delivery-id ledger (round-1 M4): id recorded after success survives
  a store reopen; ledger-open failure degrades to in-memory-only + a
  degradation report (delivery never blocked).
- Fail-direction units: store-open failure → direct send still called;
  ledger-append failure → delivery still proceeds.
- Script-side (round-1 C1): the tuple-validation gate — a context id whose
  paired routing key differs from the script's channel argument is REFUSED
  for enqueue (exit 1, no row); a matching pair enqueues offline (no server);
  the 5s embedded dedup suppresses a tight-loop double-enqueue (LOW-2).
- Script-side pre-POST mint (round-3 C1): the INITIAL POST carries
  `X-Instar-DeliveryId`; a recoverable failure enqueues the SAME id (never a
  fresh one); `telegram-reply.sh` asserts the same after its refresh.

**Tier 2 — integration (`tests/integration/`)**
- `/slack/reply` idempotency: two POSTs same `X-Instar-DeliveryId` → one
  `sendToChannel` call, second returns `idempotent:true`; id recorded only
  after success; system-template bypass accepts the fixed template, rejects
  arbitrary text with the header. IN-FLIGHT race (round-6 C1): a second
  same-id POST while the first is mid-`sendToChannel` → typed 409
  `delivery-in-flight`, exactly ONE post; the reservation expires at the
  route budget (a crashed handler never wedges the id — a post-expiry
  retry proceeds).
- Script-side timeout classification (round-6 C1(b) + round-7 M1,
  phase-aware): exit 28 with empty/zero `time_connect` → RECOVERABLE
  enqueue (never connected = definitely unposted); exit 28 with nonzero
  `time_connect` → AMBIGUOUS guidance, exit 0, NO enqueue (the HTTP-408
  twin); conn-refused/reset still enqueue.
- Reservation ordering (round-7 M2/m4): the in-reservation adapter call
  times out strictly before the reservation TTL — the
  handler-outlives-TTL shape asserts exactly ONE post (the late handler
  records nothing); a definitive send failure deletes its reservation
  in-line (the subsequent retry is NOT answered 409 and burns no spurious
  attempt).
- Sweep failure classes (round-7 m1/m3): a transient raise failure backs
  off per `min(attempts, 8)` then the 4h floor; a permanent-shaped
  rejection clears the marker with the `notice-failed-permanent` ledger
  row + degradation line and never retries.
- `/slack/reply` dedup: identical long text twice within window → one send +
  `suppressedDuplicate`; brief ack twice → two sends.
- `/internal/slack-forward` (round-1 M6): ANY payload → `409
  misdirected-route` typed refusal + the one-time attention breadcrumb (today
  it sends ungated — the regression this closes); auth still required (an
  unauthed request stays 401, never reaches the refusal).
- `/events/delivery-failed` validator (round-2 M3): a slack event (negative
  minted `topic_id` + `channel:'slack'`) is ACCEPTED and kicks the tick (the
  deployed validator 400s both — this is the regression the pinned §2.6
  change closes); `topic_id: 0` still 400s (the deleted C1 lane's key); a
  `channel` outside the enum still 400s.
- Full pipeline: enqueue slack row via `POST /events/delivery-failed`
  (channel:'slack') → sentinel tick (test-driven, `tick()` is public) → the
  REAL funnel with a mocked registry + mocked `/slack/reply` 200 → row
  `delivered-recovered` + audit ledger row present. Same with transient→
  backoff→delivered; with tone-verdict→`delivered-tone-gated` + meta-notice;
  with `conversation-unreachable`→terminal + attention item (no notice into
  the conversation); with exhaustion→`escalated` once (P17).
- **Middleware honesty (lesson live-test-caught-auth-and-body-bugs):** the
  route tests run against the REAL AgentServer middleware stack, not a bare
  `createRoutes` mount — auth + body-parse behavior is part of the contract.

**Tier 3 — e2e lifecycle (`tests/e2e/`)**
- "Feature is alive": boot the production init path with
  `deliveryFailureSentinel.enabled:true, channels:['telegram','slack']` →
  `GET /delivery-recovery/status` returns 200 with both channels; with the
  block omitted → sentinel absent, route 503/404 per posture; dryRun boot →
  status reports `slackDryRun:true` and a queued slack row produces a
  dryRun-tagged ledger row and NO post.
- Restart test (upgraded per round-1 M4): enqueue → restart server →
  immediate first drain delivers exactly once. AND the ack-lost shape:
  redrive delivers but the sentinel never sees the 2xx → restart → the next
  redrive (driven at a ≥15-min backoff step, past the content-dedup window)
  is answered `idempotent:true` from the DURABLE id-ledger — exactly one post
  (the in-memory-LRU-only design demonstrably double-posts here; asserted as
  the regression guard).
- Dark-rollout e2e (round-1 C2): boot with sentinel enabled +
  `channels:['telegram']`, a queued slack row aged >60min → boot purge does
  NOT delete it; the >24h backlog attention item fires once; flipping
  channels to include slack drains it.
- Initial-send-landed e2e (round-3 C1): POST accepted server-side, response
  withheld from the script → script enqueues the SAME pre-minted id → row
  held (dark lane) → lane flips within the TTL → the redrive is answered
  `idempotent:true` from the durable ledger — the message appears EXACTLY
  once (the mint-at-enqueue design demonstrably double-posts here; asserted
  as the regression guard).
- Heal e2e (round-3 C2): a `non-owning`-held row delivers within one
  hold-recheck cadence of `ownsConversation(id)` becoming true; a
  `funnel-budget`-held row delivers after its window lapses; no verdict-hold
  row is ever re-held while its release predicate is clear (the deadlock
  regression).

**Live proof (the roadmap clause, run on the dev agent before any flag flip):**
1. From a Slack-bound session, send a reply via `slack-reply.sh` while the
   Slack API is unreachable (network filter on `slack.com`, mid-reply).
2. Observe: script exits with the recoverable classification, row enqueued
   (`channel:'slack'`, minted id), `/events/delivery-failed` fired.
3. Restore network. Sentinel redrives within one event-kick or ≤5min watchdog.
4. Verify: the message appears in the Slack thread EXACTLY once (channel
   history); `logs/delivery-recovery.jsonl` contains the
   `queued→claimed→delivered-recovered` rows; a manual re-POST of the same
   delivery-id returns `idempotent:true`.
5. Negative arm: repeat with the tone gate forced to 422 → message does NOT
   appear; `delivered-tone-gated` + meta-notice row.

## 8. Frontloaded Decisions (round-1 resolutions of the draft's open questions)

All four draft open questions were resolvable from round-1 evidence; each is
now a decided, test-pinned position. `## Open questions` below is empty.

1. **`/internal/slack-forward` (was OQ-1) → TYPED REFUSAL until Phase 2.2**
   (§2.7; round-1 M6 — both externals independently rejected gate-only). The
   route's only semantic today is an echo bug with zero live callers; it
   answers `409 misdirected-route` + a one-time attention breadcrumb. The
   full session-injection re-point stays 2.2 (it drags the ingress ledger
   in — the draft's original scoping judgment, upheld).
2. **Unresolved-enqueue fallback (was OQ-2) → DELETED; enqueue requires a
   TUPLE-VALIDATED minted id** (§2.6; round-1 C1 — the fallback was a
   C3-class misdelivery vector, a black hole for never-minted targets given
   the mint-nothing read route, and it conflated dedup/stampede/rate-cap
   state on key 0). The honest residual (server-down + unresolvable target →
   loud exit-1, today's behavior) is named in §2.6; loud non-capture beats
   silent misdelivery.
3. **Fleet default for `channels` (was OQ-3) → dev-agent gate, unchanged
   position — now made safe by the pinned disabled-channel semantics** (§5;
   round-1 C2). The Slack lane defaults on only via the developmentAgent
   gate until the Telegram-lane canary criteria
   (telegram-delivery-robustness.md §3i) are re-evaluated for both channels
   together; meanwhile a dark lane's rows are HELD + purge-exempt +
   surfaced, never deleted.
4. **Delivery-id durability (was OQ-4) → DURABLE id-ledger on both routes**
   (§2.4; round-1 M4 falsified the draft's "not needed" rationale with the
   ack-lost + restart + ≥15-min-backoff double-post walk — the same shape
   that drove the keystone's R4-M2 durable-entry decision). Small SQLite
   ledger beside `SqliteOutboundDedupStore`, 25h TTL (round-4 L2 boundary
   pin), hot LRU in front, fail-open-to-in-memory degradation.

5. **HOLD as a durable disposition (round-2 C1/C2/m1/m4).** Round 2 proved
   the round-1 folds' protections were timing accidents: the boot purge's
   timestamp-arithmetic exemption dies across a downtime, and the shared
   stampede path consumes held rows before any per-row dispatch. Decision:
   `hold_reason` column (§2.2a) — the purge, the stampede grouper, and the
   status surface all key on the DISPOSITION; the disposition partition runs
   pre-grouping; held rows are bounded by a LOUD `heldRetentionMs` long-stop
   (never the drain-evaluated 24h TTL, which cannot bound a row that never
   drains).
6. **Funnel result vocabulary is pinned additively (round-2 M1/m4).**
   Ambiguous/likely-posted and route-422 tone-verdict are surfaced as
   distinct typed results (the two additive typed-result requirements,
   §2.3); ambiguous finalizes `delivered-ambiguous` (never re-posted);
   budget-coalesced HOLDS; the mapping table is total with a
   drift-canary-style default (transient + one attention item).
7. **`/events/delivery-failed` validator relaxation (round-2 M3).** Minted
   negative ids accepted, `channel` enum field allowed, `topic_id: 0` still
   refused — pinned in §2.6 with both-direction tests.

8. **Delivery-id minted BEFORE the first send (round-3 C1).** The id-ledger
   can only protect ids the route has SEEN; minting at enqueue left the
   initial send permanently outside the exactly-once guarantee — and the
   §2.2a hold architecture is precisely what keeps such rows alive past
   every net. Both reply scripts mint pre-POST and send the header on the
   initial send; a recoverable failure enqueues the SAME id (§2.6).
9. **A durable hold has a durable RELEASE rule (round-3 C2/M1/m2).** The
   §2.2a partition re-evaluates every hold per tick in pinned order:
   known-channel enum first (corrupt values terminalize immediately), the
   `hold_started_at`-anchored long-stop second, then per-reason release
   predicates (config-holds by config; verdict-holds by their cheap local
   predicate) — a cleared condition releases the row into the normal flow
   the same tick; set-and-hold without re-evaluation is structurally
   impossible.
10. **Held-past-TTL rows escalate at release BY DESIGN (round-3 m1/L3).**
   Delivering a days-stale conversational message is worse than one loud
   "never delivered" notice; a >5-row release burst lands in Telegram-parity
   stampede semantics deliberately.

11. **The out-of-band notice is durable, not best-effort (round-4 M1).**
   The unreachable path's attention raise carries deployed-parity bounded
   retry + an idempotent `notice_pending` re-raise on later ticks — one
   transient hiccup delays the notice, never deletes it.
12. **The never-classified staleness purge is a stated decision (round-4
   m1).** Once CLASSIFIED, a hold is purge-proof; a live-lane row already
   past the 60-min staleness cutoff at boot, never seen by any tick, purges
   loudly — the deployed Telegram judgment inherited deliberately, residual
   named.

13. **Release leaves a durable breadcrumb; notices sweep terminals (round-5
   C1/M1).** `released_at` gives a released backlog a fresh 60-min purge
   grace (TTL unchanged); `notice_pending` lives in the schema and is
   swept by its own bounded terminal selector under a stable per-episode
   id — the hold lifecycle (set → re-evaluate → release) and the notice
   lifecycle (stamp → raise → clear) are each fully pinned, durable at
   every step.

14. **Single-flight per delivery-id; the notice sweep brings its own P19
   discipline (round-6 C1/M1).** The route reserves an id in-flight before
   sending (typed 409 to a concurrent same-id POST; TTL-bounded so a crash
   never wedges); a client-side curl timeout is classified PHASE-AWARE
   (round-7 M1 — exit-28 with an empty/zero `time_connect` never connected,
   so it is a RECOVERABLE enqueue; a nonzero `time_connect` may have posted,
   so it is AMBIGUOUS, exit 0, no enqueue — the 408 parity); and
   the terminal notice sweep backs off per-row via the reused
   `next_attempt_at` (schedule-bounded retries, oldest-due-first fairness,
   nothing silently abandoned).

15. **Round-7 precision pins (round-7 M1/M2/m1-m5).** Exit-28 is
   phase-aware (`time_connect` splits definitely-unposted from ambiguous);
   the reservation TTL strictly exceeds the bounded in-reservation adapter
   timeout and definitive failures delete their reservation in-line; the
   sweep's step counter is the reused `attempts` column and permanent
   rejections terminate loudly; the sweep gets its tiny partial index; and
   `delivery-in-flight` has its explicit mapping row (transient, no
   attention noise).

## Open questions

*(none — all round-1 resolutions verified landed in round 2, all round-2
resolutions verified landed in round 3, all round-3 resolutions verified
landed in round 4, all round-4 resolutions verified landed in round 5, all
round-5 resolutions verified landed in round 6, all round-6 resolutions
verified landed in round 7; the round-7 findings are folded above as of
this round-8 revision)*
