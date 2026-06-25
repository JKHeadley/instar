---
title: "Stranded-inbound detector — surface a topic whose owner is online-but-unable-to-serve"
slug: stranded-inbound-self-heal
eli16-overview: stranded-inbound-self-heal.eli16.md
parent-principle: "Structure beats Willpower — a cross-machine inbound wedge (a topic owned by a machine that is online-by-heartbeat but cannot serve) was silently un-recovered until a human noticed his messages stopped arriving; replace 'a human eventually notices' with a structural detector that surfaces the wedge the moment it forms."
author: echo
created: 2026-06-24
status: draft
review-convergence: "2026-06-25T00:45:03.315Z"
review-iterations: 3
review-completed-at: "2026-06-25T00:45:03.315Z"
review-report: "docs/specs/reports/stranded-inbound-self-heal-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 6
contested-then-cleared: 0
approved: true
approved-by: "echo (standing 8-hour autonomous-run pre-approval, 2026-06-24; design/scope forks are mine to resolve — the review-driven descope to detection-only is exactly such a fork)"
---

# Stranded-inbound detector

## Problem (proven live, 2026-06-24)

A Telegram topic's durable ownership record can name a machine that is **online-by-heartbeat but cannot serve** — quota-walled (`quotaState.blocked:true`) or adapter-disconnected (`servesChannels` omits the topic's platform) — while a different, healthy machine holds the lease. The topic's inbound messages route to the owner that cannot serve them, so they never reach a machine that can: **inbound is silently dead for that topic** (outbound replies still flow from the healthy machine, producing the confusing "my replies send but his messages never arrive" split).

This is NOT covered by the existing `OwnershipReconciler` (WS1.3):
- Its force-claim path (Case C, `OwnershipReconciler.ts:201`) fires only on a **provably DEAD** owner (`!online && (now − lastSeenMs) >= deathEvidenceMs`, 180s) + quorum, and only for a topic **already pinned to self**. A walled owner whose heartbeat is still fresh is `online:true`, so it is "not provably dead" → the reconciler **defers forever** (`report.deferredNoEvidence++`).
- It iterates **pinned** topics only. A stranded topic with no pin (or a stale pin to another walled machine) is never even considered.

The live incident: **17 of 25 topics** were owned by an offline/walled Mac Mini; inbound was broken for all of them; the only recovery was a human hand-editing `.instar/ownership/local/<topicId>.json`. Every code review and CI gate was green while this user-facing regression was invisible to all of them — it surfaced only when the operator got bitten. **This detector is the structural answer to "we keep getting surprised when the operator jumps in":** it makes the wedge loud **within a bounded detection window** (the persistence gate trades a little latency for no false positives: latency ≈ `dwellMs` + one `tickMs` + the rich-heartbeat interval — on a healthy heartbeat cadence that is on the order of a minute or two; if rich beats are sparse/delayed the window stretches accordingly, which is the correct fail-slow-not-false posture), instead of waiting hours for a human to notice missing messages.

## Scope decision (why v1 is detection-only)

The instinctive fix is auto-failover: CAS-reassign the topic off the walled owner onto a healthy server. Spec-convergence review (security + adversarial + lessons-aware, round 1) established that **auto-failover cannot be made safe with the primitives that exist today**, and a wrong failover is *strictly worse than the bug* (it drops a live conversation mid-reply):

1. **No remote per-topic liveness signal.** Heartbeats carry only a scalar `activeSessionCount` (MachinePoolRegistry) — never which *topics* have live sessions. So a failover cannot tell whether the stranded topic has a live session *recovering* on the walled owner (the cooperative path Case C exists to protect) → it could seize a live conversation.
2. **The reachability signal is self-reported and stale.** `quotaState`/`servesChannels` are each machine's own heartbeat self-report, fresh only to the last rich beat and up to `failoverThresholdMs` stale. Elevating that to *authority for a mutation* — on the 2-machine topology where the quorum check (`machines.length <= 2`) is a trivial pass — means a single stale/sparse beat could wrongly seize a topic a healthy owner is serving fine.
3. **No temporal corroboration / hysteresis** exists to distinguish a 5-second quota blip from a durable wall.

Therefore v1 ships the **detector only** (pure signal — raises an attention item, mutates nothing). It is genuinely safe (a false-positive attention item is cheap; a stolen conversation is not) and it delivers the core value: the wedge becomes visible within a bounded window, so the agent (or operator) can act in seconds instead of hours. The auto-failover is a tracked v2 (`## Deferred — the v2 failover`) with its prerequisites named. <!-- tracked: CMT-1786 -->

**Why a polling sentinel, not route-time detection.** An alternative is to flag the strand at inbound-routing time (when a message is dispatched to an unservable owner). Rejected as the v1 surface because a stranded topic's defining symptom is that messages are NOT arriving/being processed — route-time detection only fires when traffic flows, so a quiet stranded topic (the operator hasn't messaged it yet — exactly the 16 topics he had not yet hit) would stay invisible until it's already a problem. A polling sentinel surfaces the wedge proactively, independent of traffic. (Route-time annotation is a reasonable *corroborating* telemetry source for the v2 work, not a replacement for the sentinel.)

## Glossary (load-bearing terms)

- **pin** — a per-topic preferred-machine record in `TopicPlacementPinStore` (`{preferredMachine, pinned, updatedAt}`); a user/operator "run this here".
- **owner** — the machine named by the durable ownership record (`SessionOwnershipRegistry.ownerOf(topic)`); inbound routes to the owner.
- **lease-holder** — the single machine currently holding the fenced serving lease (`syncStatus.holdsLease` / `LeaseCoordinator`).
- **`servesChannels`** — a machine's heartbeat self-report of which platforms/workspaces its adapters are connected to; queried via `machineServesChannel(servesChannels, channel)` (PlacementExecutor).
- **stranded** — an `active`-owned topic whose owner is `online` (heartbeat-fresh) but, persistently across rich beats, cannot serve the topic's channel (`quotaState.blocked || !machineServesChannel(...)`).

## Proposed design (one component, dark-gated, pure-signal)

A new monitoring sentinel **`StrandedTopicSentinel`** (src/monitoring/), following the established sentinel pattern (deps injection, `lastTickAt` liveness, tick loop, dark-gate via `DEV_GATED_FEATURES`, GuardRegistry registration). It introduces **no** new ownership primitive and **never mutates** ownership, pins, or sessions — its sole output is an aggregated attention item.

Per tick (synchronous, LLM-free, acquires NO spawn-cap slot — this invariant is asserted in a test so a future "ask an LLM if it's stranded" can never silently land on the monitoring hot path):

1. **Early no-op gates (fail-closed):** if `machines().length < 2` → strict return (single-machine can't strand on a peer). If this machine is NOT the lease-holder (`!syncStatus.holdsLease`) → return (sole actor, so peers don't each raise a duplicate item). If the machine-pool view is unavailable/stale past a freshness bound → return (can't assess → assess nothing).
2. **Scan ownership records** from the in-memory cache (`ownership.all()`, ~25 records; the cache makes this cheap — no per-tick disk re-scan). For each `active` record whose owner ≠ self:
   - read the owner's `MachineCapacity` from the replicated heartbeat view (in-memory, NO synchronous peer probe).
   - **owner online?** if not online → SKIP (a dead owner is the existing Case C's job; this sentinel only covers the *online-but-unable* gap).
   - **owner unable to serve?** Two arms, evaluated against the owner's latest rich beat:
     - **(a) quota arm — channel-independent, the dominant incident case:** `quotaState.blocked === true`. A quota-walled owner cannot serve ANY topic, so this needs NO channel resolution and covers the live incident (a quota-walled Mini owning 17 topics) directly.
     - **(b) adapter arm — best-effort, channel-specific:** derive the topic's `ChannelScope` (`{platform, chatId|workspaceId}`) from the topic's owning adapter binding (the platform from the topic→adapter mapping; the chat/workspace id from that adapter's config). **Honesty about the source (verified):** there is NO topic→`{platform,chatId}` registry — `TopicBinding`/`TopicProjectBinding` holds project name/dir, not a channel scope. For Telegram the `chatId` is shared adapter config, identical across all machines, so the adapter arm almost never qualifies for Telegram and the **quota arm carries the Telegram case** (exactly the live incident); the adapter arm's real value is the **Slack per-workspace** case (`slack.workspaceIds`). When the scope can't be fully derived, `scope === undefined`. Then call the canonical three-valued `machineServesChannel(servesChannels, scope)`: a result of **`'no'`** (the owner's adapter set structurally excludes the topic's channel) qualifies; **`'unknown'`** (missing/sparse `servesChannels`, OR `scope === undefined`) ⇒ **SKIP**; **`'yes'`** ⇒ owner can serve → not stranded on this arm. (Note: the predicate is `machineServesChannel(...) === 'no'` — NOT `!machineServesChannel(...)`; the function returns a string, so the boolean-negation idiom would be always-false and the detector would never fire.)
   - **Fail-closed on uncertainty throughout:** a missing field, an undecodable beat, or an underivable channel scope can NEVER manufacture a strand — it routes to SKIP. (The quota arm carries detection on its own when the adapter arm must skip.)
   - **persistence:** the unable-to-serve condition must hold across **≥2 consecutive genuine rich heartbeats** spanning **≥ `dwellMs`** (default 30s, the reconciler's debounce reference), tracked in a per-topic `strandedSince` map. A single beat, a sparse liveness-echo beat, or a beat older than the freshness bound does NOT qualify (fail-closed). This kills false positives from a transient quota/adapter blip.
   - **`strandedSince` map reconciliation (no stale residue):** at the END of every tick, the map is reconciled against THIS tick's evaluated candidate set — any key that did NOT re-qualify this tick (its owner went offline, the ownership record was released/deleted, or its scope became underivable, so it fell out via a SKIP rather than by clearing) is **deleted**, not left to resume counting later. This prevents a stale entry from surviving an owner-offline interlude and then short-circuiting the dwell on a later strand. (Bounded anyway by topic count, but correctness — not size — is the point.)
   - if it qualifies → add to this tick's stranded set, annotated with whether a **servable peer exists** — narrowly "an online machine that is not quota-blocked AND `machineServesChannel(...) === 'yes'` for the topic's channel" (reusing the PlacementExecutor filter so detector and placement agree). This is deliberately NOT "a safe failover target": it does not vet pin policy, lease/router readiness, secrets, or session limits, and v1 does not fail over — it only tells the operator "somewhere could serve this" vs "nowhere can (fleet-wide wall)", never "I can safely move it there."
3. **Emit ONE aggregated attention item** for the whole stranded set (never one-per-topic). The dedup key is **(owner-machine, stranding-window-id)** where the window-id is the FIRST qualifying `strandedSince` timestamp for that owner rounded to the dwell epoch; the window stays open (same id → same item, updated in place) until that owner has had **zero stranded topics for N consecutive ticks** (default 3), then closes. A topic-set change or a reason change (quota↔adapter) UPDATES the open item, never opens a new one — so a partial heal or a churn can't spam. It rides the existing `AttentionTopicGuard` flood ceiling (3/source, 8/global per 10min; HIGH/URGENT bypass). The item states the stranded topics, the walled owner + reason (quota / adapter), and whether a healthy server exists ("inbound for these topics is going to <machine>, which can't serve them; <healthy machine> can" vs "no machine can currently serve them — fleet-wide wall"). **The item discloses the signal's staleness** — it appends the owner's last-rich-heartbeat age ("based on <machine>'s last full heartbeat <age> ago") so the operator reads it as an observation to act on, not an over-trusted verdict (Observable Intelligence — the detector knows the signal is up to `failoverThresholdMs` stale; the operator should too). When an owner's stranded set is empty for N ticks, its `strandedSince` entries are cleared and the window closes.
4. **Separate low-severity "can't-assess" signal (the anti-blind-spot guard).** Because predicate step 2 fail-closes on missing/stale/sparse `servesChannels`/`quotaState` (correct, to avoid false strands), a rollout/schema regression that strips those fields would silently BLIND the detector — the exact invisible-failure class this feature exists to kill. So the sentinel ALSO emits ONE separate LOW-severity attention item (and a `/guards` note) when it had to skip ≥1 online owner because its rich heartbeat fields were missing/unparseable, naming the count. This makes "I can't see whether these machines can serve" itself visible, rather than reading as "all clear".

## Decision points touched

This INTRODUCES no new authority. It adds a read-only detector that raises an advisory attention item. It mutates nothing, kills nothing, sends no direct user message. It can only ever ADD an attention item (which the existing flood ceiling already bounds).

## Frontloaded Decisions

- **D1 — Detector-only v1, dark-gated, pure-signal.** `monitoring.strandedTopicSentinel.enabled` registered in `DEV_GATED_FEATURES` (`enabled` OMITTED from ConfigDefaults ⇒ dev-live / dark-fleet); flag-off is byte-identical to today (no detector). No `migrateConfig` entry needed (the flag is omitted, not defaulted). *Cheap-to-change-after:* the flag; and because v1 never mutates, there is no durable-side-effect / identity / money decision in scope — the Decision-Completeness "never cheap" taxonomy does not bite.
- **D2 — Detection predicate = `online && (quotaState.blocked === true || machineServesChannel(servesChannels, scope) === 'no')`, persisted ≥2 rich beats over ≥`dwellMs`, with `'unknown' ⇒ skip` and any missing field / underivable scope ⇒ skip.** (Written against the three-valued `ServeResult` enum — NOT `!machineServesChannel(...)`, which is always-false against a string and would make the detector never fire.) Reuses the canonical PlacementExecutor serve/quota helpers (no re-derivation → no drift). **Serve-check granularity = the adapter's actual connection unit** (workspace for Slack via `slack.workspaceIds`, chat for Telegram via `telegram.chatIds`) — finer (sub-workspace Slack #channel) granularity does not exist in `servesChannels` and is explicitly out of v1 scope; because v1 only raises an advisory attention item, a granularity-induced false positive is a cheap mis-flag, never a wrong mutation (this is exactly why the mutation, where it WOULD matter, is deferred <!-- tracked: CMT-1786 -->). *Cheap-to-change-after:* the predicate is one pure function; thresholds are config (`dwellMs`, freshness bound, `tickMs` default 60s).
- **D3 — ONE aggregated attention item, dedup key = (owner-machine, stranding-window).** Rides `AttentionTopicGuard`'s ceiling; a partial/moved re-strand stays one item. *Cheap-to-change-after:* the dedup key.
- **D4 — Lease-holder is the sole actor; single-machine = strict early-return no-op.** Reads `syncStatus.holdsLease`; mirrors the reconciler's `machines().length < 2` early return. The known lease-self-determination staleness (`FencedLease.ts:164` `effectiveEpoch`) is acceptable here: worst case a just-demoted machine raises ONE extra *advisory* item — harmless for a pure signal (it would be a real bug for a mutation, which is exactly why the mutation is deferred <!-- tracked: CMT-1786 -->). *Cheap-to-change-after:* the actor gate.
- **D5 — Synchronous, LLM-free, no spawn-cap slot, no synchronous peer probe; reads the in-memory replicated heartbeat view + the in-memory ownership cache, with an explicit fail-closed staleness bound.** Asserted by test. **Ownership-cache readiness:** the sentinel reads the SAME in-memory ownership cache the `SessionOwnershipRegistry` keeps current (load-on-boot + write-through on every CAS); if that cache has not yet hydrated (registry not ready post-boot/post-failover), the tick fail-closes (skips) and the `/guards` row reports `degraded` rather than scanning a half-populated cache. *Cheap-to-change-after:* the freshness bound is config.
- **D6 — GuardRegistry registration + `GET /guards` posture row + `lastTickAt` liveness + status route.** So a silently-disabled detector is itself visible on `/guards` (the exact failure class this feature exists to kill). *Cheap-to-change-after:* additive.

## Multi-machine posture

Machine-local detection reading the **replicated** heartbeat machine-pool view + the local in-memory ownership cache; it emits a local attention item only. **Single-machine = strict no-op** (`machines().length < 2`). **Lease-holder is the sole actor**, so across machines exactly one raises the item (no duplicate-voice). No durable state is written, so there is nothing to replicate, proxy, or strand on a topic transfer.

## Signal vs authority

**Pure signal.** The sentinel raises an advisory attention item and writes nothing else — no ownership CAS, no pin write, no session kill, no direct user message. It has no authority to misuse; the operator/agent decides what to do with the surfaced strand. (This is the deliberate, review-driven retreat from the original mutating design.)

## Deferred — the v2 failover (separate spec/PR, prerequisites named) <!-- tracked: CMT-1786 -->

Auto-failover (CAS-reassign a stranded topic to a healthy server) is the eventual goal but is gated on building the primitives that make it safe. Its spec must deliver ALL of:
- **A per-topic remote-session-liveness signal** — extend the heartbeat with the set of topic-ids that have live sessions on each machine (NOT a synchronous peer probe — scalability forbids that on the monitoring path), so "no live session for THIS topic on the owner" is evaluable; fail-closed when unknown. <!-- tracked: CMT-1786 -->
- **Temporal corroboration / hysteresis** — ≥N consecutive rich blocked beats + a minimum block dwell, replacing the inert 2-machine quorum for the `owner-unreachable` trigger; a per-topic heal cooldown; a freshly-healed-pin-authoritative dwell so an un-walling owner doesn't immediately reclaim (anti-flap). <!-- tracked: CMT-1786 -->
- **Claim-time re-assertion** — re-check target `online && machineServesChannel` against the freshest local view immediately before the CAS; prefer self (lease-holder) as target since its liveness is locally certain. <!-- tracked: CMT-1786 -->
- **Atomic CAS + pin-repoint** — define the transaction boundary (single journal entry, or a compensating-retry idempotency loop) so a CAS-succeeds-pin-fails partial can't reintroduce `pendingReplacement` churn. <!-- tracked: CMT-1786 -->
- **A distinct reason-stamped nonce** (`stranded-selfheal:<target>:<epoch>:<ts>`, matching the reconciler's `<self>:<reason>:<key>:<now>` convention, NOT the applier nonce) so the replay-guard/audit distinguish a heal from an adoption. <!-- tracked: CMT-1786 -->
- **Structural disjointness from `OwnershipReconciler`** — restrict to `active` records (never `released`/`transferring`); the atomic pin-repoint makes the reconciler converge *toward* the new target rather than fight it. (Note: cross-machine CAS is last-writer-wins at the git-ref level — the loser re-evaluates — NOT "synchronous torn-write-free"; the framing matters for reasoning about two engines.) <!-- tracked: CMT-1786 -->
- **Unify `StrandedTopicSentinel`'s detection with `OwnershipReconciler`** into one convergence engine, or prove their triggers disjoint. <!-- tracked: CMT-1786 -->

## Operator/agent remediation (v1 — what to do with the alert)

The detector converts a silent failure into a loud one; v1's remediation is still **manual but now reliably triggered**. When the alert fires, the safe recovery (the same one performed by hand during the live incident) is: confirm the owner genuinely can't serve (quota-walled / adapter-down) via `GET /pool/placement` + the machine view, then re-point the topic's durable ownership record (`.instar/ownership/local/<topicId>.json`) to a healthy server (owner→healthy machine, `ownershipEpoch`+1, applier-format nonce), clear any stale pin, and reload — verifying `pendingReplacement:false` after. **Preconditions:** the target must be a servable peer (the alert names whether one exists); never re-point onto another machine that also can't serve. **What NOT to do:** do not edit the record while the owner has a genuinely live, recovering session for that topic (v1 can't see per-topic remote liveness — that's exactly the gap the v2 auto-failover's prerequisite closes); when in doubt, wait a beat and re-confirm. Automating this remediation safely IS the v2 work below.

## Out of scope

- A live userbot harness to drive real-Telegram inbound end-to-end in regular UX regression tests (needs a Telegram user account; bots cannot see each other's messages). <!-- tracked: CMT-1786 -->

## Open questions

*(none)*
