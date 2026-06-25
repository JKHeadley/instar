---
user_announcement:
  - audience: agent-only
    maturity: experimental
    summary: "(Dev-only, dark on the fleet) A new read-only sentinel detects a conversation whose owner machine is online-by-heartbeat but unable to serve it (quota-walled or adapter-disconnected) and raises ONE attention item — making the silent cross-machine inbound wedge loud within ~a minute instead of waiting for a human to notice missing messages."
---

## What Changed

A new pure-signal monitoring sentinel, `StrandedTopicSentinel`, ships behind a DARK dev-gate (`monitoring.strandedTopicSentinel.enabled`, omitted from ConfigDefaults ⇒ live on a development agent, dark on the fleet). It closes a real, proven gap: a Telegram/Slack topic's durable ownership record can name a machine that is **online-by-heartbeat but cannot serve** — quota-walled (`quotaState.blocked`) or adapter-disconnected (`servesChannels` omits the topic's channel) — while a healthy machine holds the lease. Inbound for that topic routes to the owner that can't answer, so it is **silently dead** (outbound still flows from the healthy machine — the "my replies send but the user's messages never arrive" split). The existing `OwnershipReconciler` only force-claims a *provably-DEAD* owner (offline ≥180s) and only iterates *pinned* topics, so a walled-but-online owner defers forever and an unpinned strand is never even considered.

The sentinel scans the in-memory ownership cache against the replicated machine-pool view each tick (default 60s), applies a fail-closed predicate with a persistence gate (the unable-to-serve condition must hold ≥2 rich beats over ≥`dwellMs`, default 30s, so a transient quota/adapter blip can't trip it), and raises ONE aggregated `agent-health` attention item per (owner-machine, stranding-window) — never one-per-topic — plus a separate LOW "can't-assess" item if a heartbeat/schema regression blinds it. It is **lease-holder-only** (so peers don't double-report), a **strict no-op on a single-machine agent**, registers in the GuardRegistry (`GET /guards`), and **MUTATES NOTHING** — no ownership CAS, no pin write, no session kill.

This is the deliberately-safe HALF of the fix. Spec-convergence review (3 rounds) established that the *instinctive* auto-failover is unsafe with today's primitives — there is no per-topic remote-liveness signal, the reachability signal is self-reported and up to `failoverThresholdMs` stale, and there's no hysteresis — so a wrong failover would yank a live conversation mid-reply, which is strictly worse than the bug. The auto-failover is therefore deferred to a tracked v2 (`CMT-1786`) whose prerequisites are each named in the spec.

## Evidence

- **Reproduction (the live incident, 2026-06-24):** 17 of 25 topics were owned by an offline/quota-walled Mac Mini; every one had silently-dead Telegram inbound; every code review and CI gate was green the whole time; the wedge surfaced only when the operator reported missing messages. `GET /pool/placement?topic=N` showed `owner=Mini, pendingReplacement:true` — the signal was present and unmonitored. The only recovery was a human hand-editing `.instar/ownership/local/<topicId>.json`.
- **Before → after:** before, this class of breakage was invisible to all automated checks until a user got bitten. After (dev-gated), the moment a topic's owner is persistently online-but-unable-to-serve, ONE attention item fires within ~`dwellMs + tickMs` (≈ a minute or two on a healthy heartbeat cadence) naming the stranded topics, the walled owner + reason, whether a servable peer exists, and the signal's staleness. Flag off (the fleet) is byte-identical to today (no sentinel).
- **Safety verified:** the sentinel is pure signal — it raises an attention item and writes nothing. The fail-closed predicate (missing field / stale beat / underivable scope / pool view unavailable ⇒ SKIP) means an uncertainty can never manufacture a strand; the lease-holder-sole-actor + single-machine no-op prevent duplicate items; the aggregated item rides the existing `AttentionTopicGuard` flood ceiling.
- **Tests:** 29 unit tests on the pure decision core (both sides of every boundary — quota arm, three-valued adapter arm, persistence/dwell, fail-closed skips, `strandedSince` reconciliation, can't-assess counting, servable-peer, single-machine/non-lease-holder no-op, sync/LLM-free invariant) + GuardRegistry registration + a `/guards`-posture integration check. `tsc --noEmit` clean. Multi-angle spec review (6 internal reviewers + GPT-5.5 cross-model, 3 rounds) drove the design from an unsafe auto-failover to this safe detector and caught a critical predicate bug (the three-valued `machineServesChannel` would have made a `!fn(...)` detector never fire).

## What to Tell Your User

Nothing visible day-to-day — it's off everywhere except the development machine until it's soaked. The eventual benefit: a conversation whose messages are silently going to a machine that can't answer them gets caught within about a minute, instead of staying invisible until you notice you're being ignored.

## Summary of New Capabilities

- `monitoring.strandedTopicSentinel.enabled` (dev-gated dark flag): a pure-signal sentinel that detects an online-but-unable-to-serve owner stranding a topic's inbound and raises one aggregated `agent-health` attention item; registered on `GET /guards`.
- `evaluateStrandedTopics(...)` (pure helper): the unit-testable, fail-closed strand decision (quota arm + best-effort adapter arm + dwell persistence + reconciliation).
- Deferred (CMT-1786): the auto-failover that actually re-points a stranded topic to a healthy server, plus its named prerequisites (per-topic remote liveness signal, hysteresis/cooldown, claim-time re-assertion, atomic CAS+pin, reason-stamped nonce, OwnershipReconciler unification) and a live userbot harness for real-Telegram UX regression testing.
