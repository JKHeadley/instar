---
title: "Collaboration Re-Drive on Counterpart Silence"
slug: collaboration-redrive-on-counterpart-silence
status: approved
review-convergence: "2026-05-28T18:38:23Z"
review-iterations: 2
review-completed-at: "2026-05-28T18:38:23Z"
review-report: "docs/specs/reports/collaboration-redrive-convergence.md"
approved: true
approval-context: "Approved by Justin 2026-05-28 12:53 PDT (topic 12476) after 2-round convergence. Tunables locked at the recommended defaults: maxRedrives=2, silenceThresholdMs=45min, nudge=template-only, stand-alone initiative (not folded into CMT-493). The build itself was authorized in the same message ('Approve')."
eli16-overview: collaboration-redrive-on-counterpart-silence.eli16.md
owner: echo
created: 2026-05-28
roadmap-phase: 1
builds-on:
  - "THREADLINE-CONVERSATION-KEYSTONE-SPEC.md (WarrantsReplyGate loop-safety + ConversationStore continuity — SHIPPED + verified live)"
  - "CommitmentTracker verificationMethod:'threadline-reply' (relatedAgent/relatedThreadId/lastReplyAt anchor)"
  - "PromiseBeacon.classifyProgress 'stalled' verdict (stall DETECTION — currently user-facing only)"
  - "CompletionEvaluator (independent done-judgment)"
lessons-engaged:
  - "Structure > Willpower — the re-drive cap + terminal-stop are enforced in code, not by the worker remembering to stop"
  - "Signal vs Authority — stall is a signal; the re-drive is bounded and the operator holds escalation authority"
  - "The ack-loop / runaway-credit incidents (echo↔codey, $452 PromptGate) are the blast-radius this spec must not reopen"
---

# Collaboration Re-Drive on Counterpart Silence

> Start with the ELI16 companion. This spec fills exactly ONE verified gap and is deliberately small.

## Problem (verified, 2026-05-28)

The Threadline Conversation Keystone (shipped, approved 2026-05-24) made unfinished collaborations **continuable** and **loop-safe**:
- `WarrantsReplyGate` suppresses reflexive acks + enforces a novelty-gated turn budget (verified live: 32 suppressions / 44 inbounds on Echo's node).
- `ConversationStore` + resume-by-threadId means a reply resumes the SAME session with context.
- `CompletionEvaluator` independently judges "is the objective met?".

But every one of those is **inbound-reactive** (it acts only when the counterpart sends something) or **operator-facing** (`PromiseBeacon` "stalled" verdict only softens tone + doubles the heartbeat cadence to the user; `CollaborationSurfacer` is visibility-only and explicitly never "drives"). **Verified absence:** zero peer-directed send (`threadline_send` / `relayClient.send` / `sendAgentMessage`) exists in `src/monitoring` or `src/scheduler` on `main`.

**Consequence:** when the COUNTERPART goes silent on an unfinished objective — e.g. Dawn hasn't deployed `/api/instar/read` — nothing re-engages her. Echo's side just waits; the commitment sits non-terminal until TTL. That is the missing half of "continue collaborating robustly toward convergence." This is NOT covered by CMT-493 (whose Phase-2 scope is the inbound inbox/drain model + first-contact surface, keystone spec :316-321).

## Non-goals (explicitly)
- NOT rebuilding loop-safety, continuity, or done-detection — those are shipped. This spec only adds the proactive-re-drive arc on top.
- NOT a general "agents chat freely" channel. Re-drive is strictly tied to an OPEN, non-terminal objective with a hard cap.
- NOT the Dawn deploy/token operational step itself (that is the Phase-1 operational track, Dawn-gated).

---

# Part 2 — Technical design

## 2.1 Anchor: the objective already exists
A `CommitmentTracker` commitment with `verificationMethod: 'threadline-reply'` already records `relatedAgent`, `relatedThreadId`, `lastReplyAt`, and a non-terminal status. That IS "collaboration with peer Y on thread Z, awaiting progress." No new store. The re-drive engine reads these.

## 2.2 Detector: counterpart-silent stall (composed, not new)
A re-drive is eligible for a commitment iff ALL hold:
1. `verificationMethod === 'threadline-reply'` and status is non-terminal (not delivered/expired/withdrawn/violated).
2. **Counterpart-silent**: `now - lastReplyAt ≥ silenceThresholdMs` (default 45 min; for first-contact — no `lastReplyAt` — measured from `createdAt`). This reuses the same silence signal `PromiseBeacon.classifyProgress` already computes; the re-drive engine subscribes to the `stalled` verdict rather than recomputing it.
3. **Not converged**: `CompletionEvaluator.evaluate(objective, recentTranscript)` returns `met:false`. If the objective is already met we mark the commitment delivered and STOP (never re-drive a done collaboration). Errs to "not met" = safe (we'd just not auto-close; we still cap re-drives).
4. **Under the cap** (see 2.4).

## 2.3 Action: one bounded peer nudge
On an eligible stall, send EXACTLY ONE message to the counterpart via the existing primitive `threadlineRelayClient.sendPlaintext(peerFingerprint, nudgeText, relatedThreadId)` (the same call the inbound auto-ack path uses at server.ts ~7560).
- **Fingerprint resolution (v3, round-2 finding — `relatedAgentFingerprint` was a phantom field).** The commitment stores `relatedAgent` as a display NAME (`remoteAgentDisplayName ?? remoteAgent`, TopicLinkageHandler.ts:279), but `sendPlaintext` requires an `AgentFingerprint` (ThreadlineClient.ts:263). The auto-ack precedent gets its fingerprint from the live inbound envelope, which the sweep does NOT have. So the engine MUST resolve name→fingerprint via `known-agents.json` (the inverse of the fingerprint→name resolver at server.ts:7535-7547). **Failure mode**: if the name resolves to no fingerprint (or an ambiguous/multiple match), SKIP this commitment, do NOT send, do NOT increment `redriveCount`, and (after a few consecutive resolution failures) escalate "can't reach <peer> — unknown routing" to the operator. A send is never attempted against an unresolved/guessed address.
- `nudgeText` is the objective's open ask restated as a concrete question/next-step (a question, so the PEER's own WarrantsReplyGate treats it as warrants-reply, not a suppressible ack — convergence-driving by construction).
- Record the nudge durably on the commitment (`lastRedriveAt`, `redriveCount++`) via `mutate()`. Surface the nudge to the operator's silent Threadline hub via `CollaborationSurfacer` (visibility, not a buzz).

## 2.4 Loop-guard (the heart of "no infinite loop")
> **v2 — hardened after round-1 adversarial review (findings #1-#9).** The round-1 draft had a real hole: a nudge engineered to pass the peer's WarrantsReplyGate triggers a reply that calls `markReplyArrived()` → refreshes `lastReplyAt` → resets the silence clock, so a per-commitment-cap that only increments after silence could **never increment** under mutual drive — reopening the exact ack-loop blast radius. The bound below is therefore a **durable, reply-INDEPENDENT, monotonic lifetime counter**, not a silence-gated one.

- **Durable lifetime cap (the real bound)**: `redriveCount` is a monotonic counter on the **commitment record** (`commitments.json`, written via `commitmentTracker.mutate()` — NEVER PromiseBeacon hot-state). It increments on every nudge SENT and is **never reset or decremented by a counterpart reply**. After `redriveCount >= maxRedrives` (default 2) the commitment is permanently re-drive-ineligible. Comparison uses `(redriveCount ?? 0)` so a pre-migration row caps correctly.
  - **Implementation sites (must all be covered, finding #1/#2)**: add `redriveCount`/`lastRedriveAt` to (a) the `Commitment` interface, (b) `record()` input + the constructed object, (c) the `loadStore()` migration backfill that defaults `redriveCount: 0` on existing rows (alongside the existing `correctionCount`/`escalated` backfill). A regression test must reload the tracker from disk and assert the count survives.
- **A reply resets the silence CLOCK only**: `markReplyArrived()` updates `lastReplyAt` (so we don't nudge an actively-responding peer) but MUST NOT touch `redriveCount`. Stated normatively so the two concerns can't be conflated.
- **Per-peer aggregate cap (finding #3, mutual-drive across objectives)**: independent of per-commitment caps, at most `perPeerDailyCap` (default 3) nudges to any single peer fingerprint per rolling 24h, summed across ALL commitments. Blocks the "many objectives, each cap-2" amplification.
- **Engine-wide daily fuse (finding #8)**: `maxRedriveSendsPerDay` (default 10) total nudges across all peers/commitments, checked before every send — a blanket ceiling against a commitment-creation flood (e.g. drain re-spawn).
- **Per-tick fuse + clock-jump safety (finding #6)**: at most `maxRedrivesPerTick` (default 1) sends per sweep, so a laptop sleep/wake that elapses many silence windows at once cannot burst. `lastReplyAt`/`createdAt` are validated with `Number.isFinite(Date.parse(...))`; a NaN/future timestamp disqualifies the commitment (fail-safe = no nudge) rather than firing immediately.
- **Evaluator-exception still counts (finding #5)**: if `CompletionEvaluator` throws/❓, the engine does NOT nudge that tick (errs to not-done is "keep waiting", not "nudge"), and a nudge that IS sent always records `redriveCount++` even if a later step throws — an exception can never produce an uncounted send.
- **Spacing**: a given commitment is re-drive-eligible at most once per `silenceThresholdMs`; `lastRedriveAt` (also durable on the commitment) enforces it.
- **Escalate-then-stop**: when the per-commitment cap is hit with the objective still unmet, raise ONE Attention-queue item ("collaboration with <peer> stalled after N nudges — <objective>; your call") and go terminal-quiet. The operator holds authority; the engine never spins.
- **Novelty guard is a DECORATIVE tiebreaker, NOT a bound (finding #7)**: the durable cap above is the ONLY thing relied on for termination. As a secondary signal, if our last two nudges on a commitment are near-duplicates of EACH OTHER (token-set Jaccard ≥ `dedupeJaccard`), skip + escalate early. We do NOT compare our nudge to the peer's reply (wrong axis) and we do NOT rely on novelty for the loop bound (an LLM peer can reword to evade it).
- **Terminal-respect**: a delivered/withdrawn/expired/violated commitment is never re-driven (`threadIdIndex` excludes terminal states).
- **Trust + quiet hours + spend cap**: re-drive sends route through the same `LlmQueue`/quiet-hours/daily-spend gates as PromiseBeacon, and only to peers at/above `trustFloor`.

## 2.5 Placement + wiring
A small `CollaborationRedriveEngine` (`src/monitoring/`) constructed in `server.ts`. **It runs its OWN low-frequency sweep (finding #9)**, NOT the PromiseBeacon tick: the round-1 draft assumed it could piggyback the beacon, but the beacon only schedules `beaconEnabled && status==='pending'` commitments, and most `threadline-reply` commitments are NOT beacon-enabled (auto-enable only fires on time-promise text sniffing) — so the beacon would never tick them. The engine instead sweeps `commitmentTracker.getActive().filter(c => c.verificationMethod === 'threadline-reply' && !terminal(c))` on its own interval (default 5 min, ≪ silenceThreshold so spacing/per-tick fuses dominate). Deps injected: `CommitmentTracker`, `CompletionEvaluator`, `threadlineRelayClient`, `CollaborationSurfacer`, attention queue, config, an injectable `now()` (testability + clock-jump handling). Ships **OFF by default** (`monitoring.collaborationRedrive.enabled: false`) — armed per the graduated-rollout standard; dogfood on Echo first. Wiring-integrity test: the engine is actually constructed + swept, not dead code, and is a no-op when disabled.

## 2.6 Config (`.instar/config.json` → `monitoring.collaborationRedrive`)
`enabled` (false), `sweepIntervalMs` (300_000 = 5m), `silenceThresholdMs` (2_700_000 = 45m), `maxRedrives` (2, per-commitment lifetime), `perPeerDailyCap` (3, per-peer rolling-24h), `maxRedriveSendsPerDay` (10, engine-wide), `maxRedrivesPerTick` (1), `trustFloor` ('verified'), `dedupeJaccard` (0.7, tiebreaker only). Migration: `migrateConfig()` adds the missing block with defaults (Migration Parity); `loadStore()` backfills `redriveCount: 0` / `lastRedriveAt: undefined` on existing commitment rows (same pattern as the existing `correctionCount`/`escalated` backfill, CommitmentTracker.ts:~1269).

## 2.7 Testing (all three tiers — non-negotiable per the Testing Integrity standard)
- **Tier 1 (unit)** — the eligibility predicate, BOTH sides of every boundary: eligible vs each disqualifier (terminal status, objective-met, cap reached, per-peer cap reached, engine-daily fuse hit, per-tick fuse, NaN/future timestamp, name-unresolvable, evaluator-throw). The cap logic: assert `redriveCount` increments on send and that a simulated `markReplyArrived()` does NOT reset it.
- **Tier 2 (integration)** — engine sweep over a real CommitmentTracker (real store on disk): create a threadline-reply commitment, advance the clock past silence, assert exactly one nudge issued via a stubbed relay client, assert `redriveCount`/`lastRedriveAt` persisted, assert cap → escalation item created.
- **Tier 3 (E2E / "feature is alive")** — there are NO new HTTP routes, so the standard's 200-not-503 flagship test is N/A and the spec says so explicitly; the equivalent is a production-init harness (mirroring server.ts construction) proving the engine is constructed, swept, and a no-op when `enabled:false`, with a real (stubbed-transport) end-to-end nudge when enabled.
- **Wiring-integrity** — the engine's injected deps (CommitmentTracker, CompletionEvaluator, relay client, surfacer, attention queue) are non-null real implementations, not no-ops.
- **Restart-survival** — reload the tracker from disk mid-scenario; assert `redriveCount` survives (the durable-cap guarantee).
- **Reply-independence** — the load-bearing regression test: nudge → simulate a counterpart reply (markReplyArrived) → advance clock → assert the SECOND nudge still counts toward the cap and the cap still trips. This is the test that proves the round-1 mutual-drive hole stays closed.

## 2.8 Agent Awareness (shipping obligation)
Per the Agent Awareness standard, add a short note to the CLAUDE.md template (`src/scaffold/templates.ts → generateClaudeMd()`) + a `migrateClaudeMd()` content-sniff so existing agents learn: (a) the agent will, when enabled, send up to N bounded peer nudges on a silent collaborator's unfinished objective, and (b) after the cap it escalates to the Attention queue and stops — so the operator knows where a stalled collaboration surfaces and that the agent won't spin.

---

# Part 3 — Seven-dimension side-effects review

1. **Over/under-drive** — Over: nudging a peer who is legitimately working → mitigated by `CompletionEvaluator` not-met gate + silence threshold + hard cap. Under: never nudging → that is today's gap (the thing we fix). The cap biases toward UNDER (stop + escalate) — the safe direction.
2. **Level-of-abstraction** — Detection composes the existing stall signal; action uses the existing relay send; escalation uses the existing attention queue. No new transport, no new store.
3. **Signal vs Authority** — Stall + not-met are SIGNALS; the bounded nudge is a limited action; the OPERATOR holds terminal authority via the escalation item. The engine cannot decide to keep going past the cap.
4. **Interactions** — Touches CommitmentTracker (adds `redriveCount`/`lastRedriveAt`), PromiseBeacon (subscribes to its stall verdict), relay client (outbound), attention queue. The fragile point is the peer-send loop risk — bounded by §2.4.
5. **Rollback** — Ships OFF; `enabled:false` fully disables. New commitment fields are additive/optional; the only "migration" is an idempotent backfill defaulting `redriveCount: 0` on existing rows (no destructive transform, no data reshaped). Reversible by config.
6. **Data integrity** — Only additive optional fields on the commitment record; no mutation of existing lifecycle semantics. A re-drive never changes commitment STATUS (only delivered-on-convergence or operator action does).
7. **Failure modes** — (a) Runaway nudges (incl. MUTUAL re-drive where a reply refreshes the silence clock) → bounded by the **durable, reply-independent, monotonic per-commitment cap** + per-peer 24h cap + engine-wide daily fuse + per-tick fuse. The cap is the ONLY termination guarantee; novelty is decorative. (b) Restart amnesia → cap/spacing persisted to `commitments.json` via `mutate()`, not hot-state; reload-survival test required. (c) Nudging after done → CompletionEvaluator not-met gate + terminal-respect; evaluator-throw never produces an uncounted send. (d) Clock jump / sleep-wake burst → per-tick fuse + `Number.isFinite` timestamp validation + injectable `now()`. (e) Peer ack-storm in response → the peer's own WarrantsReplyGate suppresses inbound; our durable cap stops our side regardless of replies. (f) Wrong-peer send → trust floor + `relatedAgent` fingerprint from the authenticated commitment. (g) Re-drive while operator is mid-conversation → surfaces silently to the hub, never the active parent topic.

---

# Part 4 — Open questions for /spec-converge + Justin

1. **Cap value** — is `maxRedrives: 2` right, or 1 (single nudge then escalate)? Lower = safer, fewer chances to converge. (Justin, low-stakes — default 2, easily tuned.)
2. **Silence threshold** — 45 min reasonable for agent collaborations, or should it scale with the objective's stated cadence if one exists?
3. **Nudge authorship** — template-only (deterministic, cheap) vs a one-line LLM restatement of the open ask (better convergence content, small spend). Proposed: template with the objective text interpolated; LLM only if a `purpose` string is absent.
4. **Relationship to CMT-493** — keep this as its own small initiative (recommended — it's orthogonal to the inbound inbox/drain model), or fold it into the CMT-493 Phase-2 umbrella? It builds on the keystone either way.
