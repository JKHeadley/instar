---
title: Attention Topic-Flood Guard — per-source + global forum-topic circuit breaker (the structural backstop; redrive offender fix shipped in PR #495)
slug: attention-topic-flood-guard
author: echo
date: 2026-05-28
status: in-flight
review-convergence: 2026-05-28-four-reviewer-panel
convergence-report: docs/specs/attention-topic-flood-guard.convergence.md
approved: true
approved-by: Justin
approved-via: Telegram topic 11960 ("Approved please continue", 2026-05-28 — after the live incident, the 4-reviewer convergence summary, and the default-budget confirmation)
eli16-overview: attention-topic-flood-guard.eli16.md
ships-staged: false
rollout-flag-path: messaging[].config.attentionTopicGuard
---

# Attention Topic-Flood Guard

## 1. Problem

On 2026-05-28 a live agent (Echo) flooded its operator's Telegram with a wall of
new forum topics — "can't reach `<peer>` — unknown routing", one per peer, every
few minutes, indefinitely. This is the **second** topic-flood of this exact
shape; the first (2026-05-22) came from the silently-stopped sentinels and was
fixed point-wise by `SentinelNotifier` (housekeeping → logs, escalations
coalesced to one system topic, default-off).

Root cause, both times, is structural and unchanged:

1. **`TelegramAdapter.createAttentionItem` spawns a brand-new forum topic per
   item.** This is correct for a genuine, individually-`/ack`-able operator
   to-do. It is catastrophic when a *housekeeping* feature raises attention items
   at volume.
2. **There is no gate at that chokepoint** stopping a high-volume source from
   spawning unbounded topics. Each new feature that raises attention items can
   re-introduce the flood, and the fix-per-feature approach relies on every
   future author remembering the lesson.

The 2026-05-28 trigger was `CollaborationRedriveEngine`:

- Its `known-agents.json` (the Threadline routing address book) was empty on the
  affected machine, so `resolveFingerprint(peer)` returned `null` for **every**
  peer.
- On each null it incremented a per-peer strike counter and, at strike ≥ 3,
  raised an attention item (= a new topic) — then **reset the counter to 0**, so
  it re-escalated the same peer every ~3 sweeps, forever.
- Commitments registered with a 32-char hex **fingerprint** as `relatedAgent`
  (instead of a name) could never resolve by name, guaranteeing the null path
  (the `can't reach 8c7928aa…` entries; CMT-663).

## 2. Goals / non-goals

**Goals**
- Make the topic-flood failure mode *structurally impossible to recur*,
  independent of which feature misbehaves — at the one chokepoint, not per
  feature.
- Fix the specific 2026-05-28 offender so it does not generate the noise in the
  first place.
- Preserve the operator's ability to see genuinely critical, individually
  actionable items as their own topics.
- Ship to the entire fleet through the normal dist update with zero operator
  config.

**Non-goals**
- Changing the Attention queue's one-topic-per-item model for *legitimate*
  operator to-dos.
- Fixing the empty-`known-agents.json` provisioning problem (separate; this spec
  only ensures it degrades quietly).
- Turning `collaborationRedrive` on by default (it stays ship-OFF).

## 3. Design

### 3.1 `AttentionTopicGuard` (the structural backstop)

A pure, unit-testable per-source circuit breaker (`src/messaging/AttentionTopicGuard.ts`),
consulted by `createAttentionItem` *before* it creates a topic.

State: per-source rolling event timestamps + per-bucket episode counter + a
global rolling event timeline; all bounded (stale source keys are evicted, with a
hard `maxTrackedSources` cap). Config (validated/coerced — a `NaN`/negative value
falls back to the default, so a fat-fingered number can never silently disable the
guard): `{ enabled, windowMs, maxTopicsPerSource, maxTopicsGlobal, maxTrackedSources }`,
default `{ true, 600000, 3, 8, 512 }`.

`decide(source, priority) → { action: 'allow' } | { action: 'coalesce', firstInEpisode, suppressedCount, bucket }`:

- Priority normalized to upper-case; `∈ {HIGH, URGENT, CRITICAL}` → **always
  `allow`**, never counted. Critical items always get their own topic. This is the
  load-bearing safety invariant, and it is case-proof (a lower-cased `'high'`
  still bypasses).
- Otherwise key on `source` (the item's `sourceContext`, falling back to
  `category`, then `'unknown'`). Two ceilings are checked: the **per-source**
  budget and a **global** ceiling across all sources. If per-source trips →
  `coalesce` under the *source* bucket (one topic per genuinely-flooding source).
  If only the global trips (many low-volume sources collectively flooding, e.g. a
  mis-wired feature varying its `sourceContext` per item to dodge the per-source
  budget) → `coalesce` under the shared `'*'` global bucket (ONE topic total).
  Else → `allow`. Every decision records an event in both timelines, so a
  *sustained* flood keeps the window full and stays a single episode until a full
  window of silence refills the budget. The global ceiling is what makes the
  "any mis-wired feature is auto-throttled" guarantee independent of source
  cardinality.

`createAttentionItem` on a `coalesce` decision:
- Writes the item to the suppression audit log (`state/attention-suppressed.jsonl`,
  size-capped with one rotation) — nothing is dropped.
- Routes it into ONE reused "notices coalesced" topic for its `bucket` (created
  lazily once per bucket and reused thereafter, so a flapping source does not
  churn a new topic per episode; concurrent coalesced items for one bucket share a
  single in-flight creation, so there is no double-create race).
- Marks the item `coalesced: true` and records the (shared) notice `topicId` for
  reference **only** — it deliberately does NOT register the per-item topic maps
  (`attentionItemToTopic` / `attentionTopicToItem`). Many items share one notice
  topic, so registering them would (a) last-writer-win-corrupt the reverse map on
  `loadAttentionItems` restart and (b) make `updateAttentionStatus` close the
  shared topic when one sibling resolves. Coalesced items are managed via
  `/attention` (PATCH / dashboard), not per-topic `/ack` — `loadAttentionItems`
  skips per-item-map registration for `coalesced` items.
- Returns without creating a per-item topic.

On an `allow` decision the existing per-item-topic path runs unchanged.

### 3.2 The `CollaborationRedriveEngine` offender — handled by PR #495 (merged)

> **Reconciliation (2026-05-28, after approval):** while this change was in
> review, **PR #495** (`a89f83bee`, "CollaborationRedrive — fingerprint-as-
> relatedAgent + escalation-flood cooldown") landed on `main` and fixed the
> 2026-05-28 redrive offender via a durable **per-peer 24h escalation cooldown**
> plus its own fingerprint-as-`relatedAgent` fix. That makes the redrive-specific
> edits originally drafted here (log-only "can't reach", hex trust-gate) redundant
> and conflicting, so they are **dropped** — this change defers the offender fix
> to the merged #495 and ships ONLY the structural backstop (§3.1), which #495
> does NOT provide.

The two are complementary: #495 stops *this feature* from flooding (cooldown); the
`AttentionTopicGuard` stops *any* feature — including a future mis-wired one — from
flooding, at the chokepoint. They compose cleanly: #495's cooldowned escalations
still pass through `createAttentionItem`, so the guard coalesces them too if they
ever exceed budget.

**Residual (noted to the operator):** #495 keeps the "can't reach" escalation
(cooldowned to ≤1/peer/24h) rather than making it log-only, so a handful of
cooldowned notices can still surface per day under the guard budget. If the
operator prefers those fully log-only (per the "housekeeping → logs" principle), a
small follow-up to #495's escalation path would do it <!-- tracked: PR-495 -->; the
guard already prevents any flood regardless.

## 4. Signal vs. authority compliance

`docs/signal-vs-authority.md` requires: no brittle check may hold blocking
authority over agent behavior or information flow.

The guard does **not** block agent behavior or drop information. It is a *delivery
shaper* on an output channel: it changes the *form* of delivery (one coalesced
topic + a log line) for non-critical, high-volume notices, and never withholds a
critical (HIGH/URGENT) notice or deletes an item. It is the same class of
mechanism as `SentinelNotifier` (a delivery sink, explicitly "not a gate, no
blocking authority"). (The redrive offender fix — which downgrades an
authority-bearing escalation on a brittle signal — is PR #495's, not this change's;
see §3.2.)

**Layer positioning (review finding).** The guard deliberately sits *below* the
existing outbound authorities on the `/attention` route (the tone-gate
`checkOutboundMessage` and the CMT-519 threadline-hub redirect). It is the
*transport-mechanics* backstop — a rate-counter on topic creation, an allowed
detector class under the principle's "rate counters / transport dedup" carve-outs
— not a fourth judgment filter on message *meaning*. It does not interpret content;
it only shapes how many topics a high-volume channel may spawn.

**Relationship to `SentinelNotifier` (review finding).** Two coalescing
mechanisms now exist and are intentionally distinct: `SentinelNotifier` is
*generate-or-not* (sentinel housekeeping is never emitted; real escalations
coalesce by a flush-timer into the single reused system topic), while this guard
is *always-record, sometimes-spawn-topic* (it shapes the attention queue, which
every feature can post to). They are not unified because their lifecycles differ;
the shared idea — coalesce housekeeping into one reused topic, never a wall — is
held in both. Note the user-visible consequence: under a multi-source flood you
get one reused notice topic *per flooding source* (plus one shared `'*'` topic if
the global cap trips), not literally a single topic — bounded, not unbounded.

**Naming.** `*Guard` elsewhere in instar denotes hard blockers (`SourceTreeGuard`,
`dangerous-command-guard`). This one does NOT block; the class doc states plainly
it is a delivery shaper, not a gate, to pre-empt that confusion.

## 5. Threat model / edge cases

- **Critical alert suppressed?** No — HIGH/URGENT bypass the guard entirely.
- **Item lost?** No — every coalesced item is in the attention store and the audit
  log; only the per-item topic is withheld.
- **Legitimate burst over-coalesced?** A non-critical source exceeding 3 topics /
  10 min is folded into one topic with every item listed — grouped, not lost, and
  aligned with the operator's stated "only critical things as their own messages"
  intent. Tunable per-adapter; raise the priority to HIGH for always-separate.
- **Notice topic recursion?** The coalesced notice topic is created via
  `createForumTopic` directly, not through `createAttentionItem`, so it cannot
  re-enter the guard.
- **Hex false-positive?** A real agent *name* that is 32–64 hex chars would be
  misrouted as a fingerprint. Agent names are human-readable slugs (`dawn`,
  `instar-codey`); a 32+ hex string is by construction a fingerprint. Acceptable.
- **High-cardinality dodge (review finding):** a source that varies its
  `sourceContext` per item to dodge the per-source budget is bounded by the global
  ceiling — after `maxTopicsGlobal` total topics in the window, everything (of any
  source) coalesces into ONE `'*'` topic. The same eviction logic prevents the
  varied keys from leaking the tracking maps unbounded.
- **Concurrency (review finding):** `createAttentionItem` is async and awaits
  `createForumTopic`; concurrent coalesced items for one bucket share a single
  in-flight creation promise, so they cannot double-create the notice topic.
- **Restart map safety (review finding):** coalesced items are flagged and
  excluded from per-item topic-map registration on load, so N items sharing one
  notice topic cannot corrupt the reverse map (last-writer-win) and resolving one
  never closes the shared topic for its siblings.
- **Config validation (review finding):** numeric config is coerced; a `NaN` or
  negative value falls back to the default rather than silently disabling the
  guard (`>= NaN` is always false).
- **Restart:** guard counters are in-memory (intentionally — a flood episode is a
  short-window phenomenon). After a restart the budget refills; the suppression
  audit log persists on disk (size-capped with one rotation so it can't grow
  unbounded under a sustained flood).

## 6. Testing (all three tiers)

- **Unit:** `AttentionTopicGuard` (budget / global-cap / critical-bypass
  case-insensitive / per-source isolation / sustained-flood-single-episode /
  post-silence-reset / config-validation / key-eviction / disabled);
  `PostUpdateMigrator` (Topic-Flood Guard section backfill + idempotency). (The
  redrive-engine tests are PR #495's, per §3.2.)
- **Integration:** real `TelegramAdapter.createAttentionItem` — a flooding source
  is capped at budget + 1 topics, HIGH bypasses, a different source is unaffected,
  no item dropped, audit log populated.
- **E2E:** stock fleet config (NO `attentionTopicGuard` key) still caps a flood —
  the migration-parity guarantee.

## 7. Migration / rollout

Pure `src/` logic, default-ON in code — no agent-installed file changes, so every
agent is protected on the normal dist update with nothing to patch.
`PostUpdateMigrator.migrateClaudeMd` backfills a "Topic-Flood Guard" awareness
section (idempotent; registered in `feature-delivery-completeness`).
`collaborationRedrive` keeps its ship-OFF default.

## 8. Rollback

Single env/config back-out: set `messaging[].config.attentionTopicGuard.enabled =
false` to restore pre-guard per-item-topic behavior. No data migration, no agent
state repair — the guard holds no durable state and the redrive change only
removes an escalation path. Worst case is a revert of the `src/` diff and a patch
release.
