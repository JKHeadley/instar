---
title: Notification UX Coherence — the calm Agent-Health lane
status: converged
tier: 2
review-convergence: 2 adversarial+integration reviewers (2026-06-04), grounded in code; 10 findings folded in (see Convergence Resolutions). Both independently converged on: edit-in-place is the wrong mechanism (→ suppression dedup), lane routing must precede+bypass the guard, protectedSessions not yet wired to the backstop.
approved: true
---

# Notification UX Coherence

## Problem (grounded, 2026-06-04)

Self-health/housekeeping escalations flood the user with Telegram **topic-after-topic** of
low-value notices. Concretely, of one agent's 116 forum topics, **54 were auto-generated
noise**: `🟠 Session "topic-19077" is stale but unkillable` (×6 recent), `can't reach X —
unknown routing` (×37), `echo-X went quiet` (×20). The operator's verdict: *"the functionality
isn't bad, it may be misdirected — we need a better user experience."*

Three structural causes (verified in code):

1. **HIGH severity bypasses the flood guard.** `AttentionTopicGuard.decide()`
   (`src/messaging/AttentionTopicGuard.ts:120`) lets `HIGH/URGENT/CRITICAL` *always* spawn
   their own topic and never counts them — by design, so genuine criticals are never coalesced.
   But `StaleSessionBackstop.escalateSession()` (`src/monitoring/StaleSessionBackstop.ts:261`)
   tags routine "stale but unkillable" housekeeping as **HIGH**, so it floods freely. Same for
   the Threadline routing-failure and went-quiet escalators.

2. **Per-episode (not per-entity) dedup spawns repeats.** `stale-${session.id}-${episodeSeq}`
   (`StaleSessionBackstop.ts:255`) — a session that recovers then re-stalls raises a *new*
   item/topic each episode (we saw topic-19077 escalated as two separate topics).

3. **Notices are unnamed + non-actionable.** Titles use the raw session name (`topic-19077`)
   not the human topic name ("EXO 3.0"), carry no plain-language next step, and don't invite a
   reply. A `getTopicName()` resolver already exists (`TelegramAdapter.ts:2034`) but isn't used
   here.

Plus a **detection misfire** (separate, PR 2): a long-lived autonomous/conversational session
legitimately *waiting* on a multi-minute tool call (transcript static < 512 B/tick, CPU idle,
idle-token stable) is indistinguishable from a wedge after the 30-min `unverifiableEscalateMinutes`
threshold — so healthy long-running sessions get falsely flagged.

## Operator directive (standing, durable)

Every user-facing notification MUST: (1) reference a topic by its **name**, never a bare number;
(2) end with a plain-language **next step**; (3) expect a **conversational reply**. And no feature
may hijack Telegram with topic-after-topic.

## Design

This is a **delivery-shaping** change (same class as `AttentionTopicGuard` / `SentinelNotifier`):
it changes the FORM of self-health delivery; it never gates agent behavior, never drops a notice,
and the underlying detection is unchanged. Ships in two gated PRs.

### PR 1 — the calm Agent-Health lane (messaging layer)

**D1 — A "self-health" notice class routes to ONE named lane, from item #1.**
Introduce an explicit, opt-in marker on an attention item: `lane: 'agent-health'` (additive field
on the attention item type; absent ⇒ today's behavior, fully back-compat). In
`TelegramAdapter.createAttentionItem`, when `lane === 'agent-health'`, route the notice into a
single dedicated, persistently-named **"🩺 Agent Health"** forum topic (created once via
`findOrCreateForumTopic`, reused), and NEVER spawn a per-item topic — even for the first item, even
if mis-tagged HIGH. This is stronger than the flood guard's over-budget coalescing (which still
lets the first N spawn topics): a self-health notice never gets its own topic, period.

**D2 — Severity discipline.** Self-health escalations are reclassified `HIGH → NORMAL`
(`StaleSessionBackstop.escalateSession`, the Threadline routing-failure + went-quiet escalators).
HIGH/URGENT is reserved for genuinely user-actionable events. D1's lane routing is the structural
backstop; D2 is the intent fix. (The genuine global "tmux control plane unreachable" item stays
HIGH — it is already deduped to ONE global item and is a real degradation.)

**D3 — Names + next-step envelope.** A shared builder `buildHealthNotice({ sessionName, topicId,
what, nextStep })` resolves `topicId → human topic name` via the existing registry, and produces a
notice whose title/summary names the topic and ends with a plain-language, reply-able next step.
Example: title `Heads-up on the "EXO 3.0" session`, summary `It hasn't shown visible progress for
~30 min. It's still running — reply "check EXO 3.0" and I'll look, or ignore this if you know it's
fine.` Never emits `topic-<n>`.

**D4 — Per-entity suppression dedup (NOT edit-in-place).** The Agent-Health lane keys notices by a
stable entity key (`healthKey`, e.g. the session id — independent of the attention-store `id`, so
episode semantics in the store are untouched). When the same `healthKey` re-escalates while its
prior lane notice is still within a `dedupWindowMs`, the lane SUPPRESSES the repost (logs it to the
suppression audit, increments a count) rather than appending a duplicate line. A bounded ring
(`maxTrackedKeys`) evicts the oldest keys. (Convergence rejected Telegram `editMessageText`
in-place: it needs per-entity message-id tracking and is race-prone; suppression dedup achieves the
same "calm" with far less risk and no new failure mode.)

PR 1 stops the flood and fixes the UX for ALL self-health notices uniformly, regardless of how
often the detector fires.

### PR 2 — detection accuracy (reduce false positives at the source)

**D5 — Don't cry wolf on healthy long-running sessions.** In `StaleSessionBackstop`:
(a) never escalate a session on the configured `protectedSessions` list;
(b) give conversational (non-job) sessions a separate, more forgiving no-progress threshold
   (`conversationalEscalateMinutes`, default well above 30) — a job runs to completion and is held
   to the strict cpu-seconds test, but a conversational/autonomous session legitimately idles
   between turns and while waiting on long tool calls, so a tight window mis-fires;
(c) keep the existing fake-work guards (tail-hash + cpu-seconds) untouched — this only widens the
   window and exempts protected sessions, never weakens wedge detection.

## Config

```jsonc
"messaging": [{ "config": {
  "agentHealthLane": { "enabled": true, "topicName": "🩺 Agent Health", "maxTrackedKeys": 256 }
}}],
"monitoring": {
  "staleBackstop": { "conversationalEscalateMinutes": 180 }  // PR2; default forgiving
}
```
`agentHealthLane.enabled` defaults **true** (this is the fix; off = today's per-item behavior).

## Invariants
- Never drops a notice — every item still lands in the attention store + a visible lane.
- Never gates agent behavior or information flow (delivery-shaper only).
- Fully back-compat: an item without `lane` is unchanged; a platform without the lane config falls
  back to the existing flood-guard path.
- Genuine HIGH/URGENT user-facing items are untouched — they still get their own topic.

## Testing (all three tiers, per Testing Integrity Standard)
- **Unit**: lane routing (self-health item never spawns a per-item topic; reuses one lane topic);
  per-entity dedup (same key updates, different keys append); `buildHealthNotice` resolves names +
  always includes a next step + never emits `topic-<n>`; severity reclassification; PR2
  `hasForwardProgress`/threshold logic for conversational vs job vs protected.
- **Integration**: `createAttentionItem` with `lane:'agent-health'` → routes to the lane topic,
  not a new per-item topic; HTTP path intact.
- **E2E**: boot the real AgentServer; a self-health escalation produces exactly ONE lane topic for
  N notices (feature-is-alive); flag-off falls back cleanly.

## Migration parity
- `migrateConfig`: add `agentHealthLane` defaults (existence-checked) + the PR2 staleBackstop field.
- CLAUDE.md template: document the Agent-Health lane under monitoring/notifications.
- No hook/skill changes.

## Convergence Resolutions (2026-06-04)

1. **D4 edit-in-place → suppression dedup.** Both reviewers: the flood-notice path appends, and
   Telegram `editMessageText` needs per-entity message-id tracking + is race-prone. Resolved by
   suppression dedup + bounded ring (above). No message edits.
2. **Lane routing precedes + bypasses the guard.** In `createAttentionItem`, the
   `lane === 'agent-health'` branch runs BEFORE `attentionTopicGuard.decide()` and does not invoke
   it — so a self-health notice never gets its own topic even when under budget or mis-tagged HIGH.
3. **`AttentionItem.lane?` is added in `TelegramAdapter.ts`** (where the interface lives, ~line 212),
   typed `lane?: 'agent-health'`. The `createAttentionItem` param is `Omit<AttentionItem, 'createdAt'
   |'updatedAt'|'status'|'topicId'>`, which already INCLUDES `lane`, so callers can pass it.
4. **Dedicated lane topic, not the flood bucket.** Track `agentHealthTopicId: number|null` separately;
   create once via `findOrCreateForumTopic('🩺 Agent Health', SYSTEM color)`. Do NOT reuse
   `floodNoticeTopicByBucket` (different lifecycle). Distinct from the `🛡️ Lifeline` system topic.
5. **healthKey is decoupled from the store `id`.** The lane router derives `healthKey` from
   `item.sourceContext` (preferred) or a stable prefix of `item.id` — NOT the per-episode suffix —
   so the attention store still records each episode while the lane posts once per key per window.
6. **Escalator scope (PR1).** `StaleSessionBackstop.escalateSession` (sets `lane:'agent-health'`,
   `priority:'NORMAL'`, name-resolved text) and `CollaborationRedriveEngine` go through
   `createAttentionItem`. The `AttentionPoster` type (`sentinelWiring.ts`) must gain an optional
   `lane?` field. "went quiet" (`ActiveWorkSilenceSentinel`) + "can't reach…routing" use the
   `SentinelNotifier` path (NOT `createAttentionItem`); they were the OLDER floods — routing them
   through the lane is a fast-follow once PR1's lane exists, tracked but out of PR1 scope.
7. **D2 with D1 in place.** Since lane items bypass the guard (R2), severity no longer controls flood
   for lane items; reclassifying to NORMAL is the intent fix + belt-and-suspenders for any future
   non-lane path. The global "tmux control plane unreachable" item stays HIGH (already one-global).
8. **PR2 wiring.** `protectedSessions` lives in `SessionManagerConfig` and is NOT in `StaleBackstopDeps`
   today — add an `isProtectedSession?: (id) => boolean` dep, wired at server boot. `Session.jobSlug`
   IS available to the backstop → use it for the conversational-vs-job threshold split.
9. **CollaborationRedrive field names differ** (`body` vs `summary`, no `category`) — normalize at the
   call site when adding `lane`. (NIT.)
10. **Default `agentHealthLane.enabled: true` is safe** — only items that explicitly set
   `lane:'agent-health'` route to the lane; every other item is byte-for-byte unchanged.
