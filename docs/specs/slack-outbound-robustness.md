---
title: "Slack Outbound Delivery Robustness — channel-typed relay queue, funnel-routed sentinel lane, durable delivery-id idempotency, refused slack-forward (roadmap Phase 2.1)"
slug: "slack-outbound-robustness"
author: "echo"
status: "draft"
parent-principle: "Guards Degrade, Not Outage — a safety/delivery layer on the user-facing path may never convert its own infra failure into the user's silence (the constitution's named OUTBOUND extension of The Operator Channel Is Sacred; re-anchored round 2 per the conformance gate — the Operator-Channel-Sacred rule text governs the INBOUND consume gate)"
sibling-principles: "The Operator Channel Is Sacred (sibling context — the inbound twin of this spec's fail-toward-delivery posture); Structure > Willpower (a durable queue, not a session remembering to retry); A Refusal Stays a Refusal / P18 (every drop is a counter + ledger row, never silent); Bounded Notification Surface (P17 — one deduped escalation per failure episode); Bounded Blast Radius (P19 — breaker on every loop, PER-CHANNEL suspension state §2.3); Migration Parity (additive SQLite columns, never destructive); Verify the State, Not Its Symbol (delivery state machine over 'the curl said ok'); Signal vs Authority (the sentinel never overrides the tone gate); Near-Silent Notifications (§2.3 — recovery chatter decision stated, unreachable-conversation escalations out-of-band)"
constitution: "The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery (docs/STANDARDS-REGISTRY.md); Guards Degrade, Not Outage; Bounded Notification Surface (P17); A Refusal Stays a Refusal (P18); Bounded Blast Radius (P19); Migration Parity Standard; Testing Integrity Standard"
lessons-engaged: "2026-06-05 restore-purge silent deletion (five queued outbound messages eaten at boot — delivery-failure-sentinel.ts:83-90; every purge here is LOUD, channel-tagged, AND channel-SCOPED to enabled lanes — round-1 C2 caught the same lesson recurring one level up) · 2026-06-06 duplicate-message fix (byte-identical status 13.5 min apart — OutboundContentDedup.ts:5-12; the same dedup now covers Slack) · 2026-06-05 restart-cascade never-drains (immediate first drain on start — delivery-failure-sentinel.ts:258-271; inherited by the Slack lane unchanged) · outbound-gate-tiered-fail-direction (fail direction argued per failure point, §3) · Maturation Path — Every Feature Ships Enabled on Developer Agents (§6 rollout ladder)"
earned-from: "docs/audits/slack-ai-employee-audit-2026-07.md §3.1 'Outbound robustness (queue/retry/dedup/idempotency/formatter): MISSING (tone gate only; one internal route bypasses even that)'; live incident record in telegram-delivery-robustness.md (the Telegram lane exists because these exact losses happened there first)"
roadmap: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md Phase 2.1 — live proof: 'Kill network mid-reply; message arrives exactly once with a sentinel audit row'"
parent-spec: "docs/specs/telegram-delivery-robustness.md (Layers 1-3 — this spec generalizes them); docs/roadmaps/instar-two-goal-roadmap-2026-07.md (Phase 2, depends on Phase 1)"
depends-on: "docs/specs/durable-conversation-identity.md — the Phase-1 KEYSTONE, CONVERGED round 11 (worktree .worktrees/conversation-identity, commit aa5086eb8, review-convergence 2026-07-03, approved: true). THIS SPEC'S BUILD remains gated on the keystone's BUILD LANDING (its registry + `deliverToConversation` funnel increments merged — review convergence is now met): every conversation address in this spec is a Phase-1 minted id (`topic_id < 0` ⇄ tuple (slack, channelId, threadTs?) ⇄ canonical key slack:<teamId>:<channelId>[:<threadTs>]), resolved through the ConversationRegistry; §11.1 of the keystone explicitly defers this exact lane here and its §5 tail pins that this lane 'slots in UNDER the funnel without changing its callers' — §2.3 honors that literally (the Slack redrive IS a funnel caller). Also: pending-relay-store (src/messaging/pending-relay-store.ts — Layer 2, extended additively); DeliveryFailureSentinel (src/monitoring/delivery-failure-sentinel.ts — Layer 3, channel-typed); recovery-policy pure module (src/monitoring/delivery-failure-sentinel/recovery-policy.ts — reused byte-unchanged; Slack rows feed it through the §2.3 typed-result mapping); MessagingToneGate + checkOutboundMessage (src/core/MessagingToneGate.ts; src/server/routes.ts:2103); OutboundContentDedup (src/messaging/OutboundContentDedup.ts); slack-reply.sh template refresh machinery (src/core/PostUpdateMigrator.ts:7792-7799)"
supervision: "tier0 — a DELIBERATE, standard-aware exception declared per the keystone §6.2 pattern (P7): the queue drain + recovery state machine is a byte-deterministic pipeline with no judgment call to wrap (policy is the pure recovery-policy module, exhaustively table-testable; the §2.3 typed-result mapping is a static table); the LLM judgment call in the path is the EXISTING MessagingToneGate, which keeps its own supervision posture. NAMED supervisor-equivalent: the §7 three-tier suite + the live-proof scenario — they verify the exact property an LLM validator would eyeball (did the state machine converge each row to the one correct terminal?), mechanically."
eli16-overview: "docs/specs/slack-outbound-robustness.eli16.md"
project: "two-goal-roadmap Phase 2.1 (topic 29836)"
review-convergence: null
approved: false
single-run-completable: false
---

# Slack Outbound Delivery Robustness (roadmap Phase 2.1)

## 0. Operator-visible properties (what the review ceremony defends)

These are the guarantees an operator can hold this feature to. Each is asserted
by a named test in §7 and each failure of one is a bug, not a tuning issue.

1. **Exactly-once per delivery-id.** A Slack reply that carries an
   `X-Instar-DeliveryId` is delivered to the channel AT MOST once per id at the
   server (24h DURABLE id-ledger + hot in-memory LRU, §2.4 — upgraded from the
   Telegram lane's in-memory-only LRU, whose restart wipe left a derivable
   double-post window; round-1 M4), and AT LEAST once via the durable queue +
   sentinel redrive — converging to exactly-once, with the one honestly-named
   exception inherited from the Telegram lane: an **ambiguous** outcome (HTTP
   408 / response-lost after the Slack API may have accepted the post)
   finalizes as `delivered-ambiguous` and is NEVER blindly re-posted
   (`recovery-policy.ts` `finalize-ambiguous`; `slack-reply.sh:108-117` already
   prints the AMBIGUOUS guidance). Content dedup (§2.5) is the second net
   under that window.
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
   AND is CHANNEL-SCOPED to the sentinel's enabled channels (§5 — a lane that
   was never allowed to drain can never have its rows purged; round-1 C2);
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
| Adapter-level send | `sendToTopic` with relay/dedup/kind-metadata layers | `chat.postMessage`, one shot, no retry (`SlackAdapter.ts:565-579`) |

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
Layer 2 (`PendingRelayStore`) gains two additive columns — `channel` (default
`'telegram'`) and `conversation_ref` (audit + drain-time coherence input,
never delivery authority) — via the store's existing idempotent-ALTER
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
  (`slack:<teamId>:<channelId>[:<threadTs>]`) captured at enqueue. At drain,
  the `(channelId[,threadTs])` TAIL of `conversation_ref` must match the tuple
  `resolve(row.topic_id)` yields; a tail mismatch is the typed
  `conversation-binding-incoherent` verdict — a HOLD + ONE deduped attention
  item, NEVER a delivery on either field (mirroring the keystone's bind-pin
  delivery-time coherence check: an id and its captured tuple disagreeing is
  the C3-class misdelivery signature, and the converged posture is refusal,
  not diagnosis-and-deliver). A key-STRING-only difference (a `_`→teamId
  upgrade rewrote the prefix) is benign by construction — the tuple tail is
  immutable once minted — and is not a mismatch. The ref is never itself
  resolved to deliver.
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
```

- **Never destructive.** No column is renamed, retyped, or dropped; no row is
  rewritten. Every legacy row reads as `channel='telegram'` by DEFAULT — the
  existing Telegram lanes (DFS Telegram drain, ReapNoticeDrain's
  `reap-notify:` PK-range lane, `pending-relay-store.ts:399-414`) are
  byte-identically served. A ROLLED-BACK binary ignores the two unknown
  columns and keeps working (SQLite reads by name) — the same
  forward/backward-compat argument the `message_metadata` column shipped with
  (`pending-relay-store.ts:139-142`).
- `PendingRelayRow` gains `channel: string` and `conversation_ref: string | null`;
  `EnqueueInput` gains optional `channel` (default `'telegram'`) and
  `conversation_ref`. `enqueue()` idempotency on `delivery_id` is unchanged
  (`pending-relay-store.ts:236-271`).
- **Selectors stay channel-agnostic in SQL; the DRAIN is channel-aware.**
  `selectClaimable` (`:375-390`) returns rows of every channel; the SENTINEL
  dispatches per-row (§2.3). A row whose channel is NOT in the enabled
  `channels` set is skipped-and-HELD (its `next_attempt_at` is pushed
  forward — so it drops out of the selector predicate until the hold
  expires, stays purge-exempt via the hold exemption, and is counted on the
  §4.1 disabled-backlog surface; round-1 C2). Rationale for one loop: one
  claim/lease path and one rate-cap bookkeeping — while breaker SUSPENSION
  state is per-channel (§2.3 point 5, P19). The reap-notify PK-range
  exclusion is untouched.
- New index: none required. The dedup-window query
  `findByTopicAndHashWithin` (`:285-299`) already keys on
  `(topic_id, text_hash)` which is unique across channels because minted ids
  are globally unique (keystone §3.3 mint rule).
- The dual writer parity note: `telegram-reply.sh` embeds its own schema
  bootstrap + INSERT (`src/templates/scripts/telegram-reply.sh:500-560, 604-625`).
  Its CREATE/ALTER mirror gains the same two columns; `slack-reply.sh`'s new
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
   (`local-tone-check.ts` — `passed:true, failedOpen:true`, the sentinel
   proceeds) and the ROUTE-side gate then owns the availability-failure
   direction (`failClosedMode` tri-state, `src/core/MessagingToneGate.ts:608-621`);
   the policy layer classifies whatever status the route returns. No behavior
   change is proposed on either channel.
2. **Redrive**: `deps.postReply` becomes `deps.postReplyFor(channel)` —
   `'telegram'` keeps `defaultPostReply` (`:734-793`) verbatim; `'slack'`
   calls `deliverToConversation(row.topic_id, text, { deliveryId:
   row.delivery_id, metadata: row.message_metadata (forwarded WHOLE — kind,
   allowDuplicate, formatMode ride there, matching defaultPostReply's parity;
   round-1 MINOR-4), systemTemplate: <true for fixed templates> })`. Two
   ADDITIVE funnel opts are pinned here (the keystone's opts contract is
   extensible by design): `deliveryId` — forwarded to the route as
   `X-Instar-DeliveryId` so §2.4 idempotency sees the redrive; and
   `systemTemplate` — forwarded as `X-Instar-System`, where the ROUTE's
   compiled-in membership check (`matchesSystemTemplate` + build-time SHA
   integrity) remains the sole bypass authority (the flag is a transport
   marker, never trust). Before the funnel call, the drain runs the
   `conversation_ref` tail-coherence check (§2.1) — mismatch is the typed
   incoherent HOLD, no funnel call.
3. **Typed-result → policy mapping (pinned; replaces raw-HTTP classification
   for Slack rows — the pure `evaluatePolicy` stays byte-untouched, fed
   through this static table):**

   | Funnel result | Row disposition |
   |---|---|
   | delivered | `finalize-success` (+ §2.4 ledger record rides the route) |
   | `already-delivered-recently` (E1/route dedup suppression) | `finalize-success` — DELIVERED-EQUIVALENT, keystone R7-M1 posture |
   | tone-gate VERDICT withhold (route 422 surfaced typed) | `finalize-tone-gated` + meta-notice (unchanged semantics) |
   | `conversation-unreachable` (§5.1 PERMANENT) | terminal `escalated` with reason `conversation-unreachable` — NO 24h retry burn; the operator notice goes OUT-OF-BAND (below) |
   | non-owning / unresolvable / `conversation-binding-incoherent` / no local Slack adapter | **HOLD** — `next_attempt_at` pushed to the ownership-recheck cadence; NO attempt increment, NO breaker arm, NO escalation (keystone stand-down: a by-design refusal is not a delivery failure) + ONE deduped attention item per row-class episode |
   | transient `not-delivered` | policy retry — backoff schedule unchanged |
   | dryRun / fleet-dark typed `not-delivered` | **HOLD**, ledger row tagged `dryRun:true` (§5 — never success-shaped) |

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
   keystone's 60s coalescing-window posture) instead. **Near-silent decision
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
byte-untouched), restore-purge semantics incl. the hold exemption and
far-future clamp (`pending-relay-store.ts:478-541`) — now CHANNEL-SCOPED per
§5 (round-1 C2), stampede grouping (keys on `topic_id` = minted id — already
per-conversation), per-topic rate cap (`lastTopicDelivery` Map keyed by
number — minted ids fit).

**Whoami gate scope**: the `/whoami` identity check (`:410-432`) protects
against replying through a rotated/foreign server config; it is
channel-independent and runs for Slack rows unchanged.

**Multi-machine posture, declared (integration mandatory-check).** The queue
is MACHINE-LOCAL BY DESIGN (a per-agent SQLite file beside the process whose
send failed — the failure and its retry belong to the machine that owns the
conversation's socket). The funnel's ownership gate makes that safe rather
than assumed: a row that lands on (or is orphaned on) a machine that does not
own the conversation HOLDS under stand-down semantics instead of burning
retries, and heals when ownership arrives (adapter comes up / topic moves
back) or ages out LOUDLY at TTL with the out-of-band notice. In today's
single-Slack-machine reality the holding case never occurs; active-active
reconciliation stays the keystone's tracked §11.2 follow-up.

### 2.4 `/slack/reply` — delivery-id idempotency (DURABLE) + system-template bypass

Mirroring `/telegram/reply`'s helpers — with one deliberate upgrade both
routes share (round-1 M4):

- Read `X-Instar-DeliveryId`; if seen within 24h → `200 { ok, idempotent:
  true }` WITHOUT posting (`routes.ts:1615-1641` helpers are already
  route-file-scoped; the Slack route calls the same functions).
- Record the id only AFTER `sendToChannel` returns a `ts`
  (paralleling `routes.ts:11372-11376` — a failed send must not poison the id).
- **The id record becomes DURABLE (resolves OQ-4 — the round-6-era "not
  needed" rationale was falsified in round 1):** the derivable window — a
  redrive delivers but the ack is lost (row stays claimed; id recorded
  in-memory only) → restart (instar restarts on every auto-update — the
  keystone's R4-M2 argument verbatim) → LRU empty → next redrive at a backoff
  step ≥15 min → the content-dedup window (15 min) has lapsed → double-post.
  The row state machine does NOT cover it (the row never transitioned — the
  2xx never reached the sentinel). Fix: a small SQLite delivery-id ledger
  beside `SqliteOutboundDedupStore` (same stateDir, same fail-open-to-
  in-memory degradation posture), 24h TTL, size-capped, shared by
  `/telegram/reply` AND `/slack/reply`; the in-memory LRU stays as the hot
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
   window defaults unchanged (`OutboundContentDedup.ts:42-47`). The route
   resolves the minted id from `(channelId, thread_ts)` via the registry
   (in-process tuple lookup, keystone §3.1); when the conversation is not yet
   minted (pre-first-inbound edge), the route SKIPS content dedup for that
   send — fail-open to delivery, never a block. (Round-1 MINOR-3 replaced the
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

- On a RECOVERABLE outcome (curl exit ≠ 0 / HTTP 5xx / connection refused —
  the same classifier table), generate a `delivery_id` (UUIDv4), enqueue into
  the per-agent SQLite queue with `channel:'slack'`, `topic_id` = the
  TUPLE-VALIDATED minted id (below), `conversation_ref` = the canonical key,
  then best-effort `POST /events/delivery-failed` so the in-process sentinel
  reacts in <1s (`routes.ts:2741-2749` fan-out; the event payload gains an
  optional `channel` field, default `'telegram'`). The embedded enqueue also
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
  double-post; property 1).
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
| Registry can't resolve a minted id at drain / non-owning machine / no local adapter | toward HOLD, then loud | funnel typed failure → stand-down HOLD (§2.3 — no attempt burn, no breaker arm) + ONE deduped attention item; heals on ownership arrival or ages out LOUDLY at TTL; never a guess-delivery |
| `conversation_ref` tail disagrees with `resolve(id)` at drain | toward typed REFUSAL | `conversation-binding-incoherent` HOLD + attention item — never a delivery on either field (keystone §3.5.2 R5-M2/R6-M4 parity; the C3 misdelivery signature) |
| Tone gate 422 on redrive | WITHHOLD (verdict) | `delivered-tone-gated` terminal + fixed-template meta-notice — the sentinel never overrides the gate (`delivery-failure-sentinel.ts:439-444, 503-519`) |
| Tone gate UNAVAILABLE on redrive | layered, per deployed reality (round-1 M5) | the sentinel's LOCAL pre-check fails OPEN on a gate ERROR (`local-tone-check.ts` — `passed:true, failedOpen:true`, proceeds); the ROUTE-side gate then owns availability direction (`failClosedMode` tri-state, `src/core/MessagingToneGate.ts:608-621`); the policy layer classifies the route's resulting status. No behavior change on either channel |
| Slack API 5xx / network down (transient) | toward retry | recoverable class → backoff schedule (property 2) |
| Slack channel-state PERMANENT error (`is_archived` / `channel_not_found` / `not_in_channel`) | toward terminal-with-out-of-band-notice | funnel §5.1 classification → `escalated: conversation-unreachable` with NO 24h retry burn; the notice goes to the ATTENTION queue, never into the unreachable conversation (round-1 M2); unrecognized permanent-shaped codes stay transient + one deduped attention item (the keystone drift canary) |
| Slack API 408 / ambiguous | toward NOT double-posting | `delivered-ambiguous` terminal (property 1) — content dedup is the net if a caller manually resends |
| Sentinel escalation itself fails repeatedly | toward pause-with-queue-intact, PER CHANNEL | P19 breaker suspends THAT channel's retries only (§2.3 point 5); rows stay queued (never deleted); degradation report names the resume levers (`:600-613`) |
| Server restart with queued rows | toward delivery | immediate first drain on `start()` (`:258-271`); restore-purge only beyond 60min staleness, LOUD, hold-exempt, and CHANNEL-SCOPED to enabled channels (§5 — round-1 C2) |
| Channel configured OFF (`channels` omits it) or in dryRun | toward HOLD, never purge, never fake-delivery | rows not claimable, purge-exempt, `next_attempt_at` held forward; >24h backlog raises ONE deduped attention item; dryRun ticks log would-redrive (`dryRun:true` ledger rows) with NO `delivered-*` transition (§5 — round-1 C2/C3; keystone §5.1 never-success-shaped parity) |
| Duplicate POST same delivery-id | toward idempotent-200 | durable id-ledger + hot LRU (§2.4) — "delivered once" beats "delivered again", across restarts (round-1 M4) |

## 4. Observability (P18 concretely)

### 4.1 Counters

The sentinel's per-tick counters (`processed/recovered/escalated`,
`delivery-failure-sentinel.ts:306-317`) gain a `byChannel` breakdown, surfaced
on the existing sentinel events and a small read route
`GET /delivery-recovery/status` (queue depth by channel+state, PER-CHANNEL
breaker state (§2.3 point 5), held/disabled-channel backlog counts, dryRun
posture, last tick — Registry First for "did my Slack reply make it?").

### 4.2 The audit ledger (the live-proof "sentinel audit row")

Every row state transition appends ONE line to
`logs/delivery-recovery.jsonl`:
`{ ts, channel, delivery_id, topic_id, conversation_ref?, from, to, attempts,
http_code?, reason }`. Written by the store's `transition()` caller (the
sentinel), best-effort, never blocking delivery. Bounded by size-rotation
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
      "slackDryRun": true          // NEW — HOLD-shaped dry run (§ below): would-redrive
                                   // verdicts logged (ledger rows tagged dryRun:true),
                                   // NO delivered-* transition, NO post, rows held.
    }
  }
}
```

- **Disabled-channel semantics, pinned (round-1 C2 — previously undefined):**
  a row whose `channel` is NOT in `channels` is (a) NOT claimable by the
  drain, (b) EXEMPT from restore-purge — `listStaleClaimable` /
  `purgeStaleClaimable` gain a channel filter so the purge is SCOPED to the
  sentinel's enabled channels (the round-1 walk: unconditional enqueue + the
  fleet's telegram-only default + the deployed CHANNEL-BLIND purge would have
  deleted every queued Slack row at the first boot older than 60 min without
  one drain attempt — the 2026-06-05 silent-deletion lesson recurring one
  level up), and (c) surfaced: a disabled-channel backlog older than 24h
  raises ONE deduped attention item naming the config fix.
- **dryRun semantics, pinned (round-1 C3 — the keystone §5.1 contract:
  "dryRun returns typed not-delivered, NEVER success-shaped"):** a dry tick
  logs the would-redrive verdict as a `dryRun:true` ledger row, makes NO
  `delivered-*` transition, increments NO attempt counter, arms NO breaker,
  and pushes the row's `next_attempt_at` forward (riding the purge's existing
  hold-exemption — `pending-relay-store.ts:478-541`). Rows survive the whole
  soak intact; when the lane flips live they drain for real, and rows already
  past TTL escalate LOUDLY (visible, never silent). A dry run can never
  fabricate a delivery record or feed the purge.
- **Rollout ladder (Maturation Path):** dark on the fleet (`channels` omitted
  ⇒ telegram-only; Slack rows held + purge-exempt + surfaced per the pinned
  semantics above), live-in-dryRun on the dev agent, then `slackDryRun:false`
  on dev after the §7 live proof passes, then fleet default flip in a later
  release. Enqueue (Layers 1-2) ships UNCONDITIONALLY like Telegram's did
  (`delivery-failure-sentinel.ts:32-35` — "Layer 1 + Layer 2 ship
  unconditionally; Layer 3 is opt-in"): a queued-but-not-yet-drained row is
  strictly better than a lost message NOW THAT the disabled-channel semantics
  above make "not yet drained" a held state rather than purge-bait, and the
  24h TTL bounds it.
- **`migrateConfig()` parity:** add-missing-only — `channels` and
  `slackDryRun` are added ONLY when the `deliveryFailureSentinel` block
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
  the funnel call, never delivers on either field; PERMANENT shape:
  `conversation-unreachable` terminalizes with NO retry burn and its notice
  goes to the attention queue, never the failing conversation;
  escalation/stampede/recovered-marker ride the funnel for slack rows;
  **breaker isolation (round-1 M2): a Slack escalation-failure storm trips
  the SLACK suspension only — Telegram redrives continue (asserted both
  directions).**
- `recovery-policy` untouched — existing table tests prove byte-parity.
- `pending-relay-store` channel scoping (round-1 C2): `listStaleClaimable` /
  `purgeStaleClaimable` with a channel filter purge ONLY enabled channels; a
  disabled-channel row older than the cutoff SURVIVES the purge; the
  `selectClaimable` claim path never returns a disabled channel's rows.
- dryRun shape (round-1 C3): a dry tick over a queued slack row → would-
  redrive ledger row tagged `dryRun:true`, row still `queued`, zero attempts
  added, `next_attempt_at` advanced (purge-held), NO post; flip live → the
  same row drains for real exactly once.
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

**Tier 2 — integration (`tests/integration/`)**
- `/slack/reply` idempotency: two POSTs same `X-Instar-DeliveryId` → one
  `sendToChannel` call, second returns `idempotent:true`; id recorded only
  after success; system-template bypass accepts the fixed template, rejects
  arbitrary text with the header.
- `/slack/reply` dedup: identical long text twice within window → one send +
  `suppressedDuplicate`; brief ack twice → two sends.
- `/internal/slack-forward` (round-1 M6): ANY payload → `409
  misdirected-route` typed refusal + the one-time attention breadcrumb (today
  it sends ungated — the regression this closes); auth still required (an
  unauthed request stays 401, never reaches the refusal).
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
   ledger beside `SqliteOutboundDedupStore`, 24h TTL, hot LRU in front,
   fail-open-to-in-memory degradation.

## Open questions

*(none — all resolved into §8 Frontloaded Decisions as of the round-2
revision)*
