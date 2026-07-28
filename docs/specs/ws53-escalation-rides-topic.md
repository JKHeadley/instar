---
title: "WS5.3 — Escalation Rides the Topic (model-tier escalation follows a moved topic): Spec"
slug: "ws53-escalation-rides-topic"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "ws53-escalation-rides-topic.eli16.md"
status: "converged"
review-convergence: "2026-06-13T11:00:00.000Z"
review-iterations: 1
review-completed-at: "2026-06-13T11:00:00.000Z"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481, 2026-06-12/13: full session pre-approval for this initiative's decisions (exercised by Echo in the pre-approved autonomous run; operator may revoke). Build prompt: .instar/plans/ws53-escalation-rides-topic-build-prompt.md"
parent-spec: "MULTI-MACHINE-SEAMLESSNESS-SPEC.md (WS5.3); docs/specs/ws51-subscription-pool-scope.md (the merged sibling whose spec-frontmatter shape this mirrors); docs/specs/FABLE-MODEL-ESCALATION-SPEC.md (§5.3/§7/§8 — the escalation engine this rides)"
lessons-engaged:
  - "L15 Authorization: reach ≠ authority — a carried escalation hint is a TRIGGER carry, NEVER a tier grant. The destination ALWAYS re-decides through its OWN EscalationGovernor.admit() (every cost guard intact); a refusal leaves the resumed session on its default tier, exactly as a fresh escalation request would be refused. The hint can never short-circuit a guard."
  - "P4 Testing Integrity: three tiers + a NAMED safety-invariant test (the free-escalation-bypass lens proven as code — a refused guard yields default tier, never a bypass) + stale/forged-hint, dwell-dodge, and suppress/cap-honored lens tests."
  - "no-silent-fallbacks: every NEW catch (the hint store's load/persist, the transfer source-capture, the carrier hint-drive, the destination consume, the serve-handler peek) is tagged @silent-fallback-ok — the tolerant degrade is ALWAYS toward default tier (the cost-reducing, safe direction), audited where it matters, never swallowed into a wrong escalation."
  - "Phase C: the design holds for N machines — the hint rides the EXISTING authenticated topic-profile acquire pull (one verb, no LAN/2-peer assumption, no broadcast); re-admission happens under the DESTINATION's per-machine quota/budget/dwell guards, so an N-machine pool never accumulates free escalations (each move is re-priced locally); a suppress pin and a destination at its concurrent-escalation cap both correctly yield default tier (degrade-safe, never strands a wall)."
dependency-gate:
  blocks: "WS5.3 rides three already-merged surfaces: (a) the FABLE escalation engine (EscalationGovernor.admit() chokepoint + ModelSwapService.swap, FABLE-MODEL-ESCALATION-SPEC); (b) POST /pool/transfer (the deterministic topic move); (c) the TopicProfileTransferCarrier acquire-pull (TOPIC-PROFILE-SPEC §5.3 — the authenticated cross-machine carrier the hint piggybacks)."
  status: "SATISFIED — verified on 2026-06-13: EscalationGovernor.ts / ModelSwapService.ts / TopicProfileTransferCarrier.ts and POST /pool/transfer are all present on JKHeadley/main (off clean main 18c8b1f4)."
  enforcement: "The integration test exercises the transfer payload → destination re-admit path against a MOCK governor (allow + refuse), proving the hint drives an admit() call but never grants a tier. The unit tests cover the EscalationHintStore lifecycle + the serve-handler peek + the carrier landing-drive in isolation."
cross-model-review: "not-run (pre-approved autonomous build mirroring the merged WS5.1 spec-frontmatter shape exactly; the 4 adversarial lenses are exercised as named tests in tests/unit/escalation-hint-store.test.ts + tests/integration/escalation-rides-topic.test.ts)"
tracked-followups: "the placement tie-breaker (prefer the machine with more account-pool headroom on an otherwise-equal tie) remains DEFERRED <!-- tracked: CMT-1416 --> (inherited from WS5.1 — independent of this slice). WS5.2 (account follow-me) is a separate surface. A precise per-trigger hint label (carrying the ACTUAL originating trigger — build / autonomous / instar-dev — rather than the generic 'transfer' audit label) is DEFERRED <!-- tracked: CMT-1416 -->: the live trigger that escalated a session is not durably recorded per-session today, so recovering it would require new escalation-episode bookkeeping; the destination governor re-evaluates from real state regardless, so the precise label is audit-nicety, not load-bearing."
---

## 1. Problem

When a topic is running on the escalated (ultra `claude-fable-5`) tier because of a heavy-work trigger (`spec-converge` / `build` / `autonomous` / `instar-dev`), and that topic is MOVED to another machine via `POST /pool/transfer`, the escalation silently DROPS. Escalation leases are keyed on the spawn-generated **session-instance-id** (`EscalationGovernor.ts` header — "keyed on the session-instance id"), and the destination respawn mints a NEW instance id, so the resumed session starts on the DEFAULT tier mid-heavy-work. The topic profile already rides the move (TOPIC-PROFILE-SPEC §5.3 pull-at-acquire), but the *live escalation state* does not.

## 2. Design — carry the trigger, re-decide locally

**WS5.3 = carry the source topic's active escalation TRIGGER as an ephemeral hint across the transfer, and have the destination RE-ADMIT the resumed session through ITS OWN `EscalationGovernor` cost guards.** Dark/additive.

### 2.1 THE LOAD-BEARING SAFETY INVARIANT

The hint is a **trigger carry, NEVER a tier grant.** The destination MUST re-decide escalation through its own `EscalationGovernor.admit()` — every cost guard intact (quota headroom ≤90% utilization, per-account concurrent-escalation cap, hourly budget, daily ultra-token cap, TTL, dwell/hysteresis). A topic arriving "I was escalated" gives the destination a *reason to evaluate*, never a free pass. If the destination's guards refuse, the resumed session runs default tier — exactly as a fresh escalation request would be refused. This is the difference between "escalation rides the topic" (re-evaluated under local guards) and "escalation is smuggled across" (a bypass). The latter is a BLOCKER.

The invariant is structurally guaranteed, not promised: the destination re-admit is literally `ModelSwapService.swap(name, 'escalated')` — the SAME chokepoint a fresh escalation uses, which calls `governor.admitEscalation(...)` and returns `refused` on any guard. There is **no second admit path**; the hint only decides *whether to call swap('escalated')*, never the answer.

### 2.2 The slice

1. **Source (transfer sender leg, `routes.ts` `POST /pool/transfer`):** when the moving topic has a LIVE session on this machine running on an escalated model id (`escalatedModelIds(cfg).has(session.model)`), and the topic is not `escalationOverride:'suppress'`, file an ephemeral `EscalationHint` keyed by topic into the `EscalationHintStore`. A non-escalated / `suppress` / default-tier topic files NO hint (omit, not null-spam). Only a REAL move files (noop/already-there never does).
2. **Carrier (cross-machine, `TopicProfileTransferCarrier`):** the hint rides the EXISTING authenticated `topic-profile-pull` acquire pull — the serve handler PEEKS the source's hint (does not consume; a pull may be retried, the source hint expires by its own TTL, the destination re-admit is governor-gated so a duplicate is a harmless idempotent admit), and the destination's apply-landing — AFTER the mandatory ownership recheck — fires the re-admit driver for the now-owned topic.
3. **Destination (resumed-session spawn, `spawnSessionForTopic`):** for the live-swap topology where the topic was transferred TO this machine and the hint was filed on THIS machine (`target == self`, no cross-machine pull), the resumed-session spawn CONSUMES the local hint (consume-once + TTL-bounded) and fires the re-admit.
4. **Re-admit driver (`_driveEscalationReadmit`, server.ts):** resolves the topic's resumed session and calls `ModelSwapService.swap(name, 'escalated')` (serialized through the orchestrator's per-topic lock, same as the model-swap route). Admitted → swapped to the escalated tier; refused (any guard) → left default; `suppress` consult inside `swap()` → never escalated.
5. **Dark flag:** the whole carry+re-admit behind `models.tierEscalation.ridesTopic` (default false) AND the existing `tierEscalation.enabled`. With `enabled:false` the whole path is a strict no-op. Added to `DEFAULT_TIER_ESCALATION_CONFIG` (in `ModelTierEscalation.ts`, referenced by `ConfigDefaults.ts` via the const) — so the dark-gate line-map is UNCHANGED (`ridesTopic` is not an `enabled:` line, and it lives outside `ConfigDefaults.ts`).

### 2.3 Why the hint is ephemeral, not a profile field

A topic profile is sticky operator intent and must not gain a transient "was escalated" bit. The hint lives in its OWN file (`state/model-tier-escalation/rides-topic-hints.json`), is TTL-bounded (6h, mirroring `maxEscalationTtlMs` — a topic that moved long ago and was never resumed must not silently re-escalate days later), and is CONSUMED (the local arm) — never resolved into a pin. It rides the profile pull's TRANSPORT but is kept strictly separate from the durable profile DATA.

## 3. Phase C — robustness under arbitrary pool size & degraded conditions

- **N machines, no LAN assumption.** The hint rides `topic-profile-pull` (authenticated mesh, one verb, no broadcast, no 2-peer special case). No new verb, no new fan-out.
- **Re-priced per-machine.** Re-admission runs under the DESTINATION's quota/budget/dwell guards, which are per-machine — so an N-machine pool never accumulates free escalations; each move is re-evaluated locally. A topic bounced A→B→C is re-admitted (or refused) at each hop under that hop's guards.
- **Degrade-safe.** `suppress` and a destination at its concurrent-escalation cap (or with no quota headroom) both correctly yield default tier — the move degrades safely, never strands a wall, never smuggles escalation across. An unreachable previous owner / a peer that predates the verb / a corrupt hint file all degrade to default tier (the safe, cost-reducing direction), identical to WS5.3 being off.

## 4. Adversarial review (4 lenses — folded as named tests)

1. **Free-escalation bypass (THE blocker lens)** — the destination CANNOT end up escalated without its own `admit()` passing every guard. Test: a mock governor that REFUSES yields a `refused` swap result → default tier; the hint never short-circuits a guard. The re-admit has no path that escalates without `swap()` → `admit()`.
2. **Stale / forged hint** — a hint trigger that no longer applies, or a peer-supplied hint claiming a trigger the topic isn't under, must still pass the destination governor (which re-evaluates from REAL state — the trigger label is audit-only, never trusted as authority). Test: a hint with an arbitrary `trigger` label still routes through `admit()`; an expired hint is treated as absent (no re-admit).
3. **Dwell/hysteresis dodge** — a topic bounced machine-to-machine must NOT reset dwell to escalate-flap; the destination governor's hysteresis/TTL applies to the resumed session as to any escalation (the dwell backstop lives in `ModelSwapService` keyed on `session.id`, and the governor's lease TTL bounds it). Test: a re-admit within the dwell window is refused with `dwell`.
4. **suppress / cost-guard honored** — `escalationOverride:'suppress'` files NO hint at the source AND is re-consulted inside `swap()` at the destination (double guard); a destination at its concurrent-escalation cap yields `cost-guard:lease-capacity`. Test: both yield default tier.

## 5. Migration parity

- `src/core/ModelTierEscalation.ts` — `ridesTopic: false` added to `DEFAULT_TIER_ESCALATION_CONFIG` AND carried by `normalizeTierEscalationConfig` (the read-side add-missing normalizer every consumer goes through). Existing agents get the new field automatically on read — no `migrateConfig` change needed (the field is config-read through the normalizer, never a literal default written to disk).
- `src/scaffold/templates.ts` `generateClaudeMd()` — a "Escalation rides a moved topic (WS5.3)" bullet EXTENDS the existing Model-Tier Escalation block (new agents).
- `src/core/PostUpdateMigrator.ts` — the SAME bullet added to the section-install template AND an idempotent content-sniffed additive-bullet patcher (anchored on the existing "stop using the expensive model" proactive line) for existing agents that already carry the section. The section heading is UNCHANGED, so the feature-delivery-completeness `featureSections` entry + shadow markers stay green (the WS4.2 emptyState precedent: a sub-bullet into an already-tracked section needs no new entry).
