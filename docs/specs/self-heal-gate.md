---
title: "SelfHealGate — a thin declarative self-heal façade over the existing SelfActionGovernor + FailureEpisodeLatch substrate"
slug: "self-heal-gate"
author: "echo"
status: draft
approved: false
parent-principle: "Self-Heal Before Notify (with No Unbounded Self-Action / Capacity Safety) — the standard mandates the FIRST runtime application extract a reusable SelfHealGate that is a THIN declaration+assertion layer over Instar's EXISTING in-process P19 breaker primitives, NEVER a new engine. The feedback-drain build (2026-07-20) was that first application and exposed that the reusable primitive was never built, forcing a bespoke owns-everything controller — this spec builds the façade so every future self-heal path declares ONE bounded contract instead of hand-rolling an engine under merge pressure."
lessons-engaged:
  - "Reuse Before Rebuild — the capability audit (§1) found ~70% of the contract already realized by SelfActionGovernor + FailureEpisodeLatch + the retry/backoff/dedupe helpers; the façade COMPOSES them and never re-implements. An explicit REJECT of a parallel engine is in §3.4."
  - "Foundation grep evidence — §1 carries the capability-LEVEL audit (.instar/drive8/selfhealgate-foundation-audit.md) enumerating ALL existing breaker/self-heal implementations, not just one anchor component. This is the exact step the WITHDRAWN context-wedge spec skipped (it grounded against one file and would have duplicated a live engine)."
  - "No Unbounded Loops / Capacity Safety — the façade REGISTERS through the EXISTING SelfActionGovernor (mandatory + lint-enforced via scripts/lint-no-unregistered-self-action.js), so a declared SelfHealGate is a bounded self-action by construction; it adds no new unbounded loop."
  - "Structure > Willpower — a declared SelfHealGate contract plus the existing self-action lint turns 'did you bound + register this self-heal?' into a registration/compile check, not a reviewer's memory. The feedback-drain incident happened because the bound was a prose mandate, not a primitive."
  - "Distrust Temporary Success — the wall-clock episode give-up (§3.3 net-new-2) means a self-heal that keeps 'succeeding' then re-breaking flaps into escalation on a wall-clock budget, not just a count window."
single-run-completable: true
---

# SelfHealGate

## 0. Why this spec exists
The Self-Heal-Before-Notify standard states: *"The FIRST runtime application MUST extract the pattern into a reusable `SelfHealGate` — a THIN declaration+assertion layer over Instar's EXISTING in-process P19 breaker primitives (the SelfActionGovernor and the breakers already threaded through the monitors), NEVER a new external workflow engine."* The feedback-drain build was the first real application. It exposed that **no reusable SelfHealGate exists**, so the feedback self-heal hand-rolled a bespoke controller independently owning episode persistence, retries, backoff, wall-clock limits, dedupe, breaker state, flapping history, audit, attention, severity, and remediation sequencing — exactly the "grow a bespoke engine" anti-pattern the standard forbids. Rather than grow that engine inline in a merge-critical PR (rejected 2026-07-20; foundation belongs in spec-converge), this spec builds the reusable façade as its own bounded increment.

**Corrected class-review framing (meta-rule — this replaces the first-pass "the standard promised a primitive that was never built"):** the audit (§1) shows the reusable SUBSTRATE already exists and registration is already mandatory + lint-enforced — the gap is a **thin declarative façade + 3 bounding pieces**, NOT a missing foundation. So the standards-class fix is: the Self-Heal-Before-Notify standard should NAME the existing substrate (`SelfActionGovernor` + `FailureEpisodeLatch`) the façade must compose, so the next first-application composes instead of re-implementing. (Dev-process class fix: a spec touching a self-heal path should require the capability-grep foundation-evidence line — the same lesson the withdrawn context-wedge spec earned.)

## 1. Verified foundation (capability-grep evidence)
Full audit: `.instar/drive8/selfhealgate-foundation-audit.md` (grep of instar v1.3.889 `src/`). Load-bearing findings:
- **No reusable `SelfHealGate` exists** (`class SelfHealGate` / generic factory absent) — the façade is net-new.
- **`SelfActionGovernorCore` / `governor.for(controllerId)`** (`monitoring/selfaction/governor.ts:287,1704`; mint anchor `monitoring/selfaction/anchor.ts:97`) is the MANDATORY registration substrate: per-target + census ceilings, rate bucket, **P19 `BreakerPolicy{failThreshold,cooldownMs,flapWindowMs}`**, coalescing queue, dedupe (`DerivedTarget.key`), scrubbed audit (`TransitionRow`), restart-surviving snapshot (`flushSnapshot`/`rehydrate`), severity/notify seam. Enforced by `scripts/lint-no-unregistered-self-action.js` + the `SELF_ACTION_CONTROLLERS` registry + `tests/unit/self-action-convergence.test.ts`.
- **`FailureEpisodeLatch`** (`core/FailureEpisodeLatch.ts:39`) is the reusable episode primitive: one-signal-per-episode, state-change audit, and a **`signalAfterMs` notification threshold** (in-memory; measures `failingForMs` but has no wall-clock give-up).
- ~70% of the target contract already exists; net-new is the façade + 3 bounding/persistence pieces (§3.3).

## 2. The contract a SelfHealGate declares
A caller (any monitor/sentinel/engine with a recoverable degradation) declares ONE `SelfHealSpec`:
- `id` (controller id — registered through the governor)
- `remediation(ctx) => Promise<HealResult>` — the idempotent, side-effect-guarded heal step (with a compensation/rollback per the standard)
- `maxAttempts`, `backoff` (schedule/policy)
- **`maxWallClockMs` (episode give-up)** — net-new bound
- `dedupeKey(ctx)` — same-break identity
- `flap` policy (per-break auto-escalation window)
- **`notificationLatencyCeilingMs`** — first-class backstop: the operator is told even while self-heal is still running once this passes (≤ the constitutional ceiling `standards.selfHealBeforeNotify.recoverableLatencyCeiling`; missing/unitless fails closed = escalate-sooner)
- `severityClass` (`recoverable` | `irreversible`/`data-loss`/`security` → immediate notify-and-heal)
- `audit` sink (scrubbed, metadata-only)

## 3. Design — a thin façade

### 3.1 `SelfHealGate.declare(spec)` composition (reuse, do not rebuild)
- **Registers** the controller through the EXISTING `governor.for(spec.id)` — inheriting ceilings, rate bucket, P19 breaker, dedupe, scrubbed audit, and restart-surviving snapshot for free. This satisfies the mandatory self-action registration by construction (lint passes).
- **Wraps** each heal episode in a `FailureEpisodeLatch` for one-signal-per-episode + the `signalAfterMs` notification threshold.
- **Maps** every contract field to the existing primitive that realizes it (audit §5 table): max-attempts→governor ceilings, backoff→governor rateBucket/cooldown + `retryWithBackoff`, dedupe→governor `DerivedTarget.key`, flap→governor `BreakerPolicy.flapWindowMs`, severity→`GovernorNoticeKind`.

### 3.2 Assertion side (the "gate")
`gate.attempt(ctx)` returns `admitted | queued | shed | broken` from the governor's existing admission, then runs `remediation` only when admitted; a capacity-shed of a SAFETY-gating heal fails CLOSED (held), never auto-passes (matches the fork-bomb/spawn-cap precedent).

### 3.3 The 3 net-new pieces (glue, not an engine)
1. **Uniform declaration+assertion wrapper** — the `SelfHealSpec` type + `declare()`/`attempt()` binding the above into ONE declared unit (today every breaker is bespoke).
2. **`maxWallClockMs` episode give-up** — a wall-clock budget on a heal EPISODE (not just count windows/per-domain TTL); on expiry the episode escalates critical and stops retrying (Distrust Temporary Success + No Unbounded Loops). Composes `FailureEpisodeLatch.failingForMs`.
3. **notification-latency backstop as a first-class guarantee** — promote `FailureEpisodeLatch.signalAfterMs` + the escalation into a DECLARED `notificationLatencyCeilingMs` the gate enforces (missing → fail-closed escalate-sooner).
- (Persistence: the governor snapshot already survives restart; the gate's per-episode state rides THAT, so no new durable store is strictly required for v1 — the in-memory reusable primitives are wrapped by the governor's persisted controller state. If a gate needs richer durable episode state, that is a scoped follow-on, not v1.)

### 3.4 Explicitly REJECTED
A new standalone self-heal engine / workflow runner / parallel breaker. Everything routes through `SelfActionGovernor` + `FailureEpisodeLatch`. Two engines watching the same degradation would double-count attempts and race the breaker (the same class as the context-wedge double-compact race).

## 4. First application — retrofit the feedback self-heal (sequencing)
The feedback-drain PR lands its self-heal **feature-local + conforming** NOW (the operator's 14:53 call: fix its 2 real gaps — the notification-latency backstop and per-break-recurrence counting — and register through the governor so the convergence gate passes). Once the SelfHealGate façade lands, the feedback self-heal is retrofitted to `SelfHealGate.declare(...)` as a FAST-FOLLOW, deleting its bespoke owns-everything machinery. This ordering keeps the merge-critical lane thin AND makes the façade's first consumer a real, already-shipped path (proves the contract against reality, not a toy).

## Multi-machine posture
The SelfActionGovernor is already `resource:'pool-shared'` with a restart-surviving snapshot and pool-scaled ceilings; a SelfHealGate declared through it inherits that posture — its counters/breaker state are pool-shared and survive restart+move exactly as the governor's do. No new cross-machine surface is introduced; the gate is a declarative façade over an already-unified substrate, so the default `unified` posture holds.

machine-local-justification: none — unified via the existing SelfActionGovernor pool-shared resource

## Testing (Testing Integrity — all three tiers)
- **Unit:** (a) `declare()` registers a governor controller + the lint sees `@self-action-controller`; (b) attempts beyond `maxAttempts` → breaker-open, no further remediation; (c) `maxWallClockMs` expiry → escalate-critical + stop (give-up); (d) `notificationLatencyCeilingMs` passes mid-heal → operator notice fires while heal still running; (e) same `dedupeKey` within window → one episode, not N; (f) per-break flap → auto-escalate; (g) capacity-shed of a safety-gating heal → held (fail-closed), never auto-passed; (h) an `irreversible`/`data-loss`/`security` severity → immediate notify-and-heal (no heal-gate delay interposed).
- **Integration:** a shared conformance fixture (the standard's required fixture) drives the stateful paths — unreachable-before-exhaustion, observable remediation evidence, flapping auto-escalation, latency backstop firing mid-heal — through the real governor.
- **E2E:** the retrofitted feedback self-heal declares a real SelfHealGate on a dev agent and its heal path is alive through the existing monitor path ("feature is alive" — 200 not 503 on its status surface).

## Frontloaded Decisions
- **FD-A (compose the SelfActionGovernor, do NOT build a new engine):** the substrate exists + registration is mandatory; the façade is glue. Reversible (the type + declare() are additive).
- **FD-B (v1 persistence rides the governor snapshot):** no new durable store in v1; a richer per-gate durable episode store is a scoped follow-on only if a consumer needs it. Cheap-to-change (additive).
- **FD-C (feedback self-heal retrofit is a fast-follow, not part of the façade PR):** keeps the façade PR reviewable and the merge-critical feedback-drain lane thin. Reversible (ordering).
- **FD-D (notification-latency ceiling fails closed):** a missing/unitless value escalates sooner — the safe direction (matches the standard).

## Decision points touched
- **The gate's admission (`attempt()`) — `invariant`, owned by the EXISTING `SelfActionGovernor`.** The façade adds no new judgment point; it delegates the admit/queue/shed/broken decision to the governor's existing deterministic admission (ceilings + rate bucket + P19 breaker). Justification: this is a deterministic bounding point by design (Capacity Safety), not a competing-signals judgment — the façade must NOT introduce an LLM or heuristic here.
- **The `severityClass` routing — `invariant`.** A fixed map (`recoverable` → heal-first; `irreversible`/`data-loss`/`security` → immediate notify-and-heal). A caller MISLABELING a critical degradation `recoverable` is a review finding (symmetric to the standard's correctness check), not a runtime judgment.

## Open questions
*(none — the one sequencing choice, feedback-self-heal retrofit vs façade landing, is decided in §4 as a fast-follow, not a blocker.)*
