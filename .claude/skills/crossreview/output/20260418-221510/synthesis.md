# Cross-Model Synthesis — THREADLINE-COOLDOWN-QUEUE-DRAIN-SPEC.md v6 → v7

**Date:** 2026-04-18
**Reviewers:** GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast
**Outcome:** APPROVE WITH INTEGRATIONS (15 material findings incorporated into v7)

## Verdicts

| Model | Score | Verdict | Material findings |
|-------|-------|---------|-------------------|
| GPT 5.4 | 8/10 | CONDITIONAL | 6 critical |
| Gemini 3.1 Pro | 9/10 | APPROVE | 3 critical + 4 gaps |
| Grok 4.1 Fast | 9/10 | APPROVE | 0 critical, 5 polish |

## Consensus Findings (≥2 models flagged)

1. **Nonce binding gap.** GPT: confirm PATCH doesn't bind the requested config payload. Gemini: nonce Map needs LRU cap. → v7 adds triple binding (tokenHash + dryRunBodyHash + requestedPatchHash) + LRU at 256 entries.
2. **Timing-pad concerns.** Gemini: step-function at concurrency edge is too sharp. GPT: operational telemetry missing. → v7 returns HTTP 429 above cap (not silent drop) and surfaces padded/unpadded/429 counts in status endpoint.
3. **Monotonic time.** GPT: `Date.now()` used for intervals that should be clock-adjustment-immune. Gemini: StallTriageNurse coupling to dynamically-PATCHed cooldownMs. → v7 standardizes `performance.now()` / `process.hrtime.bigint()` for durations; `Date.now()` only for durable timestamps.
4. **Operational metrics.** GPT: breadcrumbs aren't metrics. Grok: no perf baselines. → v7 adds `§11 Operational Observability` with first-class metrics and CI-pinned baselines.

## Unique Catches

**GPT only:**
- **Weighted shuffle math broken.** `max(drainAttempts, ageMs)` compares 0–3 vs millions; age dominates, drainAttempts becomes no-op. All 4 internal Claude-family reviewers across 6 rounds missed this. → v7 replaces with Deficit Round Robin + age boost.
- **Queue lifecycle ownership ambiguous** across SpawnRequestManager / messageStore / DeliveryRetryManager. → v7 adds `§10 Message Lifecycle & Ownership` state machine.
- **Affinity invalidation missing for session-end / crash / transfer.** → v7 enumerates each lifecycle event.
- **Phase-1 regex classifier brittle across library upgrades.** → v7 constrains attribution to locally-generated typed errors only.

**Gemini only:**
- **Promise.all → Promise.allSettled** in drain loop (one failure aborts the batch). → v7 applied.
- **Hash versioning prefix** (`sha256-v1:`) for forward-compat. → v7 applied.
- **Payload byte-size cap** for envelopes. → v7 applied (256 KiB default).

**Grok only:**
- **Plaintext defaults unbenchmarked.** → v7 acknowledges in open question (requires historical trace review before ship).
- **Multi-machine failover quantification.** → v7 adds explicit tradeoff note (shared-state is explicitly non-goal; process-local invariant preserved).
- **DeliveryPhase prereq fallback.** → v7 notes interim single-mark loop if phase 1 prereq slips.
- **Audit log retention.** → v7 adds 10 k LRU + 24 h TTL.

## Divergences

**Affinity sharing across machines.** Grok recommended shared Redis/etcd for Phase-3 scale; conflicts with spec's intentional machine-local invariant (sync safety). Resolution: treat Grok's suggestion as scaling-direction commentary, not actionable — process-local affinity is a deliberate design choice.

## Model Strengths

- **GPT:** lifecycle/ownership analysis, detecting arithmetic mistakes in scheduling logic, operational-engineering mindset. Caught the weighted-shuffle defect no one else saw.
- **Gemini:** concrete pattern-level prescriptions (Promise.allSettled, hash versioning, byte-size caps). Pragmatic library-level catches.
- **Grok:** industry comparison (Kafka/Discord/SQS/Stripe analogues), scale-tier reasoning (10→500→5000 users), performance-baseline discipline.

## Actionable Recommendations (all integrated into v7)

1. ✅ DRR scheduling replaces weighted shuffle.
2. ✅ Promise.allSettled in drain loop.
3. ✅ Triple-bound nonce with LRU cap.
4. ✅ HTTP 429 + telemetry for plaintext flood.
5. ✅ Typed-errors-only Phase-1 classifier.
6. ✅ Message lifecycle state machine + ownership model.
7. ✅ Monotonic time for intervals.
8. ✅ Hash versioning prefix + payload byte-size cap.
9. ✅ Operational observability section with CI perf baselines.
10. ✅ Audit log retention.
11. ✅ Affinity invalidation lifecycle enumeration.

## Verdict

Spec v7 integrates all material cross-model findings. Internal convergence was reached at round 6 (v6). Cross-model review surfaced 15 additional findings, all addressed. Ready for user approval.
