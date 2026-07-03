---
title: "Slack Outbound Delivery Robustness — channel-typed relay queue, sentinel lane, delivery-id idempotency, gated slack-forward (roadmap Phase 2.1)"
slug: "slack-outbound-robustness"
author: "echo"
status: "draft"
parent-principle: "The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery (a delivery layer fails toward DELIVERY for conversational replies; its own infra failure must never become the user's silence)"
sibling-principles: "Structure > Willpower (a durable queue, not a session remembering to retry); A Refusal Stays a Refusal / P18 (every drop is a counter + ledger row, never silent); Bounded Notification Surface (P17 — one deduped escalation per failure episode); Bounded Blast Radius (P19 — breaker on every loop); Migration Parity (additive SQLite columns, never destructive); Verify the State, Not Its Symbol (delivery state machine over 'the curl said ok'); Signal vs Authority (the sentinel never overrides the tone gate)"
constitution: "The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery (docs/STANDARDS-REGISTRY.md); Guards Degrade, Not Outage; Bounded Notification Surface (P17); A Refusal Stays a Refusal (P18); Bounded Blast Radius (P19); Migration Parity Standard; Testing Integrity Standard"
lessons-engaged: "2026-06-05 restore-purge silent deletion (five queued outbound messages eaten at boot — delivery-failure-sentinel.ts:83-90; every purge here is LOUD and channel-tagged) · 2026-06-06 duplicate-message fix (byte-identical status 13.5 min apart — OutboundContentDedup.ts:5-12; the same dedup now covers Slack) · 2026-06-05 restart-cascade never-drains (immediate first drain on start — delivery-failure-sentinel.ts:258-271; inherited by the Slack lane unchanged) · outbound-gate-tiered-fail-direction (fail direction argued per failure point, §3) · Maturation Path — Every Feature Ships Enabled on Developer Agents (§6 rollout ladder)"
earned-from: "docs/audits/slack-ai-employee-audit-2026-07.md §3.1 'Outbound robustness (queue/retry/dedup/idempotency/formatter): MISSING (tone gate only; one internal route bypasses even that)'; live incident record in telegram-delivery-robustness.md (the Telegram lane exists because these exact losses happened there first)"
roadmap: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md Phase 2.1 — live proof: 'Kill network mid-reply; message arrives exactly once with a sentinel audit row'"
parent-spec: "docs/specs/telegram-delivery-robustness.md (Layers 1-3 — this spec generalizes them); docs/roadmaps/instar-two-goal-roadmap-2026-07.md (Phase 2, depends on Phase 1)"
depends-on: "docs/specs/durable-conversation-identity.md — the Phase-1 KEYSTONE, at ROUND-6 REVIEW (worktree .worktrees/conversation-identity, commit 69004a39c, status draft). THIS SPEC'S BUILD IS GATED on the keystone's review convergence + build landing: every conversation address in this spec is a Phase-1 minted id (`topic_id < 0` ⇄ tuple (slack, channelId, threadTs?) ⇄ canonical key slack:<teamId>:<channelId>[:<threadTs>]), resolved through the ConversationRegistry, and §11.1 of the keystone explicitly defers this exact lane here. Also: pending-relay-store (src/messaging/pending-relay-store.ts — Layer 2, extended additively); DeliveryFailureSentinel (src/monitoring/delivery-failure-sentinel.ts — Layer 3, channel-typed); recovery-policy pure module (src/monitoring/delivery-failure-sentinel/recovery-policy.ts — reused byte-unchanged); MessagingToneGate + checkOutboundMessage (src/server/routes.ts:2103); OutboundContentDedup (src/messaging/OutboundContentDedup.ts); slack-reply.sh template refresh machinery (src/core/PostUpdateMigrator.ts:7792-7799)"
supervision: "tier0 — the queue drain + recovery state machine is a byte-deterministic pipeline (the same rationale as the deployed Telegram lane: policy is the pure recovery-policy module, exhaustively table-testable); the LLM judgment call in the path is the EXISTING MessagingToneGate, which keeps its own supervision posture. Declared supervisor-equivalent: the §7 three-tier suite + the live-proof scenario."
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
   server (24h dedup, mirroring `/telegram/reply`'s LRU — `routes.ts:11167-11180`),
   and AT LEAST once via the durable queue + sentinel redrive — converging to
   exactly-once, with the one honestly-named exception inherited from the
   Telegram lane: an **ambiguous** outcome (HTTP 408 / response-lost after the
   Slack API may have accepted the post) finalizes as `delivered-ambiguous` and
   is NEVER blindly re-posted (`recovery-policy.ts` `finalize-ambiguous`;
   `slack-reply.sh:108-117` already prints the AMBIGUOUS guidance). Content
   dedup (§2.5) is the second net under that window.
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
   (`delivery-failure-sentinel.ts:670-705` — the 2026-06-05 lesson, inherited);
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
6. **No unbounded loops (P19).** The escalation circuit breaker
   (`delivery-failure-sentinel.ts:592-614` — N consecutive escalation failures
   in a window trips suspension; config-rotation or manual `resume()` unsuspends)
   is inherited by the Slack lane; the per-topic rate cap
   (`perTopicRateMs`, `:66-67`) and `maxConcurrent` (`:68-69`) bound drain
   throughput; the selector is LIMIT-bounded (`pending-relay-store.ts:375-390`).

## 1. Problem — the grounded gaps (every claim cited)

The Telegram outbound path is a seven-layer robustness stack. The Slack
outbound path is a single ungated-or-once-gated HTTP hop. Side by side:

| Property | Telegram (deployed) | Slack (deployed) |
|---|---|---|
| Tone gate on the reply route | `/telegram/reply/:topicId` → `checkOutboundMessage` (`routes.ts:11286-11298`) | `/slack/reply/:channelId` → `checkOutboundMessage` (`routes.ts:12176-12186`) — **present** |
| Tone gate on the internal route | `/internal/telegram-forward` is INBOUND (session inject + sentinel intercept + exactly-once ledger, `routes.ts:16961+`) | **`/internal/slack-forward` calls `ctx.slack.sendToChannel(channelId, text)` with NO gate, NO dedup, NO delivery-id** (`routes.ts:12233-12251`) — the audit's "one internal route bypasses even that" |
| Delivery-id idempotency | `X-Instar-DeliveryId` 24h LRU (`routes.ts:1615-1641`, checked `:11173-11180`, recorded `:11372-11376`) | **absent** — `/slack/reply` never reads the header |
| Content dedup (same text, fresh id) | `OutboundContentDedup`, SQLite-backed, before the gate (`routes.ts:1644-1660`, `:11272-11276`, recorded `:11324`) | **absent** — a Slack re-announce after restart double-posts |
| Durable failure queue (Layer 2) | script-side SQLite enqueue + `POST /events/delivery-failed` (`templates/scripts/telegram-reply.sh:391-666`; store `src/messaging/pending-relay-store.ts`) | **absent** — `slack-reply.sh` exits 1 and the message is GONE (`templates/scripts/slack-reply.sh:128-131`) |
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

**Build gate (depends-on, restated normatively):** the keystone is at ROUND-6
review (commit 69004a39c, `review-convergence: null`). This spec may CONVERGE
in parallel, but its BUILD must not start until the keystone (a) converges and
(b) its registry + `deliverToConversation` funnel increments are merged. Every
`registry.resolve(id)` call below is against that landed code.

## 2. Design

### 2.0 Shape of the change (one paragraph)

Extend the EXISTING three layers rather than building parallel Slack ones.
Layer 2 (`PendingRelayStore`) gains two additive columns — `channel` (default
`'telegram'`) and `conversation_ref` (advisory canonical key) — via the
store's existing idempotent-ALTER machinery. Layer 1 (`slack-reply.sh`) gains
the same recoverable-failure classifier + enqueue + `POST
/events/delivery-failed` tail that `telegram-reply.sh` already has, writing
`channel:'slack'` rows addressed by minted id. Layer 3
(`DeliveryFailureSentinel`) dispatches per-row on `channel`: tone-gate channel,
redrive route, and escalation target become channel-resolved; policy, backoff,
breaker, stampede, and purge logic are untouched. `/slack/reply` gains the
delivery-id LRU + content dedup the Telegram route has; `/internal/slack-forward`
goes through the gate. One new JSONL audit ledger records every transition.

### 2.1 Addressing — everything is a minted id (the Phase-1 contract)

- **The queue row's primary address is `topic_id`**, unchanged. For Slack rows
  it holds the keystone's minted NEGATIVE id (`id < 0` ⇄
  `(slack, channelId, threadTs?)`; durable-conversation-identity.md §0, §2).
  Positive ids remain Telegram verbatim. NO string channel-id column becomes a
  routing key — reach the transport address by `registry.resolve(id)` at DRAIN
  time, never by persisting `C…:<ts>` as authority.
- **Resolve at drain time, not enqueue time.** A row can sit queued for up to
  24h; resolving at redrive means a teamId backfill or registry heal that
  happened meanwhile is honored. An UNRESOLVABLE minted id at drain time is a
  typed retry (policy input `httpCode: 0`-class) and eventually escalates —
  never a silent drop, matching the keystone funnel's typed-failure posture
  (durable-conversation-identity.md §5, `id<0` unresolvable arm).
- **`conversation_ref` (new column) is ADVISORY.** It stores the canonical key
  string (`slack:<teamId>:<channelId>[:<threadTs>]`) captured at enqueue, for
  audit rows, operator debugging, and a LOUD diagnostic when resolve-at-drain
  disagrees with it. It is never used to deliver. (Know Your Principal /
  keystone §7 posture: the registry is the identity authority; a string riding
  a row is data.)
- **Thread delivery**: the resolve yields `threadTs?`; the redrive POSTs
  `/slack/reply/:channelId` with `thread_ts` so a thread conversation delivers
  IN-THREAD (same behavior the keystone funnel pins for the normal arm,
  durable-conversation-identity.md §5 `id < 0 (normal)`).
- **Relationship to the keystone's E1 funnel guard**: E1 dedups a LOGICAL SEND
  (`commitmentId + sendSeq`) at the `deliverToConversation` funnel for beacon
  traffic. This spec's delivery-id + content dedup operate at the ROUTE for
  ALL traffic. They compose; neither replaces the other. A beacon send that
  reaches the route carries its own delivery-id like any caller.

### 2.2 Layer 2 — channel-typed `PendingRelayStore` (additive, migration-parity)

Schema change, riding the deployed idempotent `COLUMN_ADDS` pattern
(`pending-relay-store.ts:134-143` — "if column missing, ALTER TABLE ADD
COLUMN", duplicate-column errors swallowed):

```sql
ALTER TABLE entries ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE entries ADD COLUMN conversation_ref TEXT;  -- advisory canonical key
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
- **Selectors stay channel-agnostic.** `selectClaimable` (`:375-390`) returns
  rows of every channel; the SENTINEL dispatches per-row (§2.3). Rationale:
  one drain loop, one breaker, one rate-cap bookkeeping — a per-channel
  selector would need per-channel P19 state for no benefit. The reap-notify
  PK-range exclusion is untouched.
- New index: none required. The dedup-window query
  `findByTopicAndHashWithin` (`:285-299`) already keys on
  `(topic_id, text_hash)` which is unique across channels because minted ids
  are globally unique (keystone §3.3 mint rule).
- The dual writer parity note: `telegram-reply.sh` embeds its own schema
  bootstrap + INSERT (`templates/scripts/telegram-reply.sh:500-560, 604-625`).
  Its CREATE/ALTER mirror gains the same two columns; `slack-reply.sh`'s new
  enqueue path (§2.6) shares that exact embedded SQL shape. The
  TemplatesDriftVerifier (Layer 7) covers both scripts already.

### 2.3 Layer 3 — `DeliveryFailureSentinel` channel dispatch

The sentinel gains a small per-channel delivery table; everything stateful is
shared. Per row, three call sites become channel-resolved:

1. **Tone gate**: `checkToneLocally(gate, text, { channel: row.channel })` —
   replacing the hardcode at `delivery-failure-sentinel.ts:439-441`. The gate
   already accepts a string channel (`MessagingToneGate.ts:525`;
   `/slack/reply` passes `'slack'` today, `routes.ts:12177`).
2. **Redrive**: `deps.postReply` becomes `deps.postReplyFor(channel)` —
   `'telegram'` keeps `defaultPostReply` (`:734-793`) verbatim; `'slack'` gets
   `defaultPostReplySlack`, which (a) `registry.resolve(row.topic_id)` →
   `{channelId, threadTs}`, (b) POSTs
   `/slack/reply/${channelId}` with `{ text, thread_ts }` and headers
   `X-Instar-DeliveryId: row.delivery_id`, `X-Instar-AgentId`, and
   `X-Instar-System: true` when redriving fixed templates — the SAME
   header contract, so the route-side idempotency (§2.4) sees it.
3. **Escalation / stampede digest / recovered marker / tone-gate-rejection
   notice** (`:513`, `:575`, `:657`, `:492`): all route through the same
   `postReplyFor(row.channel)`, so the failure NOTICE lands in the failing
   conversation on its own platform. Fixed templates
   (`system-templates.ts`) are channel-neutral text and pass the `/slack/reply`
   gate under the same `X-Instar-System` membership check the Telegram route
   applies (`routes.ts:11182-11191`) — **which `/slack/reply` must therefore
   also implement** (today it has no system-template bypass; §2.4 adds it,
   restricted to the same compiled-in template set).
4. **An unknown `channel` value** (a future platform, or corruption) is a
   typed terminal: transition to `escalated` with reason
   `unsupported-channel`, one P18 ledger row, one degradation report — never a
   crash loop over the same row (P19).

Unchanged and shared: claim CAS + lease format (`:398-405`, `:385-395`),
`evaluatePolicy` and the backoff schedule (`recovery-policy.ts` —
byte-untouched), circuit breaker (`:592-646`), restore-purge semantics incl.
the hold exemption and far-future clamp (`pending-relay-store.ts:478-541`),
stampede grouping (keys on `topic_id` = minted id — already per-conversation),
per-topic rate cap (`lastTopicDelivery` Map keyed by number — minted ids fit).

**Whoami gate scope**: the `/whoami` identity check (`:410-432`) protects
against replying through a rotated/foreign server config; it is
channel-independent and runs for Slack rows unchanged.

### 2.4 `/slack/reply` — delivery-id idempotency + system-template bypass

Mirroring `/telegram/reply` exactly (same helpers, no new machinery):

- Read `X-Instar-DeliveryId`; if `deliveryLruHas(id)` → `200 { ok, idempotent:
  true }` WITHOUT posting (`routes.ts:1615-1641` helpers are already
  route-file-scoped; the Slack route calls the same two functions).
- Record the id in the LRU only AFTER `sendToChannel` returns a `ts`
  (paralleling `routes.ts:11372-11376` — a failed send must not poison the id).
- `X-Instar-System: true` + `matchesSystemTemplate(text)` bypasses the tone
  gate for the sentinel's compiled-in templates only (paralleling
  `routes.ts:11182-11191`). Arbitrary text with the header still gates.
- **Honest scope note**: the LRU is in-memory (24h TTL, 10k cap). Restart
  wipes it — the durable half of exactly-once is the queue row's state
  machine (a row already `delivered-recovered` is never re-selected), so the
  LRU only needs to cover the "200-but-response-lost re-POST" window, same as
  Telegram. The §7 restart test pins the combined behavior.

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
   (reverse lookup, keystone §3.1); when the conversation is not yet minted
   (pre-first-inbound edge), dedup falls back to keying on the routing-key
   string hash — fail-open to delivery, never a block.
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
  the per-agent SQLite queue with `channel:'slack'`, `topic_id` = the minted
  id, `conversation_ref` = the canonical key, then best-effort
  `POST /events/delivery-failed` so the in-process sentinel reacts in <1s
  (`routes.ts:2741-2749` fan-out; the event payload gains an optional
  `channel` field, default `'telegram'`).
- **Where the script gets the minted id**: the session-start context for a
  Slack-bound session carries it once the keystone's §6.3 eager-mint lands
  (minted at first inbound). The script receives it as an env/argument
  (`INSTAR_CONVERSATION_ID`), falling back to asking the server
  (`GET /conversations/resolve?channel=…&thread=…`, a keystone read route).
  If NEITHER yields an id (server down + no env), the script enqueues with
  `topic_id = 0` + the `conversation_ref` key and the sentinel resolves the
  ref at drain — the ONE case `conversation_ref` is load-bearing; the drain
  path re-verifies via the registry before posting, and an unresolvable ref
  escalates (typed, P18-ledgered). **[open-question OQ-2 pins this fallback.]**
- 422 (tone gate) remains terminal at the script (exit 1, revise-and-retry
  guidance — `slack-reply.sh:118-127` unchanged); 408 remains AMBIGUOUS
  guidance (`:108-117` unchanged) — never blind-enqueued (that would
  double-post; property 1).
- Non-recoverable (4xx auth/shape errors) remain exit-1 without enqueue.
- Migration parity for the script: the template refresh rides the existing
  `slack-reply.sh` refresh entry (`PostUpdateMigrator.ts:7792-7799`) with a
  NEW `featureMarker` (`slack-reply-feature: relay-queue`) so deployed agents
  get the tail on update, per the always-refresh scripts machinery.

### 2.7 `/internal/slack-forward` — through the gate (and an honesty note)

As deployed, `POST /internal/slack-forward` takes `{channelId, text}` and
calls `ctx.slack.sendToChannel(channelId, text)` with NO tone gate, NO dedup,
NO delivery-id (`routes.ts:12233-12251`). Change (the roadmap item's literal
clause):

- Run `checkOutboundMessage(text, 'slack', res, { messageKind, topicId:
  <resolved minted id> })` before sending — the identical gate call the
  public route makes (`routes.ts:12176-12186`).
- Honor `X-Instar-DeliveryId` + content dedup exactly as §2.4/§2.5 (shared
  helpers).
- **Grounded anomaly, flagged for Phase 2.2 (not fixed here):** the route's
  only caller is `SlackLifeline.forwardToServer`
  (`src/lifeline/SlackLifeline.ts:182-204`), which forwards INBOUND user
  messages (prefixed `[slack:<channel>] …`) when the socket lives in the
  lifeline process — yet the route, as written, POSTS that text back OUT to
  the channel. Since SlackLifeline is "written but never instantiated"
  (audit §3.1 org-readiness row), this echo path has never run live. Phase
  2.2 (SlackLifeline instantiation) owns re-pointing the route at session
  injection parity with `/internal/telegram-forward` (`routes.ts:16961+` —
  sentinel intercept, exactly-once ledger, version handshake). THIS spec only
  guarantees: whatever text leaves through this route passes the gate and the
  dedup/idempotency layers, and the route logs one breadcrumb naming the
  anomaly when hit. **[open-question OQ-1: gate-only vs. minimal re-point now.]**

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
| Registry can't resolve a minted id at drain | toward retry, then loud | policy retry with backoff → `escalated` + P18 ledger row; never a guess-delivery to a hash-derived channel |
| Tone gate 422 on redrive | WITHHOLD (verdict) | `delivered-tone-gated` terminal + fixed-template meta-notice — the sentinel never overrides the gate (`delivery-failure-sentinel.ts:439-444, 503-519`) |
| Tone gate UNAVAILABLE on redrive | per gate's own tiered policy | the gate owns availability-failure direction (outbound-gate-tiered-fail-direction; `MessagingToneGate.ts:608-621`); the sentinel treats a gate ERROR as a transient retry, not a drop |
| Slack API 5xx / network down | toward retry | recoverable class → backoff schedule (property 2) |
| Slack API 408 / ambiguous | toward NOT double-posting | `delivered-ambiguous` terminal (property 1) — content dedup is the net if a caller manually resends |
| Sentinel escalation itself fails repeatedly | toward pause-with-queue-intact | P19 breaker suspends RETRIES; rows stay queued (never deleted); degradation report names the resume levers (`:600-613`) |
| Server restart with queued rows | toward delivery | immediate first drain on `start()` (`:258-271`); restore-purge only beyond 60min staleness, LOUD, hold-exempt (`:670-705`) |
| Duplicate POST same delivery-id | toward idempotent-200 | LRU (§2.4) — "delivered once" beats "delivered again" |

## 4. Observability (P18 concretely)

### 4.1 Counters

The sentinel's per-tick counters (`processed/recovered/escalated`,
`delivery-failure-sentinel.ts:306-317`) gain a `byChannel` breakdown, surfaced
on the existing sentinel events and a small read route
`GET /delivery-recovery/status` (queue depth by channel+state, breaker state,
last tick — Registry First for "did my Slack reply make it?").

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
      "enabled": false,            // EXISTING master gate (unchanged; AgentServer.ts:3828-3829)
      "channels": ["telegram"],    // NEW — which channels the drain redrives.
                                   // OMITTED ⇒ ["telegram"] on the fleet;
                                   // ["telegram","slack"] on a development agent
                                   // (the developmentAgent gate pattern,
                                   // MultiMachineCoordinator.ts:113-118 precedent).
      "slackDryRun": true          // NEW — Slack lane logs would-redrive verdicts
                                   // (full state machine, ledger rows tagged dryRun:true)
                                   // but posts NOTHING until an explicit false.
    }
  }
}
```

- **Rollout ladder (Maturation Path):** dark on the fleet (`channels` omitted
  ⇒ telegram-only), live-in-dryRun on the dev agent, then `slackDryRun:false`
  on dev after the §7 live proof passes, then fleet default flip in a later
  release. Enqueue (Layers 1-2) ships UNCONDITIONALLY like Telegram's did
  (`delivery-failure-sentinel.ts:32-35` — "Layer 1 + Layer 2 ship
  unconditionally; Layer 3 is opt-in"): a queued-but-not-yet-drained row is
  strictly better than a lost message, and the 24h TTL bounds it.
- **`migrateConfig()` parity:** add-missing-only — `channels` and
  `slackDryRun` are added ONLY when the `deliveryFailureSentinel` block
  already exists AND lacks them; the migration never materializes
  `enabled:false` into a config that omitted the block (the keystone's §9
  posture, and the standing migrateConfig rule). Idempotent by existence
  check.
- **Route-side pieces** (delivery-id LRU, content dedup, gated slack-forward)
  are NOT flagged — they are strict safety additions with the `allowDuplicate`
  escape hatch, matching how the Telegram equivalents shipped (default-on in
  code, `outboundContentDedup` config block already tunable,
  `routes.ts:1652-1654`).
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
  and GAINS the gate — strictly less exposure than today.
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
  slack postReply target + `channel:'slack'` tone gate; telegram row
  byte-identical to today (regression); unknown channel → `escalated
  unsupported-channel` + ledger row, loop terminates (P19); unresolvable
  minted id → retry → escalate; escalation/stampede/recovered-marker route to
  the row's channel; breaker + backoff shared across channels (a Slack storm
  trips the SAME breaker — asserted).
- `recovery-policy` untouched — existing table tests prove byte-parity.
- Dedup: slack content-dedup keyed on minted id; length floor; allowDuplicate
  bypass; record-only-after-success.
- Fail-direction units: store-open failure → direct send still called;
  ledger-append failure → delivery still proceeds.

**Tier 2 — integration (`tests/integration/`)**
- `/slack/reply` idempotency: two POSTs same `X-Instar-DeliveryId` → one
  `sendToChannel` call, second returns `idempotent:true`; id recorded only
  after success; system-template bypass accepts the fixed template, rejects
  arbitrary text with the header.
- `/slack/reply` dedup: identical long text twice within window → one send +
  `suppressedDuplicate`; brief ack twice → two sends.
- `/internal/slack-forward`: 422 body from the gate on a leak-shaped text
  (today it sends — the regression this closes); gated-and-clean text sends;
  auth still required.
- Full pipeline: enqueue slack row via `POST /events/delivery-failed`
  (channel:'slack') → sentinel tick (test-driven, `tick()` is public) → mocked
  registry resolve → mocked `/slack/reply` 200 → row `delivered-recovered` +
  audit ledger row present. Same with 500→backoff→200; with 422→
  `delivered-tone-gated` + meta-notice; with exhaustion→`escalated` once (P17).
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
- Restart test: enqueue → restart server → immediate first drain delivers
  exactly once (LRU wiped but row state machine holds — property 1's honest
  scope).

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

## 8. Open questions (embedded, for the review ceremony)

- **OQ-1 — `/internal/slack-forward` scope.** Gate-only (this spec) leaves a
  route whose semantics are inbound-shaped but whose body is outbound-shaped
  (§2.7). Is a minimal re-point (inject to session, mirroring
  `/internal/telegram-forward`) small enough to pull into 2.1, or does it
  drag the whole 2.2 ingress-ledger design in? Current position: gate-only +
  breadcrumb; 2.2 owns the re-point. Reviewers should challenge this.
- **OQ-2 — the `topic_id = 0` unresolved-enqueue fallback (§2.6).** It keeps
  Layer 2 loss-proof when the server is down AND no minted id is in the env,
  at the cost of a second (ref-based) resolve path in the drain. Alternative:
  refuse to enqueue without a minted id (simpler, but re-opens a loss window
  exactly when the server is down — the case the queue exists for). Current
  position: keep the fallback; it is small and P18-ledgered.
- **OQ-3 — fleet default for `channels`.** Should the Slack lane EVER default
  on fleet-wide, given `deliveryFailureSentinel.enabled` itself is default-OFF
  (`AgentServer.ts:3823-3829`)? Current position: `channels` defaults to
  include `'slack'` only via the dev-agent gate until the Telegram-lane
  canary criteria (telegram-delivery-robustness.md §3i) are re-evaluated for
  both channels together.
- **OQ-4 — delivery-id durability.** The 24h LRU is in-memory on both routes.
  A durable id-ledger (SQLite, like `SqliteOutboundDedupStore`) would close
  the restart re-POST window entirely. Current position: not needed — the row
  state machine covers the sentinel path, and non-sentinel callers get content
  dedup (already durable, `routes.ts:1652-1660`); revisit if the §7 restart
  test finds a real gap.
