# Convergence Report — Autonomous Throughput Floor

**Spec:** `docs/specs/autonomous-throughput-floor.md`
**Author:** echo · **Drive:** Apprenticeship Drive 8 · **Date:** 2026-07-20
**Founding incident / class-review:** `.instar/drive7/autonomous-throughput-floor-classreview.md` (ACT-847)

## Purpose
Ship the manager-side forcing function (mentee-output flatline → mandatory active check + re-task, deterministic-hold-gated, Capacity-Safety-registered) as real Instar structure — the direct answer to the operator's "robustness for autonomous work + throughput" ask. This report records the multi-reviewer convergence per the `/spec-converge` discipline.

## Iteration Summary

| Round | Reviewers run | Standards-Conformance Gate | Cross-model | Material findings | Outcome |
|---|---|---|---|---|---|
| 1 | 6-lens internal, run as 3 parallel subagents (security+adversarial; integration+multi-machine+scalability; lessons-aware+foundation-audit+decision-completeness) | **unavailable** — the `POST /spec/conformance-check` route rejects an isolated-worktree spec (`"specPath escapes specsDir"`), the known cross-engine tooling defect (Drive-7). Signal-only, does not block. | codex-cli:gpt-5.5 (crossFamily) = MINOR ISSUES; gemini-cli **unavailable** (shim present, no runnable executable — known door defect, recorded honestly) | ~20 MATERIAL | NOT converged → round-2 rewrite |
| 2 | Convergence verifier (full round-1 checklist re-verification) + cross-model re-run | unavailable (same defect) | codex-cli:gpt-5.5 = MINOR ISSUES (1: liveness≠output — applied) | all 20 round-1 ADDRESSED; verifier surfaced 1 must-fix (NEW-1) + 2 tightenings (NEW-2/3) | round-2.1 patch → CONVERGED |

**Standards-Conformance Gate honesty:** the gate was RUN each round and returned `unavailable` for the same reason both rounds (isolated-worktree specsDir rejection). This is a recorded tooling limitation, not a skipped step; it never blocks convergence (signal-only). The defect itself is in Codey's active cross-engine/tooling lane this drive.

## Round-1 material findings and round-2 resolutions

Full round-1 finding text: `.instar/drive8/throughput-floor-round1-findings.md`. Resolutions:

### Security / Adversarial (8 material)
- **S-M1** mentee-read auth/fingerprint/receiver-rate-limit → §4.1 (fingerprint-bound, Know-Your-Principal, verified-pairing for non-fleet) + §8 (per-mentee receiver-side inbound-dispatch limit) + §10a (the rich probe's required contract).
- **S-M2** secret egress → §4.3 (v1 signal is structural — no raw output crosses; §10 probe scrubs at source; audit rows metadata-only).
- **S-M3** classifier injection / suppression-is-dangerous → §4.1 (structural-primary; neutralized untrusted-data envelope; LLM may only lower confidence, never assert all-clear on prose).
- **S-M4** ACK-proves-delivery-not-effect → §5 (EFFECT-ACK: effective only on a follow-on deliverable delta; send-ok+no-delta = FAILED, counts to breaker + grows backoff).
- **S-M5** per-run/per-machine breaker keying → §8 per-MENTEE aggregate breaker (across runs+machines) + §7 pool-shared governor resource.
- **S-M6** micro-delta / manager's-own-message reset → §3.1 (only a monotonic deliverable advance is a meaningful delta; lane-flip and inbound-ACK excluded; manager-authored messages excluded).
- **S-M7** Know-Your-Principal on auto-dispatch + operator-parked override → §3.2/§5 (provenance-tagged floor-generated; operator absolute-HOLD deny-wins veto, classification-independent).
- **S-M8** no spend ceiling → §8 spend gate (fail-closed under budget/quota pressure; auto-refeed skips a quota-blocked mentee).

### Integration / Multi-Machine / Scalability (5 material)
- **I-M1** hardware-bound mislabel (actuation vs state) → §7 decomposed (actuation machine-local; breaker/counter state rides the run).
- **I-M2** move/death resets P19 brake → §7 (state carried on transfer, governor `resource:'pool-shared'`, restart-survival corollary) + §8.
- **I-M3** no ownership/lease/mid-move gate → §3.2 (every rung gates on own+lease+not-mid-move, reconciler criteria 4–5).
- **I-M4** "cheap mesh probe" overstates existing infra → §2/§4.1 grounded on real `peers/health` ack-liveness + git-SHA sweep; rich probe reclassified as new work in §10a; §2 "no new external engine" claim corrected (core only).
- **I-M5** SelfActionGovernor ride hand-waved / fail-open default → §8 explicit policy (`amplifying` / `closed-queue` / `pool-shared`; floor breaker = `delegatedGiveUp`).
- Minors (DEV_GATED entry, migration-parity list, hot-path cached sweep + staggered fan-out, machinery-overlap note, branch source, two-brake relationship) → §8/§9.

### Lessons / Foundation / Decision (7 material)
- **L-M1** Capacity Safety obligations undischarged (lint would refuse the emit) → §8 (registry registration + convergence-ratchet test + restart-survival + governor policy).
- **L-M2 [sharpest]** legitimate-hold LLM-delegated → §3.2 rung 2 + Decision-points: the hold permission is now a **deterministic INVARIANT** (open-approval-gate record + live-reconciled lane-saturation count); the classifier may never authorize a hold.
- **L-M3** "Delegation-Default" is a phantom standard → §6.2 PROPOSES it as a NEW constitutional standard (not "sharpen").
- **L-M4** load-bearing signal unbuilt / fallback too fragile / lane-record structure absent → §4.1 v1 on real infra; §10a/10b name the two genuinely-new-foundation pieces as scoped follow-ons with required contracts (honest scope, not deferral).
- **L-M5** new standard is rule-only, no teeth → §6.1 names enforcement (spec-converge lens + a B15-style behavioral detector for the passive-hold rationalization).
- **L-M6** machine-local breaker + transfer = cross-machine reset + missing marker → §7 (state rides the run; the `machine-local-justification` marker is in the lint-parseable form).
- **L-M7** A2A re-dispatch authority unstated → §0/§5 (authority = operator-preauthorized run; mentee-side gates independently re-evaluate).
- Minors (JWF flip criterion, decision-provenance enrollment, Agent Awareness + Migration Parity, concurrency-ceiling source + mentee-quota, "signal not authority" reframe, single-run-completable, twin-of-Conservative-Outbound) → §6/§9.

### Cross-model (codex-cli:gpt-5.5)
- Round 1 + round 2: MINOR ISSUES. The round-2 point (inbound-ACK is liveness, not output — must not reset the flatline window) was APPLIED to §3.1/§4.1 (liveness distinguishes STALLED-vs-alive only; only a monotonic deliverable advance resets the window).

## Scope decision (recorded for the operator)
v1 ships the CORE forcing function on EXISTING foundation (`peers/health` + git-SHA sweep + deterministic hold-invariant + Capacity-Safety-registered controller + breaker-rides-the-run). §10a (rich two-ended mentee-output probe) and §10b (persisted lane-backlog auto-refeed) are named follow-ons requiring genuinely-new mentee-side foundation — scoped OUT of v1 honestly (each needs a second agent's surface / a new persisted structure), NOT deferred-by-avoidance. The verifier was asked specifically whether this scoping leaves a USEFUL v1 or a hollow one.

## Convergence verdict
**CONVERGED after round 2 + round-2.1** (`review-convergence: 2026-07-20T19:10:55Z`, `review-iterations: 2`). The round-2 verifier confirmed all 20 round-1 material findings ADDRESSED (every code-grounded claim spot-checked real: peers/health shape, SelfActionGovernor enum values, reconciler criteria) and traced the sharpest fix (L-M2 deterministic hold-invariant) to have NO LLM-authorization leak. It surfaced one BLOCKING must-fix and two tightenings, all now closed in round-2.1:
- **NEW-1 (must-fix, empirically verified BOTH ways):** the numbered `## 7. Multi-machine posture` heading defeated `scripts/lint-machine-local-justification.js`'s `POSTURE_SECTION_RE`, so the marker floor passed BY BLINDNESS (the exact "green audit trail without the guarantee" failure). FIX: un-numbered the heading + made the marker a standalone `machine-local-justification: hardware-bound-resource` line. VERIFIED with a negative test — an invalid key on the un-numbered heading now throws 2 lint findings (key-taxonomy + in-section location checks both live), vs the numbered heading which misses the location check. The check is genuinely active, not passing by blindness.
- **NEW-2:** inbound-ACK re-softened the deliverable-only flatline floor (a chatty-stalled mentee could reset the window → suppression). FIX: inbound-ACK is now LIVENESS-ONLY (separates alive from STALLED/UNREACHABLE); only a monotonic DELIVERABLE advance = PRODUCING/resets the window (§3.1/§3.2/§4.1 made consistent).
- **NEW-3 + framing:** the §3.2 IDLE rung dangled a "re-dispatch the next known priority" clause with no v1 source (the lane-backlog is §10b). FIX: v1 IDLE → SURFACE-only; the "v1 prevents the Drive-7 failure" claim softened to "prevents the SILENT-idle failure; full autonomous throughput-restoration for IDLE needs §10b" (§3.2 IDLE rung + §10 framing).

The `review-convergence` tag was written by `write-convergence-tag.mjs` (which re-validated the Decision-points classification + posture section + Open-questions=none), never hand-asserted.

## Operator approval
Pending. The ELI16 will be published + the link sent to the operator (topic 29723). `approved: true` is set ONLY by the operator's verified decision — the agent never self-approves. One design commitment worth an explicit operator nod: the §6 proposal to ADD "Delegation-Default" as a new constitutional standard (currently only a memory directive).
