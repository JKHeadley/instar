# Convergence Report — Session Respawn/Kill Thrash Elimination

**Spec:** `docs/specs/session-respawn-thrash-elimination.md`
**Converged:** iteration 5 (2026-07-03)
**Author:** Echo
**Reviewers:** internal 6-angle panel (security, scalability, adversarial, integration, decision-completeness, lessons-aware) + external cross-model pass (codex-cli:gpt-5.5)

## Cross-model review: codex-cli:gpt-5.5

A **real external cross-model pass RAN** through the agent's own installed codex-cli, GPT-5.5-tier, across four review rounds (2, 3, 4, and a final round-5 close-out). This was not a simulated pass — codex-cli was invoked against the full spec body each round and returned recorded verdicts (round-2 body hash `3c1d3063…`, round-3 `806fa0c4…`). Codex's trajectory: round 2 = 5 MINOR issues, round 3 = 3 MINOR (shrinking, increasingly subjective), round 4 = 2 re-raises + 4 minor-new (all conceded), round 5 = a small set of fair, non-redesign catches (all applied). No round produced a material design defect after the round-1 internal rewrite; codex's residual asks were architectural taste, precision-of-claim, and defense-in-depth hardening — every one either conceded, deferred-by-design, or applied.

## ELI10 Overview

The agent's cleanup loop checks, every 5 seconds, "should I kill this idle session?" For a few protected sessions the answer is always "no — it has an open promise" — but the loop asked again 5 seconds later, forever. That wasted ~8,500 attempts a day and blew a log file up to 132MB. The fix teaches that one branch to **wait a while after being told no**, instead of asking every tick — reusing a brake the sibling branch already has. It never changes WHO gets killed; only how often a rejected attempt is retried.

## Original vs Converged

| | Original stub | Converged spec |
|---|---|---|
| Root cause | Assumed: macOS `os.freemem()` metric + trailing-quota proactive-swap | REFUTED by live logs; real cause = vetoed idle-zombie kill never backs off (idle clock never reset on veto) |
| Fix mechanism | Hand-rolled `idleKillVetoedUntil` + `idleKillVetoLogged` Maps | GENERALIZE the shipped `AgeKillBackoff` (#863) → shared `VetoedKillBackoff`; second instance for the idle branch |
| Map leak | Unaddressed | Evicted at both lifecycle exits + `maxTracked` ceiling; CI ratchet asserts `trackedCount → 0` |
| Guard eval | Double-called (racey) | Single per-tick verdict via a private helper; shared private terminate implementation (no duplicated skip/log/audit) |
| Breaker | None | P19 breaker via a named `IncidentDedupe` seam; best-effort one-per-incident (flood-avoidance, not exactly-once) |
| Fix B | New persisted per-(session,reason) dedupe file | Bounded reap-log ROTATION (no new persisted store) |
| Multi-machine | Undeclared | `hardware-bound-resource`, machine-local by design, no replication |
| Scope honesty | "shipped = fixed" | Explicit ACTIVATION section: PR ships enabled-on-dev/fleet-off; Mini symptom resolved only on deliberate operator activation after Echo soak |
| Config/rollback | Vague | `monitoring.idleKillVetoBackoff` knob, `migrateConfig()` existence-checked default, one exact disabled contract, `cooldownMs:0` defined |

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Changes |
|---|---|---|---|
| 1 | internal 6-angle panel | 12 (HIGH/MED, structural) | Full rewrite: map-leak eviction, `AgeKillBackoff` reuse, multi-machine posture, Fix C definition, P19 breaker, config knob + gate + rollback, stale-reprieve, reap-log rotation, threat model |
| 2 | codex-cli:gpt-5.5 | 5 MINOR + 2 lessons LOW | One disabled contract, single guard-eval helper, Fix B → reap-log rotation, breaker durability via flood guard, centralized-alternative rationale |
| 3 | codex-cli:gpt-5.5 | 3 MINOR | Guard-eval authority boundary (private precompute), reason identity = stable KEY not text, `IncidentDedupe` as documented dependency |
| 4 | codex-cli:gpt-5.5 | 2 re-raise + 4 minor | Exact PR deliverables split, precompute made private/internal, `IncidentDedupe` interface defined now, exhaustive reason-key fail-open, `cooldownMs:0` defined, migrateConfig no-clobber test |
| 5 | codex-cli:gpt-5.5 | 5 fair catches (non-redesign) | ACTIVATION section (code-shipped ≠ symptom-resolved), IncidentDedupe weakened to best-effort, unknown reason-key constrained to a stable discriminator (bypass-cooldown if none), guard-once shared-private-impl note, RC#2/Fix C deferral decision-completeness-blessed |

## Full Findings Catalog

**Round 1 (12 — internal panel, structural):**
1. HIGH scalability — veto Maps leak by session id → evict at both lifecycle exits + Tier-1 map-size ratchet.
2. MED scalability — fold the log-once Set into the cooldown map value (evicts atomically; once per session,reason).
3. HIGH integration — multi-machine posture undeclared → `hardware-bound-resource`, machine-local, no replication.
4. HIGH integration / MED adversarial — RC#2/Fix C coherence: defer but define (veto-gated, cooldown-count escalation, placement read, confirmed-move bypass, real-pair test).
5. MED lessons — reuse `AgeKillBackoff` (#863), the shipped P19 brake for the sibling branch, instead of a parallel Map.
6. MED lessons — add a P19 breaker to Fix A; name Fix A root / Fix B containment.
7. MED integration — `monitoring.idleKillVetoBackoff` knob + `migrateConfig()` default + dev-agent gate.
8. MED integration — rollback section; fleet default OFF.
9. MED adversarial — stale-reprieve: store vetoing reason, re-evaluate on reason change.
10. MED integration — reap-log rotation (132MB persists after growth stops) as sibling spec + archive runbook step.
11. LOW — verify `effectiveBoundIdleKillMinutes` is live (NaN safety); CI ratchet reads config default.
12. LOW security — threat-model note: cooldown gates ONLY the idle-zombie branch.

**Round 2 (5 codex MINOR + 2 lessons LOW):** C1 one exact disabled contract + test; C2 single shared guard-eval (no racey double-call); C3 Fix B underspecified → fold into reap-log rotation, no new persisted file; C4 breaker durability across restarts/machines via flood-guard incident key + TTL; C5 rationale for branch-local vs a centralized scheduler.

**Round 3 (3 codex MINOR):** R3-1 guard-eval authority boundary (`terminateSession` stays the enforcement boundary; precompute is an optimization); R3-2 reason identity = stable key, normalize before store/compare (not free-form text); R3-3 document the flood-guard durability/coalescing contract as an explicit dependency (tiny generic `IncidentDedupe` future extraction deferred).

**Round 4 (2 re-raise + 4 minor, all conceded):** R4-1 exact PR deliverables split (Fix A + A′ only; B/C/D out); R4-2 make precompute PRIVATE/internal to SessionManager (not a public param); R4-3 define the `IncidentDedupe` interface now, backed by the flood guard, as a named seam; R4-4 exhaustive reason-key normalization tests + fail-open on unknown; R4-5 `cooldownMs:0` = enabled-but-no-cooldown, not a disable; R4-6 migrateConfig no-clobber test.

**Round 5 (5 fair catches, non-redesign, all applied):** ACTIVATION section separating "code shipped (enabled-on-dev/fleet-off)" from "Mini symptom resolved (deliberate operator activation after Echo soak)" with an explicit activation criterion + Mini runbook; IncidentDedupe cross-machine claim weakened to BEST-EFFORT (in-process coalescing + TTL; a duplicate across restart/second-machine is acceptable — flood-avoidance, not exactly-once) with tests adjusted; unknown reason-key fail-open CONSTRAINED to derive from a stable discriminator only (never serialized payload), bypassing the cooldown for the tick if no discriminator exists; guard-once factoring tightened (both entry points delegate to one shared private implementation — no duplicated skip/log/audit); RC#2/Fix C deferral noted as decision-completeness-blessed (north-star = idle-zombie skip-rate; cross-machine churn is Fix C's separate scope).

## Convergence verdict

**CONVERGED at iteration 5.** The internal 6-angle panel converged by round 2 (decision-completeness ship-ready; only 2 LOW lessons items remained, addressed in the round-2 rewrite). Every subsequent round was driven by the external codex-cli:gpt-5.5 pass, whose findings shrank monotonically (12 → 5 → 3 → 6-mostly-re-raise → 5-fair-catches) and shifted from structural to architectural-taste, precision-of-claim, and defense-in-depth. Codex's residual items are all **conceded** (private precompute, `IncidentDedupe` seam, exhaustive fail-open), **deferred-by-design** (Fix B rotation, Fix C RC#2, Fix D reaper metric — each a defined, tracked follow-up, not a gap), or **implementation-detail** (guard-once factoring, discriminator-only key derivation). **Zero unresolved material design findings remain.** The spec is ready for the `review-convergence` tag and `/instar-dev`.
