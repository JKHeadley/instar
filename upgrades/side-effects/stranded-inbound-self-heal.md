# Side-Effects Review — StrandedTopicSentinel (online-but-unable-to-serve inbound detector)

**Version / slug:** `stranded-inbound-self-heal`
**Date:** `2026-06-24`
**Author:** Echo (autonomous)
**Second-pass reviewer:** not-required (Tier 2; dev-gated, pure-signal monitoring sentinel — no mutation, no fleet runtime path, no operator surface)

## Summary of the change

Adds a new dark-gated, pure-signal monitoring sentinel, `StrandedTopicSentinel`, that detects a Telegram/Slack topic whose durable ownership record names a machine that is **online-by-heartbeat but cannot serve** (quota-walled `quotaState.blocked`, or adapter-disconnected `servesChannels` omits the topic's channel) while a healthy machine holds the lease — so inbound for that topic is silently dead. It raises ONE aggregated `agent-health` attention item per (owner-machine, stranding-window) and a separate LOW "can't-assess" item if a heartbeat/schema regression blinds it. It **MUTATES NOTHING** (no ownership CAS, no pin write, no session kill); its sole output is an advisory attention item. The instinctive auto-failover was deferred to a tracked v2 (CMT-1786) because spec-convergence review proved it unsafe with today's primitives (no per-topic remote liveness, self-reported stale reachability, no hysteresis) — a wrong failover drops a live conversation, strictly worse than the bug.

Files added:
- `src/monitoring/strandedTopicDecision.ts` — the PURE, unit-testable decision core (`evaluateStrandedTopics`): fail-closed predicate (quota arm + best-effort adapter arm), dwell persistence, `strandedSince` reconciliation, `servablePeerExists`.
- `src/monitoring/StrandedTopicSentinel.ts` — the sentinel (tick loop, per-owner stranding-window discipline, attention emission, `guardStatus`).
- `tests/unit/stranded-topic-sentinel.test.ts` (29), `tests/integration/stranded-topic-guard-posture.test.ts` (4), `tests/e2e/stranded-topic-guards-lifecycle.test.ts` (2).
- `docs/specs/stranded-inbound-self-heal.md` (+ `.eli16.md` + convergence report), `upgrades/next/stranded-inbound-self-heal.md`.

Files modified:
- `src/core/types.ts` — `MonitoringConfig.strandedTopicSentinel?` config type.
- `src/config/ConfigDefaults.ts` — the `strandedTopicSentinel` defaults block (tickMs/dwellMs/freshnessBoundMs/clearAfterTicks); `enabled` OMITTED (dev-gate decides).
- `src/core/devGatedFeatures.ts` — `DEV_GATED_FEATURES` entry (pure-signal justification).
- `src/monitoring/guardManifest.ts` — `GUARD_MANIFEST` entry (`expectRuntime`, `expectedTickMs`).
- `src/core/SessionOwnershipRegistry.ts` — added `all()` (delegates to `store.all?.()`; reads empty for a store lacking it) so the registry the server holds can be scanned.
- `src/commands/server.ts` — wires the sentinel (late, after pool boot; `selfMachineId` via a lazy getter to avoid the #1190 boot-ordering null-capture; `raiseAttention` → `telegram.createAttentionItem`; GuardRegistry registration).
- `tests/unit/lint-dev-agent-dark-gate.test.ts` — hand-shifted the golden line-map keys +14 (my ConfigDefaults block added 14 lines, NO new `enabled:` literal).

## Decision-point inventory

- **Added**: the strand predicate (`evaluateStrandedTopics`) — a READ-ONLY verdict, not a gate. It decides whether to RAISE an attention item; it authorizes no mutation. Fail-closed on every uncertainty.
- **Added**: the lease-holder-sole-actor + single-machine early-no-op gates — decide WHETHER THIS MACHINE evaluates at all (so peers don't double-report). Observe-only.
- No agent-to-user or ownership mutation decision point is added. This is pure-signal monitoring.

## 1. Over-block

None — the change blocks nothing. It is observe-only. The only "false positive" risk is a spurious attention item, mitigated by: ≥2-rich-beat dwell persistence (kills transient blips), missing-field/stale-beat/underivable-scope ⇒ SKIP (fail-closed — an uncertainty can never manufacture a strand), and lease-holder-only emission (no duplicate items across machines). A spurious item is cheap and rides the existing `AttentionTopicGuard` flood ceiling.

## 2. Under-block

By design, v1 only DETECTS — it does not remediate; the operator/agent acts on the alert (manual remediation documented in the spec; auto-failover is the tracked v2). The adapter arm is best-effort: for Telegram the channel scope is shared adapter config so the adapter arm rarely fires (the quota arm carries the Telegram case — the actual incident); the adapter arm's real value is Slack per-workspace. A dead (offline) owner is intentionally NOT covered (that is the existing OwnershipReconciler Case C's job) — this sentinel covers only the online-but-unable gap.

## 3. Level-of-abstraction fit

Right layer: a `src/monitoring/` sentinel, mirroring the established pattern (ContextWedgeSentinel/ResumeQueue) — deps-injected, `lastTickAt` liveness, GuardRegistry registration, dark-gate via DEV_GATED_FEATURES. The pure decision is extracted to a separate module so it is unit-testable without tmux/HTTP.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). FULLY compliant — this is the textbook SIGNAL side. The sentinel holds NO authority: it raises an advisory attention item and writes nothing else (no CAS, no pin, no kill, no direct user message). The deliberate review-driven retreat from a mutating design to a pure detector is exactly the standard's prescription (the dangerous mutation is deferred until the primitives that make it safe exist).

## 5. Interactions

- **OwnershipReconciler (Case C):** disjoint by trigger — Case C covers offline-DEAD+pinned owners; this covers online-but-UNABLE owners (which Case C explicitly defers as `deferredNoEvidence`). No shared writer (this sentinel writes nothing).
- **AttentionTopicGuard:** the aggregated item rides the existing flood ceiling; NORMAL/LOW priority never bypasses it.
- **GuardRegistry / GET /guards:** registers so a silently-disabled instance is visible (the exact failure class this feature exists to surface).
- **Host spawn cap / event loop:** the tick is synchronous, LLM-free, acquires NO spawn-cap slot (asserted by test), and does NO synchronous peer probe — it reads the in-memory ownership cache + replicated heartbeat view only.

## 6. External surfaces

The only external-visible effect is an `agent-health` attention item (and a LOW can't-assess item) when a strand is detected — calm, aggregated, deduped, flood-ceiling-bounded, with signal-staleness disclosed in the text. No new HTTP route, no dashboard change, no message to a user channel.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard renderer/markup, approval page, or grant/revoke/secret-drop form. Its only operator-facing output is a plain-language attention item whose text leads with the situation ("inbound for topics X is going to <machine>, which can't serve them; <machine> can"), de-emphasizes identifiers, and discloses signal staleness.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The detection is per-machine observability over the REPLICATED heartbeat machine-pool view + the local in-memory ownership cache; it writes no durable state, so there is nothing to replicate or strand on a topic transfer. Exactly ONE machine reports per strand: the lease-holder is the sole actor (`syncStatus.holdsLease`), so peers stay observe-only and the user hears one voice. A single-machine agent is a strict no-op (`machines().length < 2` early return — nothing can be stranded on a peer that doesn't exist).

## 8. Rollback cost

Trivial and instant. The feature ships dark on the fleet (`monitoring.strandedTopicSentinel.enabled` omitted ⇒ resolves dark off a dev agent); flag-off is byte-identical to today (no sentinel constructed). On a dev agent, set `monitoring.strandedTopicSentinel.enabled: false` to force-dark. No durable state is written, so there is nothing to clean up on back-out.

## Conclusion

A safe, dark-gated, pure-signal detector that makes a real, proven, previously-invisible cross-machine inbound wedge loud within a bounded window — the deliberately-safe half of the fix, with the dangerous auto-failover deferred behind named, tracked prerequisites (CMT-1786). All three test tiers green; the design passed 3 spec-convergence rounds (6 internal reviewers + GPT-5.5 cross-model).

## Evidence pointers

- Spec + convergence report: `docs/specs/stranded-inbound-self-heal.md`, `docs/specs/reports/stranded-inbound-self-heal-convergence.md`.
- Live incident (the reproduction): 2026-06-24, 17 of 25 topics stranded on a quota-walled Mac Mini; inbound silently dead; surfaced only when the operator reported missing messages.
- Tests: unit (29) `tests/unit/stranded-topic-sentinel.test.ts`; integration (4) `tests/integration/stranded-topic-guard-posture.test.ts`; e2e (2) `tests/e2e/stranded-topic-guards-lifecycle.test.ts`.
