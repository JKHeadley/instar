---
title: Unified Self-Action Backpressure Primitive
slug: unified-self-action-backpressure
author: Echo
date: 2026-07-05
parent-principle: Capacity Safety — No Unbounded Self-Action
related-principles:
  - Bounded Blast Radius
  - Structure beats Willpower
lessons-engaged:
  - "P20 — satisfied by the freshness-bounded, least-harmful per-class fail-direction discipline"
  - "P21 — satisfied by the per-surface machine-local-justification tags in §Multi-machine posture"
  - "P22 Self-Heal Before Notify — engaged on all SIX governor-raised notices: demote alarm (heal-exhaustion-gated) + dead-letter notice (§Queue contract, incl. enqueue-drop class) + errored-posture alarm (crashed-self-heal-machinery arm) + emergencyDisable flip item (principal-action tripwire carve-out) + principal-lane volume page (tripwire, episode-latched) + FD12 observe-limbo nudge (one-shot, coalesced) (rounds 5-7)"
  - "P23 — satisfied by P17 funnel-binding on every governor-raised notice"
source-investigation: docs/investigations/self-inflicted-loops/SYNTHESIS.md
status: "CONVERGED at round 9 (2026-07-05) — all six internal reviewers CONVERGED on v10 (dc 5th consecutive with ZERO findings, final counts 15/4/4; every round-8 fold verified genuine vs dist v1.3.780; every round-9 finding an explicitly non-blocking one-clause MINOR — two folded as the round-9 editorial batch (errored-alarm Standard-B completion + errored-episode/mint-collision audit rows ADV9-2; green-field observe-window honesty + INVERSE storm nudge ADV9-3), the rest enumerated as REQUIRED COMPANION CLAUSES in §Status). Externals: codex-cli gpt-5.5 CLEAN every round (r5-r9; r9 verdict = repeats of engaged meta themes, non-material); gemini-cli degraded-timeout r6-r9 (last clean pass r5), recorded per-round — spec-level cross-model flag = codex-cli:gpt-5.5 (any-round-success, satisfied every round). Open questions: zero. 9 iterations, ~120 distinct findings folded across rounds 1-9. Increment B of CMT-1911; awaiting operator approval (approved: true) after reading the convergence report; the normative implementation companion is the implementation AUTHORITY and ships with the build PR. NOT built. Tracked as task #11."
review-convergence: "2026-07-05T23:52:43.156Z"
review-iterations: 9
review-completed-at: "2026-07-05T23:52:43.156Z"
review-report: "docs/specs/reports/unified-self-action-backpressure-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 15
cheap-to-change-tags: 4
contested-then-cleared: 4
approved: true
approved-by: "Justin (verified topic-29836 operator) — conversational approval 2026-07-05 17:09 PDT, after the convergence report + ELI16 handoff"
approved-at: "2026-07-05T17:09:37-07:00"
---

# Unified Self-Action Backpressure Primitive (Increment B) — CONVERGED at round 9 (v10 + round-9 editorial batch; grounded against master, dist v1.3.780)

## Problem statement

The self-inflicted-loops investigation (SYNTHESIS, CMT-1903) established the class root: **Instar enforces
semantic safety (is each action well-formed?) but never capacity safety (is the action bounded in
frequency/resource under sustained pressure?).** Every self-triggered action — spawn, notify,
restart/respawn, account-swap, retry, re-drive, kill-request — shipped individually-correct and
collectively-unbounded, earning a bespoke local brake only *after* its own incident (20 distinct
instances 2026-04-16 → 2026-07-02).

The framework already has the right PATTERN — **Bounded Blast Radius** (the LLM-subprocess spawn
semaphore + `lint-no-unbounded-llm-spawn.js` + `host-spawn-semaphore-burst-invariant.test.ts`) and
**P17** (the notification funnel) — but it is **domain-locked**: applied per-resource, one incident at a
time, never generalized to restarts/swaps/retries. Increments E (the review gate), D (the
`self-action-convergence.test.ts` ratchet + `SELF_ACTION_CONTROLLERS` registry), and C (the ratified
"Capacity Safety — No Unbounded Self-Action" standard) shipped in #1376 — but they are DETECTION +
STANDARD, not the runtime primitive. A new self-action still hand-rolls its own brake (swap-thrash is
the proof: it reused none of P17's machinery). **This spec builds the missing runtime cut: ONE
default-on backpressure chokepoint every self-triggered action rides by default.**

## Proposed design (v4 — round-2 convergence-check folded, grounded against master dist v1.3.778)

### Glossary (for the external reader)

- **P17** — instar's existing notification-coalescing funnel (`AttentionTopicGuard.decide()` → allow|coalesce, never drop).
- **P19 breaker** — the in-process circuit-breaker primitive (N failures → cooldown) already threaded through instar's monitors (CrashLoopPauser et al.).
- **the ratchet** — `self-action-convergence.test.ts` (#1376): a CI test that drives each registry model under a pinned worst-case fixture and asserts the action count settles.
- **boundK / perTargetBoundK** — the registry's declared per-controller total and per-target action-COUNT ceilings; **horizon-independent** (they hold no matter how long the fixture runs — there is no episode boundary).
- **eternalSentinel** — a registry marker for a rate-floored, never-count-bounded class (e.g. a liveness heartbeat).
- **the SYNTHESIS** — `docs/investigations/self-inflicted-loops/SYNTHESIS.md` (CMT-1903): the root-cause investigation this spec fixes.
- **swap-thrash / the reaper flood** — 2026 incidents: a session swapping LLM accounts ~72×/day; a reaper firing 17,503 identical kill-requests/day (2026-06-05).

### Two artifacts, correctly distinguished (folds R1)

There are TWO distinct artifacts and the design touches both:

1. **The registry** (`src/testing/selfActionRegistry.ts`, `SELF_ACTION_CONTROLLERS`): a **5-entry
   TEST-MODEL set** the convergence ratchet drives at virtual-clock test time. Each entry declares
   `actionVerb` (e.g. `account-swap`, `age-kill`, `beacon-notify`, `liveness-notify`, `kill`), `models:`
   (a STRING ref to the real source file it simulates, e.g. `src/monitoring/SubscriptionPool.ts`),
   `boundK` (total-action bound), `perTargetBoundK` (per-target anti-ping-pong bound), optional
   `eternalSentinel` (`{reason, rateFloorMs}`), and `makeUnderPressure(f, sink)` (the synthetic tick).
2. **The retrofit surface**: the **~23 real emit-site FILES** the `models:` strings point at (and the
   `lint-no-unregistered-self-action` basename+verb surface). Each retrofitted controller gets a runtime
   `admit()` call AND keeps/gains a registry MODEL so the ratchet keeps proving its bound. `admit()` is
   the RUNTIME arm of the SAME contract the ratchet proves at test-time.

### Runtime policy schema (folds codex-C1, S1/S2, SEC4 — corrects a v2 overclaim)

v2 claimed the governor's policy "is NOT a new schema — just the registry's fields at runtime." **That was
wrong.** The registry's `boundK`/`perTargetBoundK`/`eternalSentinel` are NECESSARY but not SUFFICIENT
operational policy (they are test-fixture count assertions). The runtime governor declares a superset per
controller, defaults DERIVED from the registry where possible:

```
ControllerPolicy = {
  controllerId, actionVerb,                       // identity (verb = audit tag only)
  direction:  'relief' | 'amplifying' | 'neutral',
  resource:   'hardware-bound' | 'pool-shared',
  failDirection: 'closed-queue' | 'open-coalesce',
  perTargetCountCeiling,   // ← runtime analogue of perTargetBoundK (LOAD-BEARING)
  totalCountCeiling,       // ← from boundK
  rateBucket: { ratePerWindow, windowMs, refill },
  concurrencyCap,
  breaker:    { failThreshold, cooldownMs, flapWindowMs },
  staleTtlMs,              // pressure-reading freshness bound
  queueMaxDepth,           // per (controller, target) — same-target coalesced-intent depth
  queueMaxTargets,         // per controller — DISTINCT-target queue ceiling (the growth axis; folds SC5-1)
  perTargetEvict: { ttlMs, maxEntries },          // eviction (S4)
  amplifying?: { projectPressure },               // RAW-reading callback only (SEC3)
  eternalSentinel?: { rateFloorMs },
}
```

Every non-registry field is a conservative, config-overridable CODE constant (sparse per-class override;
`migrateConfig` writes nothing — see Migration parity). The registry seeds `totalCountCeiling` /
`perTargetCountCeiling`; the governor supplies the rest.

**Default policy table (folds CX3-4 — illustrative starting constants, all config-overridable; derived from
the registry's proven bounds + the documented incident rates, evaluated in observe mode first).** The
builder does not invent these from scratch:

| controllerId (example) | direction | resource | fail | perTargetCeiling | totalCeiling / windowMs | rateBucket | staleTtlMs |
|---|---|---|---|---|---|---|---|
| `age-kill` (reaper) | relief | hardware-bound | open-audited (relief — FD2) | `perTargetBoundK`=5 | max(~60, k% of live sessions) / 60-min window (census-scaled — folds ADV5-2; ≫ a worst-case bulk-reap; ≪ the 17.5k/day flood) | relaxed while effective | — |
| `external-hog-kill` | relief | hardware-bound | open-audited (relief — FD2) | `perTargetBoundK`=3 | rolling-window (registry) | relaxed while effective | — |
| `swap` | amplifying | pool-shared | closed-queue | 3 / account | ~8 / 45 min (dwell) | base + projectPressure tighten | 60 s (quota poll age) |
| `notify` (beacon) | neutral | pool-shared | open-coalesce | P17-coalesce | P17 window | P17 frequency | — |
| `respawn-crashloop` | amplifying | hardware-bound | closed-queue | 3 / session | ~10 / 30 min | base | — |
| `respawn-recovery` | relief | hardware-bound | **open** (never queued) | rate-floor only | — (ResumeQueue cap owns give-up) | rate-floor only | — |
| `liveness-heartbeat` | neutral | hardware-bound | open-coalesce | `eternalSentinel` | `boundK: Infinity` | `rateFloorMs` only | — |

These are conservative defaults that bite only under sustained pressure; each is overridable per-class in
config, and the observe→enforce flip (FD1/FD8) evaluates them before any class enforces.

### The primitive: `SelfActionGovernor`

A single in-process chokepoint every self-triggered, cost- or disruption-bearing action passes through to
acquire permission to fire, keyed on a **controller id**.

- **Policy key = controller id (folds R4) — and the id is AUTHENTICATED at the callsite (folds SEC5-1 /
  ADV5-8).** The emit-site API is a PER-CONTROLLER HANDLE minted once at registration — `const gov =
  governor.for(controllerId)` at module scope, then `gov.admit(targetKey, opts): Admission` — never a raw
  string-keyed `governor.admit(controllerId, …)` at an emit site (lint-forbidden). The controller id is
  the runtime POLICY SELECTOR — including the privileged relief/exempt lanes — so an emit site must not be
  able to claim another controller's identity by passing a string: the `emit-without-admit` lint
  additionally asserts the handle's id equals the file's `@self-action-controller` marker id, and the
  Tier-3 token-coverage inventory pins each protected SINK's expected controller identity module-side (a
  sink for controller X rejects a token minted for controller Y even when the callsite presents Y
  consistently — the token's consistency check validates agreement, never authenticity; identity is bound
  at registration + sink, not caller choice). Grounded against dist v1.3.780: the deployed
  `lint-no-unregistered-self-action` validates only that a file's self-declared marker EXISTS in the
  registry, and the registry's `models:` reverse-pointer is documentation-only — so without this binding a
  new emit path could honestly-or-maliciously claim `respawn-recovery` and inherit its unconditional
  allow-token with no lint, test, or policy-table change tripping. **FILE ↔ controller binding (folds
  SEC6-4/ADV6-4 — the handle=marker check alone still admitted a copy-pasted SECOND file declaring the
  same marker id):** the registry's `models:` pointer is PROMOTED from documentation to a lint-asserted
  binding — a file may declare marker X (and call `governor.for(X)`) ONLY if it is the registry-named
  file for X (or on an explicit per-controller file allowlist for legitimately multi-file controllers);
  the lint additionally rejects `governor.for()` in any file without a matching marker and enforces
  marker-id UNIQUENESS across the codebase. **The lint's scan scope is CODEBASE-WIDE HANDLE USAGE (folds
  SEC8-1/ADV8-3 — the deployed lint scans only controller-shaped/marker-carrying files, and the
  mint-once-IMPORT pattern for multi-file controllers exports a handle any file could import):** the
  identity-equality assertion applies to EVERY governor-handle usage — `governor.for()` AND `admit()` on
  an imported handle — in every file, so handle USE in a file without a matching marker fails the build
  exactly as an unmatched mint does; equivalently, an exempt-lane handle is never exported beyond that
  controller's allowlisted files. Runtime defense-in-depth: `governor.for()` enforces
  SINGLE-MINT per controller id, **keyed on a process-GLOBAL token (`globalThis` via `Symbol.for` — folds
  ADV8-1: the named residual case, an accidental dual-package/duplicated-dist load, duplicates the WHOLE
  module graph including a module-scoped registry, so instance-scoped state would see one clean claim per
  copy and guard nothing in exactly its named case; the global key makes cross-copy claims collide, and
  the in-memory admission-state anchor shares the same global key so two copies can never run independent
  full-budget counters or clobber the durable snapshot as uncoordinated writers)** — a duplicate claim
  fails LOUDLY, and the failure is CONTROLLER-SCOPED
  errored posture, never process-fatal (folds ADV7-3 — the residual duplicate case is the accidental
  dual-load, e.g. a Node dual-package/duplicated-dist layout, and a process-fatal reading would give the
  governor's defense-in-depth an availability blast radius larger than anything it guards; the losing
  claimant's callsites hold dead handles whose admits resolve through the per-class fail direction,
  already defined and loud). Buildability mechanics (folds SEC7-4): a legitimately multi-file controller
  mints ONCE and imports the handle (the file allowlist licenses declaration, not duplicate minting); the
  lint supports MULTIPLE markers per file (the shipped registry already has one file hosting two
  controllers — `PromiseBeacon.ts` models both `beacon-notify` and `liveness-notify`) and binds against a
  parseable path FIELD, not the raw `models:` string (the shipped values are prose-annotated). `actionVerb` is an audit tag. Keying on
  the ~23 controllers (not the 7 verbs) makes the signature, policy table, and config schema well-defined.
- **Principal provenance: a HUMAN action always wins (folds ADV5-5 — FD13).** Several protected sinks are
  DUAL-USE — `SessionManager.killSession` serves both the autonomous reaper and the operator's dashboard
  kill / "stop everything" emergency stop (verified against dist v1.3.780: operator routes call the same
  funnel the retrofit protects). `admit()` therefore carries an `origin: 'self' | 'principal'` field, set
  STRUCTURALLY at the entry surface (an operator-authenticated route / the MessageSentinel emergency-stop
  interceptor — never inferred from message content, per Know Your Principal): `origin: 'principal'` is an
  ALWAYS-ALLOW, ALWAYS-AUDITED lane that bypasses every ceiling. The governor bounds SELF-action; an
  enforcing kill class must never count-deny or queue the operator's emergency stop mid-storm — that would
  invert "a human action always wins." **Round-6 hardening (folds SEC6-1/SEC6-2/ADV6-1 — the lane needed
  the same structural triad the controller id got, plus a pinned authentication TIER):** (a) the ordinary
  per-controller handle API structurally CANNOT express `origin: 'principal'` — it defaults and pins
  `'self'`; principal admission is a SEPARATE privileged API (`governor.principalAdmit(...)`) importable
  only by an ENUMERATED allowlist of provenance-setting entry-surface modules (the external-hog
  allowlist-class pattern), lint-enforced: the `origin:'principal'` literal / the privileged-API import is
  build-forbidden outside the enumerated files, and the Tier-3 inventory asserts the enumeration matches
  the dual-use sink list. (b) The authentication TIER is pinned: `origin: 'principal'` requires a
  HUMAN-principal signal — a dashboard-PIN-authenticated session, a MessageSentinel-verified REGISTERED
  sender, or a mandate-verified principal (the fleet's existing "a Bearer token is structurally
  insufficient" precedent: mandates, pairing-verify, external-hog arm, guards accept-fallback). A bare
  Bearer API call stamps `origin: 'self'` and rides the normal ceilings — grounded against dist v1.3.780:
  the deployed `DELETE /sessions/:id` / `POST /sessions/:name/remote-close` stamp operator-origin for ANY
  Bearer holder, and the agent + every skill/script hold that Bearer token, so without this pin a runaway
  agent-scripted kill loop via curl would ride always-allow AND be audited as a human action (build task:
  make the PIN-authed dashboard session distinguishable from a bare-Bearer call at these routes). (c) The
  lane carries independent VOLUME anomaly detection (folds codex-r6): principal-origin admits are counted
  per (surface, window), and a volume anomaly raises a page — never a block (the lane stays non-blocking
  by construction; containment is visibility, not denial). Notice contract for the page (Standard B —
  folds SEC7-2/SC7-4): EPISODE-latched (dedupe-key = the anomaly episode per surface — a sustained loop
  spanning window rolls is ONE item enumerating the running count, not a page stream), severity HIGH
  (principal-lane volume is either a compromised surface or a mis-stamped path — both operator-urgent),
  P17-funnel-bound, max-notification-latency one funnel tick from detection, remediation = none
  (tripwire — the lane must stay non-blocking), audit-location = the transitions audit. (d) THREAT-MODEL
  HONESTY (folds ADV7-4): the HUMAN-tier pin is a friction/deliberateness elevation adequate against the
  spec's adversary — buggy runaway loops don't mint PIN sessions — NOT agent-impossibility against a
  deliberately adversarial or prompt-injected self (the PIN is machine-local config the agent can read; a
  fleet-wide property of every PIN surface), which is exactly why the lane is always-audited +
  volume-paged. And the inverse edge: if the HUMAN-signal verifier itself is dark at stop time, the
  operator's action demotes to `self` and rides ceilings — the verifier-independent human valve is the
  `emergencyDisable` config edit (already the named mass-incident valve), so "a human action always wins"
  holds under correlated verifier failure. Under an ERRORED governor the lane fails OPEN unconditionally
  (see §Fail-direction — folds SEC7-1) — with the honesty note that the volume counter and audit are
  themselves governor machinery and may be dead for that window; the level-triggered CRITICAL errored
  alarm is the covering signal, so the lane is never uninstrumented AND unannounced (folds SEC8-2). The
  phone-completable valve LAYERING is named (folds LA8-2/INT8-3, per Mobile-Complete Operator Actions):
  the PRIMARY operator path is conversational — an instruction to the agent over any live channel, the
  agent performing the config change (legitimate precisely because `emergencyDisable` is deliberately
  principal-ungated, with the flip audit + episode-latched HIGH item as the compensating control); the
  dashboard/API path requires adding the governor key to the deployed `PATCHABLE_CONFIG_KEYS` allowlist
  (a NAMED deliverable and a deliberate Bearer-surface widening, not an assumption — the deployed
  allowlist would 400 `intelligence.*` today); the raw config-file edit remains the deliberate
  verifier-INDEPENDENT floor for the correlated-failure case, a named last resort, never the primary
  path. A future refinement MAY split break-glass (emergency stop,
  unconditional) from ordinary bulk principal actions (generous caps / confirmation gates — codex-r7/r8);
  the emergency lane's unconditionality is not negotiable.
- **`Admission` is THREE-way, never a silent drop (folds R3).**
  `Admission = { outcome: 'allow' | 'coalesce' | 'queue', reason?, retryAfterMs?, token? }`. `coalesce`
  folds into a running/aggregate action (the P17 notify path); `queue` defers without loss (the
  reactive/one-shot path — fail-to-QUEUE, never a reject-that-bypasses). Only `allow` mints a token.
- **Atomic check-and-mint (folds SEC4 — the burst TOCTOU).** The bound-check AND token-mint are ONE atomic
  operation so two concurrent `admit()` calls can never both pass a ceiling of 1. The mechanism is keyed on
  **cross-process contention, NOT on "hardware-bound" (folds SC-M1):** a class whose resource is contended by
  MULTIPLE instar processes on the host (e.g. `session-respawn`'s host process-count ceiling) uses a
  **host-file CAS** (the `host-spawn-holders.json` pattern); a SINGLE-PROCESS machine-local class
  (`age-kill` / `kill` — kills local sessions from one process) uses an **in-memory single-writer CAS and
  keeps `admitSync`** (no per-admit file I/O on the highest-frequency storm path). Any host-file-backed
  `concurrencyCap` REQUIRES dead-holder/TTL reclaim (a crashed mint-holder must not permanently consume
  capacity and wedge a fail-closed class — the 2026-07-01 stale-holder lesson; the `/prune` reclaim the
  spawn/test-runner limiters added); an in-memory `concurrencyCap` resets on crash and needs none.
- **Capability token — hardened (folds SEC2, A3, codex-C5).** On `allow` the governor mints an OPAQUE
  handle bound to the exact `(controllerId, targetKey, class, nonce)` with a short TTL tied to the
  mint-time pressure reading. It is atomically consumed/invalidated on emit and REJECTED if presented for a
  different controller/target/class, a second time, or after expiry (→ re-admission). **The runtime
  consume/validate at the protected sink is the AUTHORITY (folds CX4);** the opaque `AdmissionToken`
  compile-time TYPE is ergonomic defense-in-depth that catches most skip paths early, NOT a hard boundary (a
  cast / `any` / JS call site can evade the type — but not the runtime consume).
- **Sync fast path.** Zero-I/O frequency classes (`notify`) get a synchronous `admitSync()`; classes that
  touch a host-file CAS use `async admit()`. (Counters stay in-memory — see Telemetry — so `admitSync`
  is genuinely I/O-free.)
- **Default-on ≠ enforce-by-default (folds CX3).** "Default-on" means every self-action is REGISTERED and
  routed through `admit()` by construction (not skippable) and a controller with no explicit policy inherits
  a conservative default ceiling — so a *new* self-action inherits a bound by construction (the core
  requirement). It does NOT mean a new controller ENFORCES on day one: a newly-added controller starts in
  OBSERVE and graduates to enforce only via the per-controller FD8 ladder. The honest phrasing (folds
  codex-r5): a new controller is REGISTERED and MEASURED by construction and ENFORCEABLE by construction —
  it is not BOUNDED until its class enforces; the enforce flip is always the deliberate operator step.
  **Scope honesty on the observe window (folds INT8-2, engaging the round-8 gate flag):** "existing
  guards still apply meanwhile" is true for the ~23 RETROFITTED controllers (each carries its
  incident-earned bespoke brake through observe); a GREEN-FIELD controller added after this ships has no
  such brake, and its observe window is the ACCEPTED residual — bounded in TIME by FD12 on the
  criterion-MET path (promotion criterion + the 30 d limbo nudge), and for the criterion-NEVER-MET
  sub-case (a green-field controller STORMING in observe keeps its would-deny rate above the flip floor,
  so the limbo clock never starts — folds ADV9-3, correcting an overclaim) by the INVERSE nudge:
  sustained would-deny above the flip floor on a controller with no bespoke brake raises the same
  one-shot coalesced posture item ("this class would be denying — brake it or flip it"), so no observe
  window is time-unbounded in either direction. Visibility rides the would-deny aggregates, with the
  shipped Increment-E review gate (#1376) named as the authority that can demand an interim bespoke
  brake or an expedited flip for a high-risk new class. **The retrofit is ADDITIVE at every rung (folds LA8-1):** no
  existing bespoke brake (AgeKillBackoff, the swap anti-thrash dwell, topicCreationBudget, …) is removed
  at ANY point of the ladder, including enforce graduation — double-bounding is the intended
  defense-in-depth (the tightest bound wins), and removing a bespoke brake is its own later deliberate
  change with its own review, never implied by a class reaching enforce.

### The LOAD-BEARING bound is the hard count ceiling; non-convergence is a supplementary early-trip (folds LA2, A2, SEC1 — CORRECTS v2)

v2 made non-convergence the PRIMARY runtime bound and called it "`boundK`'s runtime analogue." Round-2
showed they are **not** analogous, and this is corrected:

- **The load-bearing runtime bound is the hard per-target + per-window COUNT ceiling**
  (`perTargetCountCeiling` / `totalCountCeiling`) — the true runtime analogue of the PROVEN
  `perTargetBoundK`/`boundK` the ratchet already proves settle — plus the token-bucket rate ceiling and the
  P19 breaker. These are computable for EVERY class, including neutral/notify classes that reduce no
  measurable pressure. Round-1's "raw count is wrong" rejected an *undefined-episode* count; it did NOT
  reject `perTargetBoundK`, which is a per-target ceiling with no episode boundary. v2 conflated them and
  discarded the proven invariant; v3 carries it as load-bearing.
- **Runtime horizon (folds CX2):** `boundK`/`perTargetBoundK` are horizon-independent as a TEST assertion
  (a bounded fixture), but a naive monotonic process-lifetime counter would eventually brick a legitimate
  long-lived controller. At runtime the count ceilings are therefore SCOPED: the per-target count decays via
  `perTargetEvict` when a target settles/dies, and the `totalCountCeiling` is a **fixed-bucket SLIDING WINDOW
  (folds SC3-m1):** O(buckets) memory, O(1) amortized per admit (bucketed like the §"Runtime telemetry"
  aggregates), NOT a per-event timestamp deque swept on each admit (which would re-tax the very `admitSync`
  path SC-M1 protects — `age-kill` rides it at ~17.5k/day). **Relief / accept-but-respawn classes MUST use the
  sliding window with NO convergence-epoch reset (folds ADV3-M2):** an epoch reset keyed on "pressure returns
  to normal" is the same symptom-level drop the round-2 CRITICAL forbids — killing a respawning target
  momentarily drops CPU, which would reset the hard floor just before the signature respawns (Distrust
  Temporary Success at the floor). A convergence-epoch reset is permitted ONLY for a non-relief class AND only
  behind the same per-episode latch + a cooldown exceeding the class's max action latency, so a momentary drop
  can never flap the floor. **Eviction is recency-aware (folds SC-m3):** an actively-hit at-ceiling per-target
  entry is REFRESHED, never evicted — so a many-distinct-target storm can't use eviction churn as a
  ceiling-reset escape — and `totalCountCeiling` is tracked INDEPENDENTLY of the evictable per-target map, so
  the total ceiling backstops fan-out regardless of eviction. **Fan-out corner (folds SC3-m2):** if the
  per-target map is at `perTargetEvict.maxEntries` with NO evictable (expired/settled) entry, a NEW distinct
  target fails CLOSED (queue/deny) rather than evicting an active at-ceiling entry — the map cap becomes
  another safe ceiling — and a denied/queued admit never allocates or refreshes a per-target entry, so the map
  can't grow past what the total ceiling admits.
- **Admission state is DURABLE across restarts (folds ADV5-6).** The window buckets, per-target counts,
  auto-demote latches, and P19 breaker state are flushed on the SAME bounded cadence as the telemetry
  aggregates (atomic temp+rename; the `host-spawn-holders.json` durable-capacity precedent) and REHYDRATED
  at boot — because the storms this primitive targets (OOM fork-bomb, crash-loop, meltdown load-shed) are
  exactly the conditions that bounce the process, and an in-memory-only floor would hand the runaway loop a
  fresh count budget on every restart (including a self-triggered `restart-all` — an action available to
  the very loop being governed; SC-M1's "in-memory resets on crash and needs none" was scoped to
  `concurrencyCap`, where reset is the SAFE direction — for count ceilings reset is the unsafe one).
  **Flush timing is EVENT-AWARE, not cadence-only (folds SC6-2/ADV6-5 — a cadence-only flush is defeated
  by the fastest form of its own adversary: a crash-loop bouncing FASTER than the flush interval loses
  every incarnation's admissions, the floor never ratchets, and the loop regains a full budget per bounce
  — the loss is not "one interval", it is cumulative-unbounded and CORRELATED with the storm):** in
  addition to the cadence, an ASYNC eager flush fires when the unflushed admission delta crosses a small
  threshold, when any relief-class count crosses half its ceiling, on the FIRST post-rehydrate admission,
  and on GRACEFUL SHUTDOWN (which also closes the self-triggered `restart-all` case entirely); a flush
  BARRIER runs before consuming a token for any admitted action whose effect is the governor's own
  process death. **Debounce edge semantics are PINNED (folds ADV7-2/SC7-2 — a trailing-edge reading would
  let a crash-loop dying within ~1 s of its first admission escape every flush, and the closure would be
  implementation luck):** the admission-delta trigger is debounced (≥ ~1 s, so a storm can never become
  per-admit disk amplification), but the FIRST-post-rehydrate flush is IMMEDIATE/leading-edge (once per
  boot — the anti-amplification rationale cannot apply to it) and the once-per-window half-ceiling
  crossing is likewise debounce-exempt; the Tier-1 fixture drives bounce periods SHORTER than the
  debounce, not merely shorter than the cadence. After an UNCLEAN shutdown, rehydration applies
  pessimistic carry-forward (assume the lost interval consumed at the last-flushed rate — with a NON-ZERO
  floor when the last-flushed rate is ~0 but prior-enforcement evidence exists, so a storm born inside
  the lost interval still ratchets). Accepted, stated residual loss: bounded by the debounce interval
  (~1 s at default — the residual scales with the debounce if overridden; folds SC8-1). **Accepted, stated
  residual (folds SEC7-5):** the never-existed-vs-emptied evidence lives in the co-located telemetry
  aggregates, so a COORDINATED local-fs deletion of snapshot + aggregates (+ the transitions audit, the
  third independent witness) degrades to silent-fresh-install posture — the same accepted
  local-filesystem-adversary residual class as `registry-high-water`. The flush itself is
  asynchronous and size-bounded by construction (the snapshot embeds only the eviction-capped per-target
  maps + fixed-size window buckets — the caps state the bound; folds SC6-4). **Reset paths are DEFINED
  and LOUD (folds ADV6-5/SEC6-5 — for count ceilings, reset is the unsafe direction, and a deleted or
  corrupt state file is a budget-refill lever available to the governed loop itself):** a MISSING or
  CORRUPT/unparseable snapshot at boot, when the flushed telemetry aggregates show recent enforcement
  (the never-existed-vs-emptied distinction — the `registry-high-water` pattern), starts the affected
  classes at a CONSERVATIVE posture (static rate floor for one full window) and writes a loud
  `state-reset` transitions row + attention signal; a genuinely-fresh install (no prior flush evidence)
  starts empty and silent. Rehydration is recency-validated — state older than the largest class window
  is dropped (with a `state-reset` row when non-trivial state is dropped), so a restored snapshot can
  only ever re-impose a floor that current conditions still justify, never wrongly deny from stale
  history. The durable file is machine-local and BackupManager-EXCLUDED (see §Multi-machine posture).
- **`perTargetBoundK` gets an explicit per-target runtime analogue** (a per-target count ceiling + per-target
  token bucket). This is what catches the swap `A→B→A→B` ping-pong that a GLOBAL non-convergence signal is
  structurally blind to (each swap "reduces the pressure it responds to," so global convergence never
  trips; the per-target ceiling does — folds A2's ping-pong escape).
- **Non-convergence detection is DEMOTED to a supplementary EARLY-TRIP signal** (trip *sooner* when actions
  demonstrably fail to help). Where used it requires: a NET reduction over a window / minimum-delta (not a
  saw-tooth single-reduction reset — A2); a FRESHNESS-BOUNDED measurement — un-confirmable / stale /
  low-confidence "convergence" counts as NON-convergence and trips toward closed, NEVER "settled" (SEC1,
  symmetric to the projection freshness bound); and it is simply OMITTED for classes whose pressure isn't
  measurable (they rely on count + rate + breaker).

### Bypass-eligible relief: the COUNT ceiling is a hard floor; the bypass relaxes only the RATE (folds LA-C1, ADV-M1, ADV-M6, ADV-M3/LA-M2, ADV-M4 — CRITICAL, CORRECTS v3)

Round 2 showed v3's "effectiveness-gated bypass" still had holes at exactly the registry models it targets.
`age-kill` (`boundK: 5`, the 2026-06-05 reaper — 17,503 kills/day) is VETOED (keeps rejecting → v3 bounds it
correctly). But `external-hog` (`boundK: 3`) does NOT reject — its kill ACCEPTS every time, only the hot
signature respawns; v3's "target accepts ⇒ effective" arm read that as relief and re-opened the flood
(Distrust Temporary Success: "the process died" is a symptom-reset, not root-cause resolution). v4 closes it:

- **Bypass ELIGIBILITY is a CLOSED, declared de-escalation class set — by construction, never per-outcome
  inference (folds ADV-M6).** Only `{ kill, reaper, session-close, respawn-recovery }` are bypass-eligible.
  `swap` / `notify` are declared NON-relief (`amplifying` / `neutral`) and are NEVER bypass-eligible — a
  successful swap "relieves" quota pressure and "accepts," so a pure outcome-inference would wrongly grant
  swap-thrash the bypass. Eligibility is declared class membership; effectiveness only governs a RATE
  relaxation WITHIN that set. **Lane MEMBERSHIP for the two count-exempt lanes is enumerated + lint-bound,
  never self-declared (folds ADV5-3 / codex-r5).** `respawn-recovery` and `eternalSentinel` are the
  governor's unbounded lanes, so which controllers may occupy them is a CODE-LEVEL allowlist (the
  external-hog allowlist-class pattern): a registry entry claiming either lane must appear in the
  enumerated member list, and each member MUST declare its `delegatedGiveUp` authority — the named
  external cap that owns its give-up (the ResumeQueue resurrection cap / the liveness-reconciler P19 for
  the two existing `respawn-recovery` paths) — and the ratchet fixture DRIVES that delegated cap to its
  trip point, proving the delegated bound is real machinery, not prose. `rateFloorMs` carries a
  CODE-CONSTANT floor (an `eternalSentinel` with `rateFloorMs: 1` is unbounded-in-practice; the deployed
  registry's only sentinel uses 3,600,000 ms — a future entry stays within that order of magnitude, and
  lowering below the floor is an audited override, never a quiet registry field).
- **The COUNT ceiling is a HARD FLOOR for every count-bound relief class — the bypass relaxes ONLY the RATE
  ceiling (folds LA-C1; count-exempt classes named in the invariant below, folds CX3-2).** `perTargetBoundK`
  / `totalCountCeiling` apply even during effective relief; the bypass only relaxes the token-bucket RATE.
  This is the load-bearing correction:
  - **Genuine relief retires its target** (the session is killed, the run recovers) → that target stops
    accumulating → it naturally stays under `perTargetBoundK`. No livelock (the round-1 concern): the RATE
    relaxation lets a legitimate burst across MANY DISTINCT targets through FASTER — but the
    `totalCountCeiling` STILL BINDS a distinct-target FLOOD (folds ADV3-M1: the total ceiling is not exempted
    for distinct-target relief; the rate relaxation, not a count exemption, is what serves legitimate
    bursts). **The `boundK` tuning premise is resolved by CENSUS-SCALING (folds ADV4-M1, superseded by
    ADV5-2):** round 5 showed the static premise ("set the ceiling above worst-case legitimate load and
    below a genuine flood") is UNSATISFIABLE for relief — legitimate relief load is
    population-proportional (a spawn runaway creating 200+ sessions requires 200+ distinct-target kills,
    count-indistinguishable from a buggy mass-reap of healthy sessions), so no constant sits between them.
    A relief class's `totalCountCeiling` is therefore GOVERNOR-OWNED and census-scaled:
    `max(staticFloor, k% of the live target population)` per window (illustrative default `k` ≈ 15%,
    FD11-class). **Census read discipline (folds SC6-1/ADV6-2/SEC6-6 — the census is the one dynamic
    input that can WIDEN an enforcing relief ceiling, so it carries the strictest discipline of all):**
    (i) the census is a plain cached INTEGER sampled OFF the hot path — at window roll plus the existing
    slow reaper/heartbeat tick — NEVER inside `admit()`/`admitSync` (grounded: the example source,
    `StateManager.listSessions()`, does a full-directory readdir+parse sweep on cache miss and allocates
    copies of every record per call — per-admit evaluation would break the zero-I/O guarantee for
    `age-kill`, the highest-frequency storm class); (ii) the ceiling is COMPUTED AT WINDOW ROLL and a
    mid-window re-sample may only WIDEN, never shrink (no retroactive denial of admissions the roll-time
    ceiling justified); (iii) the census source must be governor-owned and INDEPENDENT of the governed
    controller's own candidate enumeration (the reaper's buggy list must not feed the reaper's budget —
    a self-reinforcing loop by construction); (iv) it rides the same `{value, asOf, confidence}`
    discipline as `projectPressure`, and WIDENING requires a fresh confident reading — stale, unavailable,
    or low-confidence falls to the static floor (only tightening may be trusted cheaply); (v) `k% ×
    census` is CLAMPED under an absolute code-constant per-window maximum (a config-plausible multiple of
    the configured session cap), so no census reading — however inflated by phantom/duplicate/foreign
    entries — yields an unbounded budget, and a reading that HITS the clamp writes a transitions-audit
    row (an inflated census is itself an anomaly worth seeing). This encodes the hazard the ceiling actually guards — never relieve more
    than a bounded fraction of the live population per window — while a genuine mass incident scales the
    budget with the mess it must clean. The DESIGNED DEGRADED BEHAVIOR past even the census ceiling is
    explicit: further kills proceed window-paced (rate-floor liveness holds; counts above the census
    fraction deny), the shed is LOUD (the P17-funnel-bound dead-letter notice — see §Queue), and the
    operator's mass-incident relief valve is NAMED — `emergencyDisable` (pass-through) or the per-class
    ceiling override — so a real fire is never fought through a silently-throttled reaper.
  - **Ineffective relief re-fires the SAME target** → hits `perTargetBoundK` → bounded, regardless of whether
    the action "accepted." This is what closes `external-hog` (`boundK: 3`, `perTargetBoundK: 3`): its
    registry `targetKey` is the recurrence SIGNATURE, so respawns (new pid, same signature) collapse to ONE
    target and hit `perTargetBoundK` at K — the governor is never looser than the ratchet it generalizes.
  - **Target-granularity invariant (folds ADV3-M1(2), CX3-5, ADV4-m2/LA4-M1) — the closure is structural only
    if this holds, and it must match the SHIPPED two-level design.** The requirement is that the EFFECTIVE
    matching granularity is pressure-stable: this mirrors the deployed `ExternalHogKillLedger`, which already
    supports a `(key, classId, keyIsVolatile)` triple — an exact-key match when the key is stable, and a
    match on the stable `classId` when `keyIsVolatile: true`. So a legitimately volatile-keyed controller with
    a stable class is CORRECT (NOT a mandated build failure — v5's earlier "volatile MUST fail" wording was
    wrong against the real mechanism); what must NEVER happen is an EFFECTIVE granularity finer than the
    recurrence identity (a per-incarnation pid with no stabilizing class), which fans out where the model
    collapses. **Binding model ↔ runtime is the load-bearing half (folds ADV4-m2/LA4-M1 — the round-3
    concern):** each controller exposes ONE canonical `deriveTargetKey(ctx)` (returning the key + its
    `classId`/`keyIsVolatile`) that BOTH the registry model's `makeUnderPressure` AND the runtime `admit()`
    emit site are lint-bound to call — the lint asserts `admit()`'s target argument IS
    `<controller>.deriveTargetKey(…)`, never a raw inline expression (a granularity-detecting lint over
    arbitrary expressions would be heuristic/evadable = willpower). **The Tier-1 fixture points at that shared
    derivation (folds LA3-M1):** it drives the REAL candidate→`deriveTargetKey` path with VARYING incarnation
    ids per respawn while the pressure-stable class holds, and asserts `boundK` still binds — so a controller
    whose effective granularity is finer than its recurrence identity FAILS the build. Because model and
    runtime share the one derivation, the fixture that exercises it transitively covers the runtime path (L1
    and L2 collapse into one tested contract). Verified: the real `external-hog` model + runtime both resolve
    to the signature/class, so it passes.
- **Effectiveness is attributable PRESSURE-REDUCTION only — action-acceptance NEVER satisfies it (folds
  ADV-M1, LA-C1).** The RATE relaxation is granted only while the governor observes a causally-attributable
  reduction in the pressure the action responds to. That reading is GOVERNOR-OWNED and freshness-bounded —
  the SAME raw-`{value,asOf,confidence}`-in, decision-governor-side discipline as `projectPressure` (never
  controller-self-reported); an un-confirmable/stale reading WITHDRAWS the relaxation (back to the base rate
  floor), never grants it.
- **A rate FLOOR holds even on effective relief** (deny only at pathological multiples of the expected rate)
  so an OOM-class relief runaway across distinct targets is bounded while genuine liveness is preserved.
- **`respawn-recovery` is EXEMPT from the count-ceiling/breaker demotion AND the un-confirmable→closed rule,
  and it FAILS OPEN (folds ADV-M3, LA-M2, ADV3-m3).** Reviving a genuinely-dead registered autonomous run
  under the very saturation that killed it will transiently "keep rejecting"; demoting it to the count
  ceiling + opening its P19 breaker would STRAND the run (the exact *An Autonomous Run Must Outlive Its
  Session* violation). So the governor imposes **NO blocking bound on `respawn-recovery` (folds ADV4-m3/
  LA4-m2 — corrects a v5 wording contradiction):** it always yields an allow-token — a rate-floor deny AND a
  governor error both fail OPEN — and it is NEVER `queue`d and NEVER dead-lettered, so it can never be
  stranded via the governor's `maxReadmitCycles` dead-letter path. (There is no enforcing rate floor here — a
  builder must not implement a blocking rate-floor deny for this class.) Its loud give-up is delegated ENTIRELY
  to the two sanctioned authorities the reconciler already owns — the **ResumeQueue resurrection cap** and the
  **liveness-reconciler's own P19 breaker** (both `respawn-recovery` emit paths named in §"session-respawn
  splits"). Those delegated caps are the sole bound for this recovery loop, so (folds gemini-r4) their tests +
  monitoring are hyper-focused: they are the single point of give-up authority the governor's fail-open relies
  on.
- **Auto-demote is latched + its alarm coalesced — and GATED on heal exhaustion (folds ADV-M4; upgraded by
  LA5-2/INT5-3 per P22 "Self-Heal Before Notify").** When a relief class loses the RATE relaxation, the
  transition is LATCHED per sustained-pressure episode (re-promote only after a clean cooldown, never on
  the next momentarily-reduced reading) so it cannot promote↔demote flap. The demote→re-promote cycle IS
  the self-heal: a demotion that heals (re-promotes after its clean cooldown) is AUDIT-ONLY — the
  transitions audit records it; the operator is never pinged for a transient episode. The operator-facing
  alarm fires only on heal EXHAUSTION: demotion persisting past N clean-cooldown windows (default 3), a
  repeated flap-latch within one episode, or co-occurrence with hard-floor/dead-letter events — and then
  routes through the P17 attention funnel (COALESCED), never a raw per-event send. Notice contract
  (Standard B): remediation-action = the latched re-promotion path itself; dedupe-key =
  `(controllerId, episodeId)`; flap breaker = the latch; max-notification-latency = one evaluation tick
  past the Nth failed cooldown (≤ 120s past exhaustion); severity class = recoverable (a demoted class
  still enforces its count floors — nothing is unguarded while demoted); audit-location = the
  transitions-only audit. (The FD9 enrollment-triggered auto-demote signal is P22-compliant as-is: no
  pool-wide ceiling exists to promote onto, so its heal is structurally exhausted at detection.)
- **Tier-1 fixtures (corrected):** EFFECTIVE relief across distinct targets gets its RATE relaxation (a
  legitimate bulk-relief burst under `totalCountCeiling` passes faster) BUT a distinct-target FLOOD past
  `totalCountCeiling` is still count-denied (folds ADV3-M1); `targetAlwaysRejects` (age-kill veto) IS bounded;
  **`accept-but-ineffective` (external-hog shape) is bounded at `perTargetBoundK`**; a controller keying
  `admit()` at a finer granularity than its registry model FAILS the target-granularity assertion;
  `respawn-recovery` fails OPEN and is never demoted-to-death / never dead-lettered by the governor; the
  auto-demote latch does not flap.

### `session-respawn` splits: recovery (relief) vs crash-loop (amplifying) (folds LA3)

A respawn has two identities. **`respawn-recovery`** — reviving a genuinely-dead REGISTERED autonomous run
(the ResumeQueue / liveness-reconciler path) — is RELIEF and rides the effective-relief bypass; the
governor must NOT sit as a fail-closed amplifying gate there (failing a recovery respawn closed-to-queue
under the very saturation that killed the run would strand it — constitution *An Autonomous Run Must Outlive
Its Session*). **`respawn-crashloop`** — a session that keeps dying and respawning — is AMPLIFYING and
bounded. They are distinct governor classes.

### Fail-direction is PER-CLASS + a global kill-switch that never wedges (folds R2, I4)

- Cost/safety classes (`spawn`-provider-passthrough aside, `swap`, `respawn-crashloop`) fail
  **CLOSED-to-QUEUE** on governor ERROR (the action is preserved, never dropped, never stranded);
  disruption-only classes (`notify`) fail **open-but-coalesce**. **Non-recovery RELIEF classes
  (`kill` / `reaper` / `session-close`) fail OPEN-WITH-AUDIT (folds INT5-2 / ADV5-1 — the policy table's
  former "n/a (relief)" was an omission wearing a decision's clothes; three of the four bypass-eligible
  verbs had NO defined error disposition).** The reasoning is deliberate: a governor error amid a reaper
  storm is the CORRELATED case, and both candidate answers are load-bearing and opposite — queueing
  relief livelocks it under the very saturation it answers (the round-1 relief-deadlock lesson), while
  fail-open rides a governor bug during a flood. Open wins because relief REDUCES pressure and the
  pre-governor status quo was unbounded anyway — but the fail-open is CONDITIONED on loudness AND
  carries a last-resort bound (folds ADV6-3/SC6-3 — an unbounded errored-open path is a standing induced
  bypass, cheaply reachable via a malformed config override throwing inside policy evaluation): (i)
  per-class config OVERRIDES are validated at LOAD — a malformed override falls back to the code default
  with an audit row, and can never throw inside `admit()`; (ii) the errored-open relief path carries a
  POLICY-FREE, code-constant LAST-RESORT rate floor — a dumb independent in-memory counter sharing none
  of the policy machinery that erred (the failure-minimal-enqueue pattern) — so a broken governor PACES
  relief instead of unbounding it (the paced rate is generous: it must never starve genuine relief, only
  deny pathological multiples); (iii) the governor's `errored` state raises an IMMEDIATE attention item —
  LEVEL-triggered once per errored EPISODE, dedupe-key `(governor, erroredEpisodeId)`, severity CRITICAL
  while any relief class is enforcing, max-notification-latency one funnel tick from episode open,
  remediation-action = the governor's own recovery to healthy (episode close), audit-location = the
  transitions audit's `errored-episode open/close` rows — the covering signal SEC8-2 leans on carries a
  durable trace, and a mint-collision resolving into this posture writes its own row (folds ADV9-2 field
  symmetry) (Standard B basis: the crashed-self-heal-machinery arm — the
  governor IS the heal machinery, so escalation-at-detection is the sanctioned last-resort path; folds
  INT6-2/ADV6-7/LA6-5); (iv) errored-path audit rows are RATE-BOUNDED — first-N verbatim rows per errored
  episode, then window-aggregated counts per (controller, window) (the dead-letter notice shape), so
  loudness never becomes storm-rate disk amplification (the telemetry section's own never-per-admit
  discipline). (`respawn-recovery` keeps its stronger unconditional fail-open with no audit-path
  dependency.) **`origin: 'principal'` is EXEMPT from the errored path entirely (folds SEC7-1 — the
  last-resort floor is deliberately a dumb counter that cannot read origin, so without this pin it would
  pace the operator's emergency mass-kill at the backstop rate during exactly the correlated storm):**
  principal-origin admission fails OPEN unconditionally, at `respawn-recovery` strength — no audit-path
  dependency, never routed through the errored-open relief path, never paced by the last-resort floor,
  and a throwing `principalAdmit` itself resolves OPEN — with the volume-anomaly counter as its only
  (still non-blocking) containment. **The last-resort floor is scoped to `origin: 'self'` and derived
  PER-CLASS (folds SC7-3 — the flat 1/5s illustrative value ≈ the 17.5k/day flood rate, i.e. it would
  pass the flagship storm unthrottled):** the floor is a small multiple of the class's own static floor
  per window (for `age-kill`, an order of magnitude tighter than 1/5s), and it is a multiples-only
  BACKSTOP — the CRITICAL per-episode errored alarm is the actual defense at 1× flood rate. No fail path
  bypasses-and-drops.
- **Global kill-switch (I4):** the master off-switch is a single `emergencyDisable`-style lever
  (`intelligence.selfActionGovernor.emergencyDisable: true`, read live) that degrades EVERY class to
  unconditional pass-through — surfaced by construction (see guard-posture below), following the
  `PermissionPromptAutoResolver` precedent rather than a plain `enabled` flag whose stale-`false` could
  silently re-disable a safety floor. **There is deliberately NO env-var override (folds INT3-M2):** the
  cited precedent has none precisely because the config-reading posture surfaces (`collectGuardPosture` +
  `GUARD_MANIFEST`) both read `.instar/config.json`, never `process.env` — an env-only disable would be
  posture-INVISIBLE, recreating the 2026-06-05 batch-disable blind spot the visibility fold exists to close.
- **A disabled/errored governor NEVER strands an emit site — but "never strand" is NOT "always allow"
  (folds SEC-M1 / ADV-M2 — corrects a v3 contradiction).** An un-stranded emit resolves to EITHER an
  **allow-token** (the DISABLED / kill-switched path, and observe-mode, and disruption-only `notify`) OR a
  **`queue` disposition** (an ENABLED cost/safety class whose `admit()` THROWS — preserved via the queue,
  never dropped, never stranded). The unconditional allow-token is scoped to the disabled/kill-switched path
  ONLY; it must NEVER cover an enabled cost/safety failure (that would re-open the R2 fail-open the whole
  class exists to prevent — an `admit()` throw under saturation is the storm condition itself).
- **The governor's own posture is visible to `GET /guards` + the Guard-Posture Tripwire (folds SEC-M2 +
  INT3-M2 — two NAMED wiring deliverables, because the deployed surfaces do not auto-cover `intelligence.*`).**
  A default-on chokepoint on ~23 controllers is itself a load-bearing guard; its `emergencyDisable` and each
  class's mode (observe / enforce / a `pool-shared` class stuck observe-only-but-load-bearing) must be
  reported and watched. **The polarity must be normalized (folds INT4-M1) — `emergencyDisable` is
  INVERTED (true = OFF), but `guardPostureView` reads a `configPath` as ENABLED-polarity (`false → off`) with
  no inversion field, so naming `configPath: '…emergencyDisable'` would render a HEALTHY governor as `off`
  (a false `loadBearingGap` on every agent) and a DISABLED one as `on-confirmed` (no tripwire item) — the
  2026-06-05 blind spot re-created.** So both deliverables mirror the `PermissionPromptAutoResolver`
  precedent verbatim (an inverted `emergencyDisable`-only guard surfaced correctly). Deliverable 1: add a
  `GUARD_MANIFEST` entry with a **SYNTHETIC enabled-polarity** `configPath:
  'intelligence.selfActionGovernor.enabled'` (`loadBearing: true`) so `GET /guards` (which iterates the
  manifest and already supports non-`monitoring.*` paths) registers the governor. Deliverable 2: add a
  hand-wired branch to **`extractGuardPosture`** (the deployed function; it enumerates only `monitoring.*` +
  `scheduler.enabled` + a `models.tierEscalation` branch) that COMPUTES the synthetic enabled posture as
  `enabled = emergencyDisable !== true` (absent ⇒ on) — the load-bearing job is this polarity normalization,
  not merely correct non-monitoring copy/category (which is also needed so the hardcoded "monitoring guard(s)
  disabled" title doesn't mislabel it). Then a disable raises the standard aggregated attention item ("a
  disabled guard is itself an incident" — the 2026-06-05 batch-disable lesson).
- **A flip of `emergencyDisable` is ITSELF an immediately-audited event (folds ADV5-9; notice contract
  hardened by INT6-2/LA6-5).** The governor reads the flag live, so it OBSERVES the transition instantly:
  any flip (either direction) writes a transitions-audit row AND raises an immediate attention item at
  flip time — carrying the config-write principal where the write came through an authenticated route
  (`principal: unknown(file)` for a direct file edit) — rather than waiting for the boot-time tripwire or
  the persistence-gated GuardPostureProbe. Notice contract (Standard B): the item is EPISODE-LATCHED with
  dedupe-key `(flipEpisodeId)` — N flips within a window collapse to ONE item enumerating the flip count
  + final state (a flapping config writer under pressure is literally the 2026-06-05 scenario; per-flip
  items would be the flood) — severity HIGH on the DISABLE direction (the dangerous one), routine on
  re-enable. P22 basis: this is a principal-action TRIPWIRE, not a healable degradation — the
  guard-posture standard's "nothing is ever auto-re-enabled" rule forbids the self-heal P22 would
  otherwise require, so escalation-at-detection is the sanctioned path.
  This is the one kill-switch in the fleet whose activation is the DANGEROUS direction (it disarms the
  flood brake rather than stopping an actor), and the 2026-06-05 precedent is the agent ITSELF
  batch-disabling guards under exactly the pressure this governor targets.
- **Numeric neutering is as visible as a flag flip (folds SEC5-2).** A sparse per-class config OVERRIDE of
  a ceiling/rate joins the transitions-only audit (`policy-override change`, old → new, principal where
  known), and every class's posture row in `GET /self-action-governor` (and the `/guards` projection)
  carries an `overridden: true` marker with the ceiling-vs-default ratio — so a class "enforcing" with its
  ceiling cranked to a vacuous value reads as loudly as a disabled one (the same emergency-load-shed hand
  that batch-flips flags can crank numbers instead; both must be visible).

### AMPLIFYING classes: the governor owns the safety decision (folds SEC3, A4, S5)

- The `projectPressure()` callback returns ONLY a raw reading `{ value, asOf, confidence }`. The DECISION —
  deny-on-stale, pessimism-floor, hysteresis — lives INSIDE the governor (structure, not willpower: a
  buggy/lazy callback cannot bypass the gate — SEC3).
- Projection is a ONE-WAY TIGHTENER layered on the governor-owned BASE ceiling (count + rate + breaker): it
  can only make admission MORE conservative, never widen it, so a wrong-optimistic reading can never escape
  the base bound (A4). Amplifying classes ALWAYS also carry the base count+rate+breaker.
- `admit()` NEVER initiates a poll — it reads only the last cached background poll (the registry
  `staleQuotaReading` model) and denies when that reading is stale (S5; else a swap storm becomes a
  quota-poll storm and adds provider latency to the hot path).

### Resource scope PER-CLASS + pool-shared enforce is GATED on the pool-wide ceiling (folds the dominant consensus: LA4, SEC5, A5, I3, D2, codex-C4, gemini-G2)

- Each class tags `resource`: **hardware-bound** (host cores/process count → machine-local) vs
  **pool-shared** (account quota → cross-machine).
- **`spawn` (LLM-subprocess concurrency) STAYS at the provider layer** (the `host-spawn-semaphore`); the
  governor does NOT re-acquire it. `session-respawn` (controller-layer) is its own class.
- **`swap` / `notify` are `resource: pool-shared`.** On a MULTI-machine pool a machine-local ceiling is FAKE
  protection (two machines each "within bound" still blow one shared account — the exact swap-thrash
  resource). Therefore:
  - **The observe→enforce flip gate is RESOURCE-AWARE (STRUCTURAL, not prose):** a `resource: pool-shared`
    class MUST NOT graduate past observe until the applicable **sum-of-leases ceiling** is the enforcement
    target. **Machine-count carve-out (folds INT-M1):** when the pool is a SINGLE machine (`N=1`) the
    machine-local ceiling IS the pool-complete ceiling, so a single-machine agent flips normally. The "never
    machine-local enforce" rule bites only when pool size > 1. **`N` is the REGISTERED-machine count
    (`MachinePoolRegistry.listMachines().length`), NOT the online-peer count (folds INT4-M2):** keying on
    currently-online peers would leave a pool-shared class in the `N=1` machine-local-enforce carve-out
    whenever the other machine is merely asleep (the steady state for a laptop+Mini pool) — an enrolled peer
    waking could blow the shared account before a presence-pull re-demoted, and the class would oscillate
    enforce↔observe with sleep/wake. The gate is **LEVEL-triggered on the registered count (folds INT3-M1):**
    the moment registration crosses `1 → >1` (a second machine enrolled — a first-class encouraged flow) a
    pool-shared class enforcing via the `N=1` carve-out AUTO-DEMOTES to observe (raising the
    guard-posture/attention signal) until the pool-wide ceiling exists; it re-promotes to the carve-out ONLY
    on genuine DE-ENROLLMENT (a peer removed from the registry), NEVER on a peer going offline — so a routine
    enrollment can never silently convert a real bound into fake protection. **Level-evaluation read
    discipline (folds SC5-2):** the per-class enforce/observe MODE consulted by `admit()` is a cached
    in-memory flag; the registered-count LEVEL is re-evaluated OFF the hot path — on registration-change
    events and the existing slow presence/heartbeat tick — never per-admit (grounded: the pinned source,
    `MachinePoolRegistry.listMachines()`, delegates to a per-call `readFileSync` + `JSON.parse` in the
    deployed dist — sync disk I/O that would break `admitSync`'s zero-I/O guarantee if evaluated inside
    the admit path; boot-only evaluation is equally wrong, missing a mid-flight enrollment).
  - **Read discipline on the admit hot path (folds SC-M2):** `admit()` for `swap`/`notify` reads the sum-of-
    leases ceiling from a LOCALLY-CACHED lease-slice with bounded staleness — the same never-poll-on-admit
    rule as `projectPressure`, extended cross-machine — NEVER a synchronous cross-machine fan-out (which
    would reintroduce the poll-storm cross-machine and break `notify`'s sync fast path). This resolves S6:
    `notify` stays sync via the cached slice. The residual cross-machine over-admission slack from a cached
    read is the atomicity build sub-task.
  - **Substrate: COMPOSE the SHIPPED sum-of-leases modules behind a NEW wiring gate (folds CX3-3 / GX3-1 /
    INT4-M3 — RE-GROUNDED by LA5-1 against dist v1.3.780; SUPERSEDES v6's "build a standalone store").**
    v6 chose "build a standalone durable multi-machine store, informed by the grant-ledger pattern" on the
    stated premise that no shippable sum-of-leases primitive existed ("`AccountFollowMeSpendSlice` is itself
    spec-stage; only `WalledEnrollmentOffer` exists in src"). Round 5 verified that premise is now FALSE
    against the round-5 grounding authority: the deployed dist ships `core/AccountFollowMeGrants.js` (the
    durable sum-of-leases grant ledger — single-use grants, lease-epoch fencing, failover re-derivation so
    a new holder cannot double-allocate) and `core/AccountFollowMeSpendSlice.js` (`SliceIssuer` fenced
    single-writer issuance, `SliceRenewalControl` with per-account rate-cap + coalescing + P19 breaker, and
    a fail-closed `decideAccountUse` that falls back to the machine's own account on any uncertainty) —
    deliberately PURE + injectable ("the distributed math is unit-testable without a live mesh");
    `WalledEnrollmentOffer` exists nowhere in the shipped package — the v6 parenthetical was wrong on both
    ends. **Shipped-state honesty (folds LA6-1 — "dark only at wiring" was itself too generous):** the
    modules are pure + UNWIRED — no RUNTIME import of either module exists anywhere in dist (folds
    LA7-1, precision by ADV8-4: the only dist references are MeshRpc's unwired deny-by-default
    `authorizeSliceRenew` seam, `?? false`, with `SliceIssuer` comment-only, plus ONE type-only
    declaration-file import that erases at runtime — no caller ever wires either module); the ONLY grant
    store shipped is `inMemoryGrantStore` (the module's own header: "production wires a durable
    JSON/SQLite store … the fenced-lease HOLDER election + the live placement wiring are
    integration-layer (later PR)"). The MATH is delivered; the DEPLOYMENT is not — in particular, failover
    re-derivation's no-double-allocation property holds only over a durable, holder-shared store, which
    does NOT ship. Building a SECOND sum-of-leases implementation alongside the shipped math would still
    be dual accounting over the same shared-account safety ceiling — a drift risk, and exactly the
    reinvent-existing-infrastructure pattern the lessons index forbids. So B **COMPOSES the shipped
    modules** behind a NEW, governor-owned wiring gate (`intelligence.selfActionGovernor.poolCeiling` — NOT
    `multiMachine.accountFollowMe`), which satisfies the original decoupling requirement (not hostage to an
    unrelated dark flag) WITHOUT duplicating safety-accounting math. Of the review constraints v6 pinned
    for the deferred <!-- tracked: CMT-1911 --> store, the MATH-level halves are ALREADY IMPLEMENTED in the shipped classes and are
    CITED rather than re-specified: integrity fencing + failover re-derivation (the grant ledger),
    write-side renewal control with P19 breaker + per-account rate-cap (`SliceRenewalControl`),
    fail-conservative-on-uncertainty (`decideAccountUse`). **Single issuance authority per account (folds
    SEC6-3 — the dual-accounting risk FD15 kills can return via dual INSTANCES):** `SliceIssuer` is
    per-instance state and the ceiling is a per-call argument, so when BOTH `accountFollowMe` AND
    `poolCeiling` gates are on, two independently-constructed issuers over separate stores would each
    enforce the full account ceiling → up to 2× over-allocation. Invariant: per account there is ONE
    grant-ledger store + ONE fenced issuer regardless of which wiring gates are on — the governor is a
    slice CONSUMER against the same ledger `accountFollowMe` issues from (or the ceilings are explicitly
    partitioned) — with a test that both-gates-on yields ONE shared outstanding-total. **Ledger hygiene
    (folds LA6-2 — the shipped ledger itself violates this spec's parent principle: `issue()` grows the
    grant map monotonically, nothing deletes/compacts, every mutation rewrites the FULL map; fine for
    rare credential-share grants, quadratic-I/O on a recurring renewal cadence):** terminal-state grants
    (consumed / released / expired past the largest window) are pruned/compacted on a bounded cadence,
    the composed renewal cadence is derived from slice TTL (never the 5 s control-plane
    `minInterval` floor), and a Tier-1 fixture drives N renewal cycles asserting ledger size stays
    O(outstanding), not O(history). **Denomination mapping (folds LA6-3):** the shipped slice `amount` is
    denominated in provider quota-FRACTION (0..1) while the governor's pool-shared ceiling is ACTION
    COUNTS per window — the count-budget ↔ slice-amount mapping and window ↔ TTL alignment (slices free
    on expiry, not window boundaries) are a named part of the governor-side integration review. The
    RESIDUAL deferred-review/build scope <!-- tracked: CMT-1911 --> (still its own review before any pool-shared enforce; fleet
    observe-only until then; `N=1` enforce needs none of it) is therefore: (1) a DURABLE grant-store
    implementation (atomic temp+rename or SQLite, per the module header's own note) + the ledger-hygiene
    constraint above, (2) the holder-side `slice-renew` handler constructing `SliceIssuer` + wiring
    `authorizeSliceRenew`, (3) the requester-side renewal transport loop around `SliceRenewalControl`,
    (4) the new wiring gate + its guard-posture surface, (5) the replication path for slice state (likely
    a `stateSync`-family entry), (6) the governor-side cached-slice read integration (SC-M2) + the
    denomination mapping, and the following constraints as they apply to the COMPOSED deployment —
    **enforced at RUNTIME, not only at review (folds codex-r6):** pool-shared ENFORCE is a hard runtime
    gate on lease-replication health + mode coherence + clock-skew posture being green; any of them
    degrading auto-demotes the class to observe (the same level-triggered demote machinery as FD9):
    - **Integrity (folds SEC4-M1):** cross-machine lease claims authenticated + incarnation-fenced +
      forged-origin-rejected (the WS5.2 / WS2 replicated-store posture); a stale / unverifiable / dark peer
      contribution fails toward the CONSERVATIVE direction (count the peer as consuming its FULL lease
      allocation → tighten admission), NEVER under-count — the same deny-on-stale / un-confirmable→closed rule
      the spec binds on `projectPressure` and non-convergence, extended cross-machine.
    - **Consistency envelope (folds CX3-4/GX2):** a bounded max-stale interval, a max-over-admission formula,
      TTL behaviour under partition, and a stale / unreadable lease-authority read that fails toward OBSERVE
      (never enforce-on-stale); a corrupt lease ledger fails toward observe, with a migration/backup story.
    - **Write-side hot-path discipline (folds SC4-m1):** per-admit lease CONSUMPTION is an IN-MEMORY decrement
      against the locally-held slice (mirroring the in-memory telemetry counters) — the durable publish of this
      machine's lease level / renew / refill happens OUT-OF-BAND on the same bounded flush cadence, NEVER a
      per-admit durable write, so `notify`'s zero-I/O `admitSync` guarantee holds (the cross-machine publish
      lag folds into the over-admission slack, not a new axis; `swap`'s async ~8/45min write is fine).
    - **Replication + writer authority (folds INT4-M3):** the store owns its cross-machine replication (likely a
      new `stateSync`-family entry) and binds single-writer authority to the FencedLease captain, with a
      failover story (a lease hand-back / stale-owner claim moves the writer mid-flight).
    - **Clock assumption (folds gemini-clock):** the TTLs (token, `staleTtlMs`, lease) assume host clocks synced
      (NTP) within a tolerance well under the shortest TTL; instar's mesh already tracks clock-skew status
      (`GET /pool`), which the lease authority reads to widen its margin or refuse enforce under skew.
    **Tradeoff (folds GX3-2 / gemini-r5):** an in-house best-effort lease-slice (now the SHIPPED
    grant-ledger modules, composed) is chosen over an industry distributed counter (Redis/etcd atomics)
    deliberately — a core in-process SAFETY path must add NO new external service dependency; the
    bounded-staleness slack is acceptable precisely because the enforce flip is separately review-gated and
    the fleet ships observe-only until then. (gemini-r5's suggested future path — an OPTIONAL pluggable
    external backend for deployments that already operate one — is noted as a non-blocking extension point
    behind the same slice interface.)
  - **Pool-shared enforce-MODE is a pool-coherent dimension (folds INT5-4).** The per-class observe/enforce
    mode is per-machine config, so a pool-shared class enforced on machine A but observe (or demoted) on B
    would leave B admitting unboundedly against the shared account — the exact "two machines each 'within
    bound' still blow one account" failure, silently halved: the sum-of-leases ceiling only binds machines
    that enforce. **Mechanism corrected by INT6-1 (the v7 text cited the wrong module):** grounded against
    dist v1.3.780, the machine-coherence sentinel's compared dimension is built EXCLUSIVELY from
    `COHERENCE_CRITICAL_FLAGS` in `machineCoherenceManifest.js` (`buildCoherenceFlags()` iterates only
    that array); `GUARD_MANIFEST` feeds only `GET /guards` — there is NO bridge, so the §Fail-direction
    guard-manifest deliverable covers the posture surface but makes NOTHING coherence-compared. The fold
    is therefore TWO explicit new rows in `COHERENCE_CRITICAL_FLAGS`: (a) a governor row with
    special-cased INVERTED resolution (`emergencyDisable === true ? 'off' : 'live'` — the
    `meshTransport.enabled` row is the shipped inverted-default precedent), and (b) per-class mode rows
    for `resource: pool-shared` classes with clamped scalar values `observe|enforce|demoted` (the
    non-boolean `sessionPool.stage` row is the shipped scalar precedent; values fit `MC_VALUE_ALPHABET`;
    feasible — ~18 of `MC_MAX_ENTRIES=64` rows used, and a manifestHash change during a rolling update is
    already classified as version skew, not phantom flag skew). Cross-machine mode skew on a pool-shared
    class then raises the standard machine-coherence alarm; the FD8 flip procedure for a pool-shared
    class is stated as per-POOL (the operator flips each machine within one maintenance window — the skew
    alarm is the backstop, not the procedure). **The `demoted` value source is a NAMED deliverable (folds
    INT7-1/LA7-2 — the shipped advert view is CONFIG-only: `{ boot, liveGet }` reads config paths, and
    `observe|enforce` are config-readable but `demoted` is governor RUNTIME latch state no shipped row
    resolves; a config-only build would advertise `enforce` on a runtime-demoted machine and defeat the
    alarm):** the same-PR coherence deliverable extends the caller-injected view with a governor-state
    accessor (purity preserved — the view is already injection-constructed at the advert builder's
    caller) and declares the mode rows `readSource: 'live'` against it; the deliverable ALSO includes the
    manifest-size-ratchet + membership-drift unit-test updates (folds INT7-4 — the failing ratchet is the
    guard working; the companion declares the change so it is never a surprise CI round). **Two-channel
    interplay pinned (folds LA7-3):** a mid-heal runtime demote of a pool-shared class on ONE machine
    produces an `enforce`-vs-`demoted` coherence row that confirms in ~2 beats — BEFORE the governor's
    own P22-gated exhaustion alarm — and this is ACCEPTED as the sanctioned multi-machine surfacing of a
    standing halved-guarantee divergence (one machine admitting unboundedly against a shared account IS
    operator-relevant now, not after N cooldowns); the two channels dedupe independently.

### Runtime telemetry: in-memory aggregates, lock-free read, posture-split, scrubbed (folds S1/S2, S3, I2, SEC6)

- **Counters are IN-MEMORY monotonic aggregates** (admits / coalesces / queues / denies, breaker state,
  non-convergence trips), flushed to disk on a BOUNDED CADENCE (interval/debounce), **never per-admit** — so
  `admitSync` stays truly zero-I/O and a 17.5k-actions/day storm can't become disk amplification. They are
  fixed-size keyed aggregates updated IN PLACE (atomic temp+rename), NOT an append stream. Restart loss
  window = the last unflushed interval (a stated tradeoff — the flip gate reads these counters, so the
  cadence bounds staleness). A SEPARATE per-event audit records TRANSITIONS ONLY (breaker open/close,
  non-convergence trip, class enforce-flip, policy-override change, emergencyDisable flip, restart-shed,
  enqueue-terminal drop, relief demote/re-promote latch transitions, dead-letter shed, state-reset /
  rehydrate anomaly, census clamp hit, principal-volume-anomaly episode, observe-limbo nudge,
  errored-episode open/close, mint-collision — the
  enumeration is the builder's list, so every row type a notice contract cites as its audit-location
  appears here explicitly; folds LA6-4/ADV8-2/ADV9-2), retention-bounded (the
  `FeatureMetricsLedger.retentionDays` precedent). One deliberate per-EVENT carve-out (folds ADV8-2): the
  principal lane's always-audited rows are per-admit by design — volume-safe by construction at
  human-action rates, and the point of the lane's audit — named here explicitly so the transitions-only
  discipline is not silently violated. The
  transitions audit file is machine-local — `machine-local-justification: hardware-bound-resource` (it
  records THIS host's governor transitions; pool-wide class-state questions are served by the
  `?scope=pool` posture read) — folds INT5-5. **Every non-allow verdict is EXPLAINABLE (folds gemini-r5):**
  the aggregates are keyed per class AND per DECIDING SUB-MECHANISM (per-target ceiling / total ceiling /
  census scale-down / rate bucket / breaker / stale-projection / queue-full / lane-floor), and a
  queued/coalesced/denied `Admission.reason` NAMES that sub-mechanism — an operator debugging "why was
  this held?" reads the deciding layer directly instead of reverse-engineering five interacting bounds.
  A post-restart non-allow whose window includes REHYDRATED pre-restart admissions says so in the reason
  (folds codex-r7 — durable counts + forgotten intents is coherent but reads as "nothing happened and I'm
  still throttled" unless the reason names the rehydrated state).
- **`GET /self-action-governor` reads the in-memory aggregate map LOCK-FREE + WRITE-FREE** — the
  `/test-runner-limiter` "PURE read" precedent, NOT `/spawn-limiter` (whose `status()` takes a file lock and
  WRITES on every GET; mirrored across ~23 stores a single dashboard poll would contend the very locks
  `admit()` takes and starve admissions during the storm). The route never acquires an `admit()` lock.
- **Multi-machine posture SPLIT:** hardware-bound class counters are machine-local
  (`machine-local-justification: hardware-bound-resource`); pool-shared class (`swap`/`notify`) counters are
  exposed POOL-WIDE via the existing `?scope=pool` fan-out (the `PoolPollCache` pattern already serving
  `/guards` / `/subscription-pool`) — so the observability boundary matches the resource boundary and "is my
  FLEET thrashing one account?" is answerable.
- **Route projection is SCRUBBED (SEC6):** aggregate per-class counts + breaker/verdict state ONLY; target
  identities (account ids, session/topic names) and absolute quota values are NOT emitted (derived pressure
  verdicts only) — the observability-non-leak posture the sibling read routes hold.

### Queue is bounded and re-admitted at drain (folds codex-C3, A6)

The `queue` outcome is bounded on BOTH axes (folds codex-C3, A6; COMPLETED by SC5-1 — the v6 text capped
the wrong axis): same-`targetKey` entries COALESCE, so the per-`(controller, target)` lane depth
(`queueMaxDepth`) holds ~1 live intent and mainly bounds pathological non-coalescible opts — while the
DISTINCT-TARGET axis, the real growth axis ("depth bounded by DISTINCT targets" — which two prior folds
route overflow INTO: the fan-out corner fails closed-to-queue, and FD2 routes enabled cost/safety errors to
queue), carries its own per-controller ceiling **`queueMaxTargets`** (mirroring `perTargetEvict.maxEntries`):
a new distinct target arriving at a full queue takes the SAME loud dead-letter shed as `maxReadmitCycles`
exhaustion — the ADV3-M1 distinct-target flood cannot re-materialize inside the governor's own buffer, and
drain work stays O(queueMaxTargets × maxReadmitCycles), a capacity bound, not just a flow bound. Queue
age/depth/distinct-target metrics join the aggregates.

**Drain re-validates EVERYTHING, not just governor-side pressure (folds ADV5-4).** Every queued action is
re-admitted / re-projected at DRAIN (never fired blind against changed conditions — e.g. a reactive swap
whose account has since recovered) — AND handed back to the CONTROLLER's own eligibility predicate before
firing: drain re-derives the target via the controller's canonical `deriveTargetKey(ctx)` and re-checks the
action's precondition (is the session still over-age? the hog still hot? the target still dead?). Each
queued intent also carries an INCARNATION FENCE captured at enqueue (the target's incarnation id where one
exists — session uuid, pid — even when the POLICY key is the stable class): drain REJECTS on fence mismatch
(an audited drop — the original target is gone; a level-triggered condition that still holds re-fires on
its own). **Unpinned-fail-direction pin (folds ADV6-6):** when BOTH safety legs are unavailable at drain —
a target class with no incarnation id AND an eligibility predicate that THROWS or is un-evaluable — the
disposition is an AUDITED DROP, never fire-blind (safe by the same construction: every queue-eligible
class is level-triggered, so a condition that still holds re-fires). This closes the wrong-kill window the queue would otherwise CREATE: instar session names are
stable per topic across respawns, so without the fence a queued `age-kill` drained after the window slides
would fire on the CURRENT young, healthy incarnation — a kill immediate emission would never have produced,
made MORE likely by the deliberate volatile-key→class collapse. Drain order: interactive before jobs, FIFO
within, with fairness via **AGE-BASED PROMOTION (pinned as the default — folds DC5-1/CX4-5;** a reserved
drain slice is the config-overridable FD11-class variant — age-based promotion degrades gracefully at small
queue depths where a reserved slice fragments capacity): a sustained interactive storm cannot indefinitely
starve recovery/maintenance-class drain.

**Crash semantics: queued intents are in-memory BY DESIGN, with restart honesty (folds INT5-1 / SEC5-3).**
Queued intents deliberately do NOT survive a process restart, and this is safe BY CONSTRUCTION of the
queue-eligible set: every class that can queue is LEVEL-triggered — a reactive swap re-fires on the next
rate-limit event, a crash-loop respawn is re-detected by the reconcilers, an age-kill re-derives from the
still-over-age session — so a restart REGENERATES any intent whose condition still holds (and correctly
forgets one whose condition died with the process). What must never be silent is the LOSS EVENT itself:
the flushed aggregates carry the last-known queue population, and ANY boot with a non-zero last-known
population writes ONE `restart-shed` transitions-audit row (count + classes + a clean/unclean tag —
folds INT6-5: a CLEAN shutdown, an update restart, or the loop's own `restart-all` sheds queued intents
identically, so scoping the row to unclean boots would make the COMMON path a silent shed; the graceful
path, which now flushes on shutdown per FD14, records its final shed itself). Per-intent reporting after
a crash is impossible and stated so. No durable queue file exists → no
BackupManager decision and no separate posture declaration (the aggregates already carry one). ADMISSION
state is the durable half — see §"Load-bearing bound" (FD14).

**The enqueue path itself is failure-minimal, with a DEFINED terminal (folds SC5-3).** FD2's
closed-to-QUEUE guarantee is only as strong as the enqueue under the correlated failure (an `admit()`
throw under OOM-class saturation is exactly when a heavyweight enqueue also fails): the fail-closed
enqueue path is minimal and independent — pre-allocated slot, no policy evaluation, no I/O — and if even
it fails, the action is dropped WITH a policy-free audit row + an attention signal: a DEFINED, audited
terminal ("never a SILENT drop" is preserved as never-UNDEFINED, honestly not as never-drop). **The
signal is funnel-bound (folds INT6-2/ADV6-7):** under the correlated OOM saturation this terminal fires
in BULK, so the attention signal folds into the existing dead-letter per-(controller, window) coalesced
notice as a distinct `enqueue-drop` class — never per-drop sends.

**Honesty (folds ADV-m5):** "fail-to-QUEUE, never drop" means never a SILENT drop — it does NOT guarantee
the action eventually FIRES. Under sustained pressure a re-admitted action keeps re-denying, the queue
fills (on either axis), and the oldest coalesced intent DEAD-LETTERS — a LOUD shed, not an eventual-fire
promise. A `maxReadmitCycles` bound caps re-admission so drain can't thrash the CAS lock against live
admits. **Dead-letter notice contract (Standard B — folds INT5-3):** dead-letters ride the P17/aggregated
funnel — ONE coalesced notice per (controller, window) enumerating the shed (count + classes + oldest
age), NEVER per-intent sends (the shed must not become the notification flood the primitive prevents);
dedupe-key = `(controllerId, windowId)`; max-notification-latency = one funnel tick (≤ 120s) from the
window's first shed; severity class is PER-CLASS — a dead-lettered `swap` intent (a session potentially
stranded at a quota wall) escalates HIGH on the same tick with the heal running concurrently, while a
coalescible/notify shed is `recoverable` (funnel-coalesced); remediation-action = the bounded
re-admit/drain cycle itself; audit-location = the transitions audit (every shed row).

### Enforcement path (Structure beats Willpower)

The #1376 `lint-no-unregistered-self-action.js` already forces registration. This spec adds a second
assertion — **`emit-without-admit`** — failing the build for a registered controller that fires without
routing through `admit()`, AND asserting the callsite's controller IDENTITY (folds SEC5-1/ADV5-8): the
per-controller handle's id must equal the file's `@self-action-controller` marker id, and a raw
string-keyed `governor.admit(controllerId, …)` at an emit site is forbidden — the controller id selects
policy INCLUDING the privileged lanes, so it is bound at registration, never caller-chosen (grounded: the
deployed lint validates only marker EXISTENCE, and the registry's `models:` reverse-pointer is
documentation-only — without this binding, "cannot skip the ceiling by construction" was overstated). The
lint enforces the CALL + the IDENTITY; the compile-time `AdmissionToken` type enforces HONORING the
verdict; the Tier-3 inventory pins sink-side identity. Together, a future self-action cannot skip the
ceiling — or borrow a looser class's ceiling — by construction.

### Why a bespoke primitive (folds gemini-G1)

Justifying the custom `SelfActionGovernor` over off-the-shelf libraries (`token-bucket`, `opossum`): it is
in-process with **no new external dependency** (a core SAFETY path must not add supply-chain surface); it is
COUPLED to the existing `boundK`/`perTargetBoundK` registry contract and the convergence ratchet that
already proves those bounds; it must honor the `eternalSentinel` rate-floor and GENERALIZE (not re-acquire)
the host-spawn-semaphore; and it needs the three-way, P17-preserving `Admission` a generic breaker doesn't
model. The novel non-convergence logic is the least-proven part — which is exactly why v4 demotes it to a
supplementary signal and covers it with dedicated Tier-1 tests. **Internal alternatives considered (folds
CX5):** instar's existing durable queues (`PendingRelayStore`, the `ResumeQueue`) are domain-specific
*durable-work* queues, not an in-process *admission* funnel — they cannot host a synchronous `admitSync`
fast path or the per-controller count/rate/breaker policy — so the governor is the right home, but it
COMPOSES smaller, independently-testable internal primitives (token-bucket, P19 breaker, count-ceiling,
bounded queue) behind one contract (folds GX3), rather than being a monolith; the external `Admission`
contract is unaffected by that internal decomposition. **Alternatives weighed (folds codex-r5):** an
embedded durable log / SQLite-WAL store (durability the intent queue deliberately doesn't need — see
§Queue crash semantics — at the cost of write amplification on `admitSync`); actor-mailbox admission
(serializes per-controller but models neither cross-controller count ceilings nor the three-way
P17-preserving contract); mature in-process limiter libraries (`token-bucket`/`opossum` — effectively the
composed internal primitives, minus the registry coupling and the eternal-sentinel/relief semantics).
Local composition of already-tested internal primitives behind the one `Admission` contract remains the
choice, with each internal piece independently replaceable. (codex-r7: the normative companion carries
the fuller three-option comparison — external coordinator vs composed shipped modules vs
observe-only-forever — across failure domains, testability, recovery, and operator burden, weighing
operational risk against bespoke-correctness risk explicitly.)

## Decision points touched

- Introduces a new gate on the self-action path (`admit()` can return `coalesce` / `queue` / deny).
  Mitigation: observe-only rollout ladder (FD1); per-class fail-direction never bypasses-and-drops (FD2);
  effective-relief bypass, not a blanket relief exemption (FD5); a global kill-switch that degrades to
  pass-through and never wedges an emit site (FD2/I4); default ceilings bite only under *sustained*
  pressure.

## Open questions

*(none)*

> Q1→FD8, Q2→FD10, Q3→FD9 — all three prior open questions were resolved into Frontloaded Decisions
> (author-decidable: a rollout-unit choice, a reactive-coverage confirmation, and a scoping decision).

## Frontloaded Decisions

- **FD1 — Observe-only first.** `admit()` runs and RECORDS would-deny verdicts on every self-action for a
  soak, blocking nothing, before any class flips to enforce.
- **FD2 — Fail-direction is PER-CLASS + a non-wedging global kill-switch.** An ENABLED cost/safety class
  whose `admit()` THROWS fails **CLOSED-to-QUEUE** (never allow, never strand — an `admit()` throw under
  saturation IS the storm condition); disruption-only classes fail open-but-coalesce; **non-recovery
  RELIEF classes (`kill`/`reaper`/`session-close`) fail OPEN-WITH-AUDIT (folds INT5-2/ADV5-1)** — a broken
  governor must never block relief, conditioned on the immediate errored-posture alarm + audit (first-N
  verbatim rows per errored episode, then window-aggregated — folds SC7-1: the earlier "per-emit" wording
  here was superseded by SC6-3), paced only by the SELF-origin per-class last-resort floor;
  `origin: 'principal'` is exempt from the errored path entirely (fails OPEN unconditionally — folds
  SEC7-1). The fail-closed ENQUEUE path is minimal/policy-free, with a DEFINED double-failure terminal:
  audited drop + attention signal (folds SC5-3). The master off-switch is
  `intelligence.selfActionGovernor.emergencyDisable: true` (read live), which degrades every class to
  unconditional pass-through and yields an allow-token — the ONLY path that unconditionally allow-tokens —
  and whose FLIP (either direction) is itself an immediately-audited attention event (folds ADV5-9).
  "Never strand" = allow-token (disabled/kill-switched path only) OR `queue` (enabled cost/safety error)
  OR open-with-audit (relief error) — it is NOT "always allow." (Matches §"Fail-direction".)
- **FD3 — Default ceiling for an unpolicied class** is conservative-but-generous (bites only under sustained
  pressure), reversible per-class in config.
- **FD4 — Reuses, does not replace:** the host-spawn-semaphore stays the provider-layer concurrency
  primitive (never re-acquired); P17 stays the notify coalescer.
- **FD5 (v4, CORRECTED) — Relief bypass relaxes only the RATE; the COUNT ceiling is a hard floor for every
  count-bound relief class.** Bypass eligibility is a CLOSED declared de-escalation set `{kill, reaper,
  session-close, respawn-recovery}` (swap/notify are non-relief). Within it, the RATE relaxation is earned by
  governor-owned, causally-attributed pressure-reduction (acceptance never suffices); `perTargetBoundK`/
  `totalCountCeiling` bind at all times (incl. a distinct-target FLOOD past the total ceiling), so ineffective
  relief (veto OR accept-but-respawn) is caught by construction — CONTINGENT on the target-granularity
  invariant (runtime `targetKey` = model target granularity, ratchet-checked). The two COUNT-EXEMPT classes
  are named: `respawn-recovery` (rate-floor-only, fails OPEN, give-up delegated to the ResumeQueue cap +
  liveness-reconciler P19) and `eternalSentinel` (rate-floored per FD7). Round-5 hardening: exempt-lane
  MEMBERSHIP is an enumerated lint-bound allowlist with a registry-declared, fixture-driven
  `delegatedGiveUp` authority per member + a code-constant floor on `rateFloorMs` (folds ADV5-3); the
  relief `totalCountCeiling` is CENSUS-SCALED with a named degraded behavior + operator valve (folds
  ADV5-2); auto-demote is latched, its alarm P17-coalesced AND gated on heal EXHAUSTION per P22 (folds
  LA5-2/INT5-3 — a transient demote→re-promote cycle is audit-only, never an operator ping).
- **FD6 (v3, extended v7) — Capability token is opaque, `(controllerId,targetKey,class,nonce)`-bound,
  TTL'd, and compile-time typed** (protected emit sinks require the `AdmissionToken` type); emit sites
  hold a PER-CONTROLLER HANDLE minted at registration (raw string-keyed `admit()` lint-forbidden) and
  sinks pin their expected controller identity module-side (folds SEC5-1/ADV5-8).
- **FD7 — `eternalSentinel` classes are rate-floored, never count-bounded** (honor `rateFloorMs`, or the
  default deny-fast starves liveness heartbeats).
- **FD8 (Q1 resolved) — Rollout unit is PER-CONTROLLER:** each class flips observe→enforce independently
  once its convergence test is green (mirrors the defer-guard per-class-mode lesson).
- **FD9 (Q3 resolved) — Pool-shared enforce is GATED on the pool-wide ceiling, with an `N=1` carve-out:**
  `resource: pool-shared` classes ship observe-only and may not flip to enforce until the pool-wide
  sum-of-leases ceiling is the enforcement target — EXCEPT at `N=1`, where the machine-local ceiling IS the
  pool-complete ceiling (the existing `N=1 ⇒ scope:'pool'` collapse), so a single-machine agent flips
  normally. The rule "no machine-local enforce of a pool-shared resource" bites only when pool size > 1,
  where `N` is the REGISTERED-machine count (not the online-peer count — folds INT4-M2). The flip gate is
  **LEVEL-triggered on the registered count (folds INT3-M1):** when registration crosses `1 → >1` (a second
  machine is enrolled), a pool-shared class enforcing via the `N=1` carve-out AUTO-DEMOTES to observe
  (raising the standard guard-posture/attention signal) until the pool-wide ceiling is available; it
  re-promotes to the carve-out only on genuine DE-ENROLLMENT, never on a peer going offline — so a routine
  enrollment can never silently convert a real bound into fake protection.
- **FD10 (Q2 resolved) — `swap` covers BOTH proactive and reactive admission:** the reactive path admits to
  `queue` (fail-to-QUEUE, never drop). Increment A owns the deeper cure (decouple swap from restart); B
  bounds the reactive path.
- **FD11 — Per-class numeric defaults are conservative, config-overridable CODE constants** evaluated in
  observe mode (the flip-gate soak-window + would-deny-rate floor, non-convergence N, `projectPressure`
  `staleTtlMs`, the FD3 default ceiling): the gate LOGIC is buildable now; the enforce FLIP itself stays the
  operator's action (FD1 ladder). (Folds D3/D5.) Illustrative FD11-class defaults for the round-5/6-added
  constants (folds DC6-1 — table symmetry with the ~60/3/5 siblings): census fraction `k` ≈ 15%;
  `censusAbsoluteMax` ≈ 4× the configured session cap; `queueMaxTargets` ≈ 64 (mirrors
  `perTargetEvict.maxEntries`); `rateFloorMs` code floor = 300,000 ms (within an order of magnitude of the
  deployed sentinel's 3,600,000 ms); demote-alarm exhaustion N = 3; eager-flush admission-delta ≈ 10
  admissions; flip-episode latch window ≈ 10 min; errored-audit first-N ≈ 20 (folds DC7-1). **Two
  deliberate EXCEPTIONS to FD11 config-overridability (folds ADV7-1/DC7-2/SEC7-3):** (a) the LAST-RESORT
  errored-path floor is NOT config-overridable — a hard code constant (derived per-class as a small
  multiple of the class's static floor per window, at most TIGHTENED in code releases) whose evaluation
  path reads NO config; it is definitionally the bound that must survive policy/config-machinery failure,
  and a well-formed-but-vacuous override would re-open the ADV6-3 bypass one config key away; (b)
  `censusAbsoluteMax` is a governor-owned constant — the session-cap-derived value may only TIGHTEN below
  the hard code ceiling, never widen it, and any override rides the SEC5-2-audited per-class surface
  (never a live read of a foreign config key, which would sit outside the audited-override visibility).
  Companion-pinned illustratives (folds DC8-1/DC8-2): the per-class last-resort floor multiple ≈ 3–5× the
  class's static floor per window (the code constant's only calibration surface, so the companion states
  it explicitly); the principal-lane volume-anomaly threshold + clean-window re-arm follow the
  demote-alarm episode pattern with companion-stated illustrative values.
- **FD12 — The observe→enforce PROMOTION CRITERION is explicit per controller (folds CX4-2), not just
  "conservative":** a class is eligible to flip only after a defined observe SAMPLE WINDOW (e.g. ≥ N days /
  ≥ M admits) during which its would-deny rate stays below a per-class floor AND its projected dead-letter
  rate stays below a ceiling AND (for relief) zero relief-livelock was observed — then the operator flips it.
  The criterion is a code-level calibration recipe (config-overridable, FD11-class), so the builder isn't
  inventing thresholds; the flip itself remains the operator's deliberate action. **Observe-limbo is
  time-visible (folds codex-r6):** a controller still observe-only past a bounded calendar window
  (default 30 d) after meeting its promotion criterion raises a posture row + one attention nudge — the
  flip stays the operator's, but "measured forever, enforcing never" can't drift silently (Close the
  Loop). Nudge notice contract (Standard B — folds INT7-5): dedupe-key = `(controllerId)`, ONE-SHOT per
  limbo episode (re-armed only by a criterion re-met after a policy change), P17-funnel-bound with
  same-window nudges coalesced into one item enumerating the limbo controllers (~23 crossing in one era
  must not fan out), severity routine, max-notification-latency one evaluation tick past the limbo
  threshold, remediation-action = the operator's flip (or a deliberate keep-observing), audit-location =
  the transitions audit (folds INT8-4 — field symmetry with the other five contracts).
- **FD13 (v7, hardened v8) — Principal provenance: a human action always wins (folds ADV5-5; structural
  triad + auth tier by SEC6-1/SEC6-2/ADV6-1).** `admit()` carries `origin: 'self' | 'principal'` — but
  the ordinary handle API structurally CANNOT express `'principal'`; principal admission is a separate
  privileged API importable only by an enumerated allowlist of provenance-setting entry-surface modules
  (lint-enforced), and the stamp requires a HUMAN-principal signal (dashboard-PIN session /
  MessageSentinel-verified registered sender / mandate-verified principal) — a bare Bearer API call is
  `origin: 'self'` (a Bearer token is structurally insufficient; the agent itself holds it). Always-allow,
  always-audited, with independent volume-anomaly paging (never blocking); the lint + Tier-3 inventory
  explicitly accommodate the dual-use sinks (`SessionManager.killSession` et al.).
- **FD14 (v7, hardened v8) — State-durability split (folds ADV5-6 / INT5-1 / SEC5-3; event-aware flush +
  reset dispositions by SC6-2/ADV6-5/SEC6-5).** ADMISSION state (window buckets, per-target counts,
  latches, breaker state) is DURABLE — flushed on the bounded cadence PLUS an async eager flush on
  admission-delta (debounced) / half-ceiling + first-post-rehydrate (leading-edge, debounce-exempt) /
  graceful shutdown (folds INT8-1 — the FD wording must match the body's edge pins; a crash-loop faster
  than the cadence OR the debounce must not refill the budget), with a flush barrier before any
  self-killing action;
  boot-rehydrated (recency-validated, pessimistic carry-forward after unclean shutdown), machine-local,
  BackupManager-EXCLUDED via `BLOCKED_PATH_PREFIXES`. A missing/corrupt snapshot with prior flush
  evidence starts conservative (rate floor, one window) + a loud `state-reset` row — never a silent
  budget refill. QUEUED INTENTS are in-memory BY DESIGN (every queue-eligible class is level-triggered
  and re-generates), with a `restart-shed` audit row on ANY boot with non-zero last-known population +
  stated per-intent honesty. Queue fairness default = age-based promotion (folds DC5-1; the reserved
  drain slice is the config-overridable variant).
- **FD15 (v7, corrected v8) — The pool-wide ceiling COMPOSES the shipped grant-ledger modules (folds
  LA5-1 — supersedes v6's standalone store; shipped-state honesty + ledger hygiene + single-issuance by
  LA6-1/LA6-2/LA6-3/SEC6-3).** `AccountFollowMeGrants` + `AccountFollowMeSpendSlice` (shipped in dist
  v1.3.780, pure + UNWIRED — the math is delivered, the deployment is not) are composed behind a NEW
  governor-owned wiring gate (`intelligence.selfActionGovernor.poolCeiling`) — never a second
  sum-of-leases implementation (dual accounting on a safety bound), with ONE grant-ledger store + ONE
  fenced issuer per account regardless of which wiring gates are on. The residual review/build scope is
  the six-item list in §Resource scope (durable grant store + ledger hygiene, holder-side handler,
  requester-side renewal transport, wiring gate + posture, slice-state replication, cached-read
  integration + denomination mapping), and pool-shared ENFORCE is additionally a hard RUNTIME gate on
  replication health + mode coherence + clock-skew posture.

## Multi-machine posture (v4 — per-class resource tagging + observability posture split)

- **Hardware-bound classes** (`spawn` provider cap, `session-respawn`, host CPU/process count) are
  machine-local — `machine-local-justification: hardware-bound-resource` — exactly like the
  host-spawn-semaphore this generalizes. Their counters + route reads are machine-local.
- **Pool-shared classes** (`swap`/`notify` → account quota) are cross-machine: they carry
  `resource: pool-shared`, and their counters are exposed pool-wide via the `?scope=pool` fan-out (posture:
  proxied-on-read via `PoolPollCache`; dark-peer-tolerant). No pool-shared surface is left as an undefended
  machine-local. **Enforce eligibility (FD9 + INT-M1 + INT4-M2 + FD15):** at `N=1` (REGISTERED count, not online)
  the machine-local ceiling IS the pool-complete ceiling → single-machine agents flip normally; on a
  registered multi-machine pool the enforce flip requires the pool-wide sum-of-leases ceiling, which B
  delivers by **COMPOSING the SHIPPED `AccountFollowMeGrants`/`AccountFollowMeSpendSlice` modules behind a
  new governor-owned wiring gate** (re-grounded by LA5-1 against dist v1.3.780 — the modules exist, pure +
  injectable, dark only at the `accountFollowMe` WIRING layer; v6's "standalone store" premise was stale).
  Until that composed ceiling is wired + reviewed (the residual constraints named in §Resource scope),
  fleet `swap`/`notify` stay OBSERVE-ONLY; once it lands they enforce pool-wide — not hostage to the
  unrelated credential-sharing flag. **Pool-shared enforce-MODE is itself pool-coherent (folds INT5-4;
  mechanism corrected by INT6-1):** the governor adds explicit rows to `COHERENCE_CRITICAL_FLAGS` (the
  ONLY array the coherence sentinel compares — `GUARD_MANIFEST` feeds `/guards`, not coherence): an
  inverted-resolution governor row for `emergencyDisable` + clamped scalar mode rows
  (`observe|enforce|demoted`) for each `resource: pool-shared` class, so cross-machine mode skew (enforce
  on A, observe on B against one shared account) raises the standard machine-coherence alarm instead of
  silently halving the guarantee.
- **Governor state files (folds INT5-5 / ADV5-6 / INT5-1; keys split by INT6-4, mechanism by INT6-3):**
  the transitions audit and the durable admission-state snapshot are machine-local files. Posture is per
  CONTENT class (folds INT7-2 — the v8 wording named a justification OUTSIDE the closed Standard-A
  taxonomy, which the deterministic lint would itself reject): for hardware-bound classes' content,
  `machine-local-justification: hardware-bound-resource` (this host's governor transitions / admission
  history); the `pool-shared` classes' window buckets and counts are declared **`unified`** — the
  machine-local snapshot is the LOCAL HALF of a cross-machine surface whose replication half is
  explicitly owned by FD15 deliverable (5) (slice-state replication, the `stateSync`-family entry) — so
  no out-of-taxonomy key is needed and the classification is the truer one. Pool-wide questions are served by the
  `?scope=pool` posture and counter reads. The admission-state snapshot AND the flushed telemetry-aggregates file are both
  BackupManager-EXCLUDED via explicit `BLOCKED_PATH_PREFIXES` entries (the shipped pattern for
  per-machine state whose cross-machine restore is actively dangerous — `state/pending-inbound.*`,
  `state/pr-hand-leases.json`; mere include-list omission is defeated by a user-added include, and
  backups replicate to paired machines, where a RECENT snapshot passes recency-validation while carrying
  the wrong machine's counts; the aggregates file joins because a foreign restore fabricates
  prior-flush evidence and pollutes the FD12 soak counters — conservative/loud failure directions, but
  needless ones; folds INT7-3). Queued
  intents keep NO durable file (in-memory by design — §Queue crash semantics).

## Testing (all three tiers + the convergence ratchet + enforce-path coverage)

- **Tier 1:** three-way `Admission` under a pinned sustained-pressure fixture per class; per-class
  fail-DIRECTION on a thrown policy; the LOAD-BEARING per-target/total COUNT ceiling holds under the
  worst-case fixture; `projectPressure` as a ONE-WAY TIGHTENER (a wrong-optimistic reading never widens the
  base bound); **relief bypass (v4/v6 corrected) — the RATE relaxation never lifts the COUNT floor:
  `targetAlwaysRejects` (age-kill veto) bounded at `boundK`; `accept-but-ineffective` (external-hog shape —
  kill accepts, signature respawns, same target re-fired) bounded at `perTargetBoundK`; effective relief
  across DISTINCT retiring targets keeps its rate relaxation under the total ceiling, BUT a distinct-target
  FLOOD past `totalCountCeiling` IS count-denied (folds ADV4-m4); an incarnation-varying-key controller whose
  effective granularity is finer than its recurrence identity FAILS the shared-`deriveTargetKey` assertion;
  `respawn-recovery` under sustained saturation never demoted-to-death by the governor; the auto-demote latch
  does not promote↔demote flap**; atomic check-and-mint (two concurrent admits can't both pass a ceiling of
  1); token binding/TTL/single-consume; non-convergence freshness (un-confirmable → trip closed); a
  `resource: pool-shared` class refuses the enforce flip when REGISTERED machine-count > 1 without the
  pool-wide ceiling but flips at `N=1`, and auto-demotes on a `1 → >1` enrollment. **Round-5 additions:**
  the MIRROR granularity fixture — N genuinely-distinct STABLE targets derive N distinct keys with
  INDEPENDENT per-target ceilings, so an all-collapsing coarse `deriveTargetKey` fails the build (folds
  ADV5-7 — the invariant is two-sided: never finer than the recurrence identity, never coarser than
  distinct recurrence identities); admission state survives a bounce — kill + rehydrate mid-window and
  the count floor holds across the restart, while stale state past the largest window is dropped (folds
  ADV5-6); drain re-validation — a queued kill intent whose target incarnation died and was replaced is
  REJECTED at drain by the incarnation fence, and a drained intent re-runs the controller's eligibility
  predicate (folds ADV5-4); an `origin: 'principal'` admit passes with every ceiling exhausted and writes
  the audit row (folds ADV5-5); census-scaling — a legitimate mass-reap above the static floor but under
  the census fraction passes, a flood past the census fraction is denied window-paced, and a
  stale/unavailable census falls back to the static floor (folds ADV5-2); `queueMaxTargets` overflow
  dead-letters loudly and the dead-letter notice coalesces per (controller, window) (folds SC5-1/INT5-3);
  the demote alarm does NOT fire on a demote→clean-re-promote cycle and DOES fire after N failed
  cooldowns (folds LA5-2); a non-recovery relief class with a THROWING governor fails open, is audited
  (first-N then aggregated — folds SC7-1), and the errored posture raises the immediate attention item
  (folds INT5-2/ADV5-1);
  an exempt-lane claim by a controller outside the enumerated allowlist fails the build, and each
  member's declared `delegatedGiveUp` cap is DRIVEN to its trip point by the fixture (folds ADV5-3).
  **Round-6 additions:** a crash-loop bouncing FASTER than the flush cadence still accretes the durable
  floor (the eager delta-flush test — the budget never refills across N rapid bounces; folds SC6-2);
  missing/corrupt snapshot with prior flush evidence → conservative posture + `state-reset` row, fresh
  install → silent empty (folds ADV6-5/SEC6-5); a bare-Bearer call to a dual-use kill route admits as
  `origin: 'self'` and rides ceilings, while a PIN-authed/verified-sender path admits principal + audit
  row (folds SEC6-2/ADV6-1); `origin:'principal'`/privileged-API import outside the enumerated modules
  fails the lint (folds SEC6-1); a second file declaring an existing marker id fails the
  file↔controller lint, and a duplicate `governor.for()` mint fails loudly at boot (folds SEC6-4/ADV6-4);
  census widen-only-mid-window + absolute clamp + independence (an inflated census is clamped + audited;
  a stale/low-confidence census falls to the static floor; folds ADV6-2/SEC6-6/SC6-1); a THROWING
  per-class config override falls back to code default at LOAD (never throws in admit) and the
  errored-open relief path is paced by the last-resort floor (folds ADV6-3); both-wiring-gates-on yields
  ONE shared outstanding-total per account (folds SEC6-3); N renewal cycles keep the grant ledger
  O(outstanding) (folds LA6-2); a flapping `emergencyDisable` collapses to one episode-latched item
  (folds INT6-2). **Round-7 additions:** a principal-origin admit under a THROWING governor resolves
  OPEN, unpaced by the last-resort floor (folds SEC7-1); the last-resort floor is unchanged by ANY config
  override, including a well-formed vacuous one (folds ADV7-1); the crash-loop fixture drives bounce
  periods SHORTER than the flush debounce and the durable floor still accretes (folds ADV7-2); a
  RUNTIME-demoted pool-shared class is reflected in the machine-coherence advert (`readSource: 'live'` —
  a config-only advert that still says `enforce` fails the test; folds INT7-1); a coordinated
  snapshot+aggregates deletion lands the stated fresh-install posture (documenting the accepted residual,
  folds SEC7-5). **Round-8 additions:** a DUAL-LOADED second copy of the governor module colliding on the
  process-global mint key — the losing copy's mints all fail loudly, and there is never a second
  independent budget or a second snapshot writer (folds ADV8-1); the usage-scan lint rejects `admit()` on
  an imported handle in a file with no matching marker, including an exported exempt-lane handle imported
  by a helper file (folds SEC8-1/ADV8-3).
- **Tier 1 (enforce-path coverage — folds A7):** enforce-readiness REQUIRES a dry-enforce/canary stage that
  actually queues / coalesces / gates-on-token / fails-closed, plus the Tier-1 enforce tests — an
  observe-mode soak cannot certify machinery it never exercises.
- **Tier 1 (ratchet generalized):** extend `self-action-convergence.test.ts` to drive EVERY registered
  controller through the governor under the worst-case fixture and assert each honors its COUNT ceiling.
- **Tier 2:** a controller's real emit path routes through `admit()` and honors the typed token; the
  `GET /self-action-governor` route reports live per-class counters LOCK-FREE; pool-shared counters are
  answerable pool-wide.
- **Tier 3:** the `emit-without-admit` lint fails a registered controller that skips the funnel — and
  additionally rejects a raw string-keyed `governor.admit()` at an emit site and an admit-handle id that
  differs from the file's `@self-action-controller` marker (folds SEC5-1/ADV5-8); AND a **token-coverage
  inventory test (folds CX4-4)** enumerates every self-action emit SINK and asserts each REJECTS a
  missing/invalid token at RUNTIME (the runtime consume is the authority; the compile-time type is
  defense-in-depth that dynamic/`any`/JS/reflection paths can evade) — proving coverage over sinks, not
  merely that every controller calls `admit()` — with each sink's expected controller identity
  module-pinned (a token minted for the wrong controller is rejected sink-side) and the dual-use
  principal-lane sinks explicitly accommodated (folds SEC5-1/ADV5-5).

## Migration parity

New primitive + a lint extension + a read route; no config removed. **Config defaults stay CODE-ONLY**
(per-class policy lives in code); config carries only sparse per-class OVERRIDES, and `migrateConfig` writes
NOTHING (else ~138 knobs materialize). The runtime primitive ships in `dist` and reaches existing agents via
auto-update (no migration needed for the code itself). **Agent Awareness (folds I1, LA5):** the SAME PR adds
a `generateClaudeMd()` section for the governor (the `GET /self-action-governor` route + proactive triggers:
"why did my respawn get held / my swap get queued / my notify get folded?") AND a content-sniffed
`migrateClaudeMd` patch so DEPLOYED agents can narrate the gate they now ride (mirrors the Fork-Bomb Spawn
Cap template section + `PostUpdateMigrator.migrateClaudeMd`). A gate an agent can't explain is a capability
it effectively lacks.

## Status

**CONVERGED at round 9 (2026-07-05).** All six internal reviewers CONVERGED on v10: decision-completeness
(5th consecutive, final counts frontloaded=15 / cheap-tags=4 / contested-cleared=4, ZERO findings),
security, scalability, integration (3rd consecutive), lessons-aware (3rd consecutive), and adversarial —
every round-8 fold verified genuine with line-level grounding against dist v1.3.780; every round-9 finding
is an explicitly non-blocking one-clause MINOR. Both convergence criteria hold: no material new issues, and
§Open questions is empty. Externals: codex-cli gpt-5.5 ran CLEAN every round (rounds 5–9); its round-9
verdict repeats its rounds-7/8 meta themes (companion primacy, phase-1 scoping, principal split), all
already engaged in-body — repeats of addressed concerns, non-material per the convergence rule. gemini-cli
degraded on timeout rounds 6–9 against the grown body (last clean gemini pass: round 5 on v6); recorded
per-round, honestly — the spec-level cross-model flag is the clean `codex-cli:gpt-5.5` (any-round-success
rule, satisfied every round). The round-9 editorial batch folded into this document: the errored-alarm
Standard-B field completion + `errored-episode`/`mint-collision` audit rows (ADV9-2), and the green-field
observe-window honesty correction + INVERSE nudge for the criterion-never-met storm sub-case (ADV9-3).
**REQUIRED COMPANION CLAUSES (the remaining round-9 minors — each a one-clause pin the normative
implementation companion MUST carry; none blocks convergence):** anchor lifecycle — the process-global
claim is INIT-ONCE (first claimant initializes/rehydrates/owns the single flush loop; later claimants
ATTACH, never re-init, never second-flusher; the dual-load fixture asserts the attach case; store the
minimal claim surface behind the Symbol.for key, not raw mutable maps) (ADV9-1); the PATCH-config
granularity decision — whole-`intelligence` (precedented) vs a nested-path validator — plus the
one-level-deep-merge full-block hazard note (INT9-1); the usage-scan lint's self-scope riding the
per-controller file allowlist (governor module, principalAdmit entry surfaces, test registry) (INT9-2);
the disable-direction PIN-gate choice on the PATCH path — PIN-gate it (costs no emergency availability;
two verifier-independent valves remain) or explicitly accept the remote-Bearer exposure with the flip
audit as stated compensation (ADV9-4); a dispose/test-reset lifecycle for the global mint claim (SC9-1);
"never exported OR PASSED AS A VALUE" widening of the exempt-handle clause (SEC9-1); the CLAUDE.md
template section names the emergencyDisable valve + conversational flip (LA9-1); the DC8-1/DC8-2
illustratives (floor multiple ≈ 3–5×; volume threshold + re-arm). NOT approved; NOT built; the build
awaits `approved: true` + the normative companion (the implementation authority) with the build PR.

DRAFT v10 (provenance) — ROUND-8 CONVERGENCE-CHECK FOLDED (second confirm pass: scalability, decision-completeness
(4th consecutive, 15/4/4), lessons-aware, AND integration all CONVERGED — every round-7 fold verified
genuine with line-level grounding; security + adversarial each landed exactly ONE new MAJOR, both
one-sentence mechanism pins on the v9 fold text, both folded: the emit-without-admit lint's scan scope is
CODEBASE-WIDE HANDLE USAGE — `for()` AND `admit()`-on-imported-handle in every file, so a rogue
marker-less file importing an exported exempt-lane handle fails the build (SEC8-1/ADV8-3); the
single-mint registry + in-memory admission-state anchor key on a process-GLOBAL `Symbol.for` token so an
accidental dual-package/duplicated-dist load — which duplicates a module-scoped registry and would
otherwise guard nothing in exactly its named case — still collides loudly and can never run two
independent budgets or two snapshot writers (ADV8-1). Both reviewers stated convergence expected once
folded. Nine one-clause minors folded alongside: transitions enumeration completed for the v9 notices +
the per-admit principal-row carve-out named (ADV8-2); FD14 wording matched to the body's debounce-edge
pins (INT8-1); the observe-window scope honesty — retrofit set keeps bespoke brakes, green-field
controllers' observe window is the stated accepted residual with Increment-E as the authority (INT8-2,
answering the round-8 gate flag); the retrofit is ADDITIVE at every rung — enforce graduation never
licenses removing an incident-earned bespoke brake (LA8-1); the phone-completable valve layering named —
conversational primary, PATCHABLE_CONFIG_KEYS addition as a deliberate named deliverable, file edit as
the verifier-independent floor (LA8-2/INT8-3, answering the Mobile-Complete gate flag); the errored-window
instrumentation honesty note (SEC8-2); FD12 nudge contract field symmetry (INT8-4); residual coupled to
the debounce (SC8-1); LA7-1 grounding made grep-proof — type-only import named (ADV8-4);
companion-pinned illustratives for the floor multiple + volume threshold (DC8-1/DC8-2). codex-r8 read
"SERIOUS" on recurring meta themes — companion-as-primary-artifact (already the implementation authority;
produced with the build PR), phase-1 minimal scope (the FD1 ladder + fleet-observe-only pool-shared +
in-memory queue intents ALREADY sequence the build in codex's shape — stated here explicitly), the
principal split (remains a named non-blocking extension point; the emergency lane's unconditionality is
not negotiable), a broader alternatives decision-record + mechanical terminology definitions (both
required companion sections). gemini degraded-timeout a 4th time (codex carries the round's cross-model
pass; recorded per-round). The v9 status below is retained as provenance.

DRAFT v9 (provenance) — ROUND-7 CONVERGENCE-CHECK FOLDED (the confirm pass confirmed the tail: scalability, lessons-aware,
and decision-completeness all CONVERGED — every round-6 fold verified GENUINE against the deployed dist —
codex ran CLEAN again ("MINOR ISSUES"); gemini degraded on timeout a third time (recorded per-round; codex
carries the round's cross-model pass, gemini's round-5 clean pass stands). FIVE one-sentence-pin MAJORs
remained, all round-6 text colliding with itself, all folded: principal-origin is EXEMPT from the errored
path entirely — never paced by the last-resort floor (the floor is a dumb counter that cannot read origin;
SEC7-1); the last-resort floor is NOT config-overridable — hard code constant, per-class-derived,
reads no config (ADV7-1, closing DC7-2); the first-post-rehydrate flush is IMMEDIATE/leading-edge + the
fixture drives sub-debounce bounce periods + carry-forward has a non-zero floor (ADV7-2/SC7-2); the
coherence mode rows read `demoted` via a governor-state accessor added to the caller-injected view —
`readSource: 'live'` — with the ratchet-test updates a declared deliverable (INT7-1/LA7-2/INT7-4); the
pool-shared admission-state content is declared `unified` (local half of the FD15-replicated surface),
resolving the out-of-taxonomy justification (INT7-2). Fourteen MINORs folded alongside (notice contracts
for the volume page + FD12 nudge — SIX governor notices now under P22; stale per-emit wordings fixed;
controller-scoped single-mint failure; PIN threat-model honesty + the verifier-dark human valve;
multi-file marker mechanics; aggregates file joins the backup exclusion; census/floor governance pins;
DC7-1 illustrative values; LA7-1 imports precision; LA7-3 two-channel interplay; codex-r7 tradeoff table +
post-restart reason honesty). The v8 status below is retained as provenance.

DRAFT v8 (provenance) — ROUND-6 CONVERGENCE-CHECK FOLDED (6 internal + externals on v7: codex CLEAN "MINOR ISSUES";
gemini degraded twice on timeout against the ~1300-line body — the round still carries a genuine
cross-model pass via codex, and the per-round gemini outcome is recorded honestly; decision-completeness
CONVERGED a third time, counts frontloaded=15 / cheap=4 / contested-cleared=4). Round 6 found NO
structural problems with the core design — every MAJOR is a hardening of round-5's own new text, each
with a small named fix (see §Round-6 provenance): the FD13 principal lane got the structural triad + a
pinned HUMAN-tier auth requirement (a bare Bearer call — which the agent itself can make — stamps `self`;
SEC6-1/SEC6-2/ADV6-1); the census input got the strictest read discipline in the spec (off-hot-path,
roll-computed widen-only, independent source, confidence-gated widening, absolute clamp;
SC6-1/ADV6-2/SEC6-6); FD14's flush became event-aware so a sub-cadence crash-loop can't defeat the
durable floor, with defined loud reset dispositions (SC6-2/ADV6-5/SEC6-5); the errored-open relief path
got a policy-free last-resort pace + load-validated config + bounded audit (ADV6-3/SC6-3); the
file↔controller binding closed the copy-pasted-marker hole (SEC6-4/ADV6-4); the mode-skew mechanism was
re-grounded onto `COHERENCE_CRITICAL_FLAGS` (the v7 guard-manifest citation was the wrong module;
INT6-1); the three new notice paths got full Standard-B contracts (INT6-2/ADV6-7/LA6-5); and FD15 was
made deployment-honest — the composed modules are pure + UNWIRED, the residual scope is six named
deliverables including ledger hygiene (the shipped ledger accumulates unboundedly — LA6-2) and a
single-issuance-authority invariant (SEC6-3). The v7 status below is retained as provenance.

DRAFT v7 (provenance) — ROUND-5 CONVERGENCE-CHECK FOLDED (6 internal + 2 external reviewers on v6; ~11 distinct MAJOR +
~9 MINOR — the heaviest late round, for three identifiable reasons, none of them "the design got worse":
(1) two review standards that POST-DATE rounds 1–4 (Standard A default-unified multi-machine posture;
Standard B Self-Heal-Before-Notify) applied for the first time — INT5-3/INT5-4/LA5-2 are new-lens findings;
(2) grounding drift — the deployed dist moved v1.3.778 → v1.3.780 UNDER the spec, shipping the very
sum-of-leases modules v6 said didn't exist (LA5-1 — itself a live specimen of the stale-copy disease the
coherence audit named); (3) a deeper adversarial pass on the governor's own new machinery (queue, lanes,
provenance). decision-completeness CONVERGED again; codex + gemini both MINOR on clean runs. Round-5
decisive folds: the pool-wide ceiling now COMPOSES the SHIPPED
`AccountFollowMeGrants`/`AccountFollowMeSpendSlice` modules behind a new governor-owned wiring gate (FD15 —
supersedes the v6 standalone store, kills the dual-accounting risk, dissolves most of the externals'
"second major system" concern); controller identity is AUTHENTICATED (per-controller handles + lint +
sink-pinned identity — the class id had become a privilege selector for the unbounded lanes: SEC5-1/ADV5-8);
exempt-lane MEMBERSHIP is an enumerated allowlist with fixture-driven delegated give-up authority + a
rateFloorMs code floor (ADV5-3); non-recovery relief fail-direction PINNED (open-with-audit + immediate
errored alarm — the policy table's "n/a" was an omission: INT5-2/ADV5-1); the relief total ceiling is
CENSUS-SCALED (the static above-legit/below-flood premise was unsatisfiable — legit relief load is
population-proportional: ADV5-2); PRINCIPAL PROVENANCE makes "a human action always wins" structural
(origin field, always-allow audited lane, dual-use sinks accommodated: ADV5-5/FD13); ADMISSION STATE IS
DURABLE across restarts (flush + recency-validated rehydrate — a crash/bounce no longer refills the runaway
loop's count budget: ADV5-6/FD14); the queue is COMPLETED (distinct-target `queueMaxTargets` ceiling on the
real growth axis: SC5-1; drain re-validates controller eligibility + an incarnation fence so a queued kill
can never fire on a healthy successor: ADV5-4; in-memory-by-design crash semantics with restart-shed
honesty: INT5-1/SEC5-3; failure-minimal enqueue with a defined double-failure terminal: SC5-3; age-based
promotion pinned as the fairness default: DC5-1); every governor-raised notice carries the Standard-B
contract (demote alarm gated on heal EXHAUSTION per P22 — LA5-2/INT5-3; dead-letter shed P17-bound with
per-class severity); pool-shared enforce-mode skew is coherence-alarmed (INT5-4); numeric overrides +
emergencyDisable flips are immediately audited and posture-visible (SEC5-2/ADV5-9); telemetry names the
deciding sub-mechanism on every non-allow (gemini-r5); the FD9 level-evaluation read discipline is pinned
off the hot path (SC5-2); the mirror coarse-key granularity fixture added (ADV5-7); parent-principle
exactness corrected — parent = Capacity Safety — No Unbounded Self-Action, whose canonical registry entry
names this spec as its follow-on increment (LA5-3); `lessons-engaged` P20–P23 declared in frontmatter
(LA5-2). **Honesty statement:** the `swap` class BOUNDS swap frequency; it does NOT CURE swap-thrash (the
cure — decouple swap from restart — is Increment A). Single-machine (REGISTERED N=1) agents enforce the
`swap` bound immediately; on a registered multi-machine FLEET, `swap`/`notify` stay OBSERVE-ONLY until the
COMPOSED pool-wide ceiling (FD15) is wired + reviewed — then B bounds cross-machine fleet swap-thrash.
**Required build-PR deliverable (PROMOTED from a recommendation — codex + gemini, both rounds):** a
NORMATIVE implementation companion (the final contract only: API, policy schema, invariants, fail modes,
rollout gates, tests) extracted from this document, which remains the design-of-record / audit trail.
**Round-6 lessons-pass note (LA5-2 meta):** the lessons-aware reviewer MUST load the CANONICAL principles
index (`git show JKHeadley/main:docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`) — the agent-home serve-main
copy is stale (P19-era, missing P20–P23), the same stale-copy trap that produced this round's
conformance-gate false positive. Round 9 CONVERGED (see the Status head + §Round-9 provenance) — the lessons pass reads
the canonical index, and the externals should note gemini's repeated timeout on the grown body (codex
carries the cross-model pass if it recurs). **The normative implementation companion is the
implementation AUTHORITY (folds codex-r6, upgrading codex-r5):** the build implements FROM the companion
(API, policy schema, invariants, fail modes, rollout gates, tests); THIS document is audit
trail/provenance only — a builder must not implement from a stale mid-document paragraph. Tracked under
CMT-1911.

## Round-1 review findings (2026-07-05) — must fold into a v2 grounding rewrite

Two reviewers (adversarial + scalability), both grounded against master. Verdict: NEEDS-REVISION /
not-yet-buildable. The v2 rewrite must ground against the REAL machinery on master (absent on serve-main).

### CRITICAL (foundational)
- **R1 — v1 misread the registry.** `src/testing/selfActionRegistry.ts` `SELF_ACTION_CONTROLLERS` is a
  **5-entry TEST-MODEL set** (`makeUnderPressure(fixture,sink)→{tick()}`) used by the convergence ratchet
  — NOT live emit paths. The retrofit surface is the **~23 lint-detected emit-site FILES** (the
  `lint-no-unregistered-self-action` basename+verb surface). v2 must describe both artifacts correctly:
  ~23 files get `admit()`; each also needs a pressure-fixture model for the ratchet (a cost v1 hid).
- **R2 — fail-open (FD2) is wrong for a capacity guard.** During the storm it targets (OOM/test-storm),
  `admit()` throws under saturation → FD2 admits → the runaway proceeds. Contradicts the spawn-cap's own
  fail-CLOSED ("a safety-gating capacity shed fails closed, held"). Fix: fail-direction PER-CLASS —
  cost-increasing/safety-gating classes (spawn, kill, swap) fail **closed/queue**; disruption-only
  (notify) may fail open. Reconcile with the synthesis's "fail-to-QUEUE, never reject-that-bypasses".
- **R3 — `Admission` must be THREE-way, not boolean.** A binary `allowed` regresses P17
  (`AttentionTopicGuard.decide()` returns allow|coalesce and NEVER drops). Add a `coalesce/reshape`
  outcome (+ a `deny-or-queue` for one-shot paths) so notify/retry don't become silent drops.
- **R4 — "action class" granularity undefined** (7 verbs vs ~23 controllers). Blocks admit()'s signature,
  the policy table, and the config schema. Recommend: key policy on controller id (+ actionVerb as an
  audit tag).

### MAJOR
- **swap/notify are POOL-SHARED resources, not machine-local** — the blanket machine-local claim is wrong
  for exactly the swap-thrash incident (account quota is shared across machines; two local governors can
  both blow one account). Tag the protected resource PER CLASS; pool-shared classes need a pool-wide
  ceiling.
- **"spawn" conflates two resources** (LLM-subprocess concurrency at the provider layer vs session-respawn
  at the controller layer) → double-acquire/halved-cap risk. The provider-layer spawn cap STAYS where it
  is; the governor must NOT re-acquire it. Model session-respawn as its own class.
- **Projected-pressure is not reliably computable** + fails dangerous (under-estimate → admit) and reads
  the same stale quota polls that ARE the disease. Replace with pessimistic + freshness-bounded
  **hysteresis** (deny on stale); require each amplifying class to supply a `projectPressure()` callback.
- **Convergence bound: raw count is wrong + episode boundary undefined.** Use **non-convergence detection**
  (trip when N consecutive actions FAIL to reduce the pressure they respond to) — directly encodes "does
  the loop settle?", bounds a real loop, never starves a legitimate burst. Or drop the per-episode bound
  at runtime and rely on token-bucket + breaker (no episode boundary needed).
- **Relief-path deadlock:** kill-request/reaper DE-escalate; rate-limiting them under pressure livelocks
  (pressure high → deny relief → pressure stays high). Classify by pressure DIRECTION; relief classes get
  a never-denied bypass lane + a Tier-1 liveness test (soak can't catch this — nothing's blocked in
  observe mode).
- **Heterogeneous cost:** spawn already pays lock+JSON-file I/O; notify is zero-I/O in-memory sync.
  A uniform `async admit()` taxes the cheap paths + forces sync `tick()` loops into async. Allow a
  **sync in-memory fast path** for frequency classes.
- **One-shot/reactive "stand down" = work-loss** (a reactive swap on a rate-limit event, a retry in a
  catch). Must fail-to-QUEUE, not drop. Resolve Q2 (reactive-swap coverage) — the highest-value path.
- **#1376 does NOT provide runtime would-deny telemetry** (it ships a report-only lint + a 5-model unit
  ratchet). The observe→enforce telemetry (durable per-class counters + a `/self-action-governor` read
  route, à la `/spawn-limiter`) must be BUILT in this increment; define the numeric flip gate per class.

### Honesty corrections for v2
- The swap class **bounds** swap frequency; it does NOT **cure** swap-thrash. The cure (decouple swap from
  restart via live credential re-pointing) is Increment A. v2 must state this plainly and not sell B as
  preventing swap-thrash alone.
- The lint enforces the `admit()` CALL, not the HONORING of its verdict — add a single-use capability
  token (no token → no emit) so a controller can't call admit() then fire anyway.
- Honor the registry's existing `eternalSentinel`/`liveness-heartbeat` exemption (rate-floored, never
  count-bounded) or the default deny-fast starves heartbeats.
- Config defaults stay CODE-ONLY; config carries sparse per-class overrides only (migrate writes nothing)
  — else ~138 knobs materialize.

### Build-environment
- All grounding machinery is on MASTER (dist v1.3.778 / current worktrees), ABSENT on serve-main. v2 +
  build must ground against master.

## v2 grounding note (confirmed against the real registry, dist v1.3.778)

The correct foundation for the v2 rewrite — verified in `dist/testing/selfActionRegistry.js`:

- The registry is 5 entries, each a **test-model** with fields: `actionVerb` (e.g. `account-swap`,
  `age-kill`, `beacon-notify`, `liveness-notify`, `kill`), `models:` (a STRING ref to the real source
  file it simulates, e.g. `src/monitoring/SubscriptionPool.ts`), `boundK` (total-action bound),
  `perTargetBoundK` (per-target anti-ping-pong bound), optional `eternalSentinel` (`{reason, rateFloorMs}`
  for rate-floored exempt classes like `liveness-notify` with `boundK: Infinity`), and
  `makeUnderPressure(f, sink)` (the synthetic tick the convergence ratchet drives).
- **The design collapse this resolves:** the governor's per-class policy is NOT a new schema — it is the
  RUNTIME enforcement of the SAME `boundK` / `perTargetBoundK` / `eternalSentinel` the registry already
  declares and the ratchet already proves at test-time. `admit()` reads those existing fields; the
  novelty is applying them at the live emit site, not in a virtual-clock test.
- **The retrofit surface** = the ~23 real emit-site files the `models:` strings point at (and the
  `lint-no-unregistered-self-action` basename+verb surface), NOT the 5 registry entries. Each retrofitted
  controller keeps (or gains) its registry MODEL so the ratchet keeps proving its bound; `admit()` is the
  runtime arm of the same contract.
- `eternalSentinel` classes are rate-floored (never count-bounded) — the governor MUST honor
  `rateFloorMs` instead of the default deny-fast, or it starves heartbeats.

This is the correct starting point for the v2 grounding rewrite (the full fold of the Round-1 findings
above). Tracked as task #11.

## Round-2 review findings (2026-07-05) — folded into v3

`/spec-converge` round 1: six internal reviewers (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) + two external cross-model passes (codex-cli gpt-5.5 "SERIOUS
ISSUES"; gemini-cli gemini-2.5-pro "MINOR ISSUES"). Standards-Conformance Gate ran (0 at-risk). ~30
material findings; all folded into the v3 design body above. Verbatim list retained as provenance.

### CRITICAL (3)
- **Relief bypass re-opens the reaper flood (LA1 / A1 / codex-C2).** v2's never-denied relief bypass
  exempts the exact registry models the foundation bounds (`age-kill` boundK:5 = 17,503 kills/day;
  external-hog killer boundK:3), both under `targetAlwaysRejects`. Root: direction is an OUTCOME property,
  not an action-type label. → §"Effective-relief bypass": bypass conditioned on effective relief;
  ineffective relief falls back to the bounded age-kill model + auto-demote + rate floor; corrected Tier-1.
- **Non-convergence rests on the stale signal the spec distrusts (SEC1).** The convergence measurement had
  no freshness bound (unlike `projectPressure`), so a stuck-low gauge = "always convergent" = never trips.
  → §"Load-bearing bound": un-confirmable convergence counts as non-convergence (trip toward closed).
- **Non-convergence is a weaker, less-defined bound than the proven count invariant it claims to analogue
  (LA2).** → §"Load-bearing bound": the hard per-target/total COUNT ceiling is load-bearing; non-convergence
  demoted to a supplementary early-trip; `perTargetBoundK` gets an explicit per-target runtime analogue.

### MAJOR (folded)
- Runtime policy is a SUPERSET of the registry fields — the v2 "not a new schema" claim was wrong
  (codex-C1 / S1 / S2). → §"Runtime policy schema".
- Pool-shared enforce must be structurally gated on the pool-wide ceiling; machine-local enforce of a shared
  resource is fake-safe (LA4 / SEC5 / A5 / I3 / D2 — dominant consensus; + codex-C4 / gemini-G2). → FD9 +
  §"Resource scope": resource-aware flip gate; pool-wide ceiling IN SCOPE for B.
- Non-convergence saw-tooth reset + per-target ping-pong escape (A2). → net-reduction-over-window +
  per-target ceiling.
- `session-respawn` recovery vs crash-loop; fail-closed-to-queue strands a recovery respawn (LA3). → split.
- Capability token: no TTL / no (controllerId,targetKey,class) binding / no compile-time enforcement
  (SEC2 / A3 / codex-C5). → §"Capability token — hardened".
- `projectPressure` safety must be governor-side (a controller callback = willpower); it must be a one-way
  tightener over a base ceiling (SEC3 / A4). → §"AMPLIFYING classes".
- admit() check-and-mint atomicity / burst TOCTOU / host-shared counter race (SEC4). → atomic CAS.
- Counters must be in-memory aggregates flushed on cadence (not per-admit, or `admitSync` is a lie);
  fixed-size in-place, transitions-only audit, retention-bounded (S1 / S2). → §"Runtime telemetry".
- `GET /self-action-governor` must be a lock-free in-memory read (`/spawn-limiter` writes on GET — wrong
  precedent; use `/test-runner-limiter`) (S3). → §"Runtime telemetry".
- Route + counters need a declared multi-machine posture SPLIT (machine-local vs pool-wide) (I2). →
  §"Multi-machine posture".
- `queue` is a new unbounded self-action + fires stale on drain (codex-C3 / A6). → coalesce same-target +
  re-admit at drain + bounded depth.
- Observe-soak flip gate is blind to ALL enforce-only machinery, not just relief (A7). → enforce-path
  coverage in the flip gate.
- No global kill-switch; token gate can wedge a disabled/errored governor (I4). → FD2 global kill + always
  mint an allow-token when disabled.
- Migration omits the Agent-Awareness / `generateClaudeMd` deliverable (I1 / LA5). → §"Migration parity".
- Q1 + Q3 (and the parked Q2) are unresolved Open questions → the tag writer refuses to stamp (D1–D5). →
  resolved into FD8 / FD9 / FD10; Open questions now empty; per-class numeric defaults frontloaded (FD11).

### MINOR (folded)
- Route projection must scrub target identities + absolute quota values (SEC6). → §"Runtime telemetry".
- `projectPressure`/relief must read the last cached poll, never trigger one from admit() (S5). → folded.
- `notify` sync path is forward-incompatible with its pool-shared tag once the pool-wide ceiling lands (S6).
  → decided: pool-wide reads a cached lease-slice (stays sync) or notify migrates off `admitSync` at that
  point — called out in the schema.
- Complexity / "not invented here" — justify the bespoke primitive (gemini-G1). → §"Why a bespoke
  primitive".
- Internal jargon impenetrable to external readers (gemini-G3). → §"Glossary" + the ELI16 companion.

### Foundation audit (lessons-aware, mandatory-d) — CLEAN
The #1376 forcing lint's fail-closed CI blocking authority is the sanctioned deterministic build-time
ratchet (twin of `lint-no-unbounded-llm-spawn.js`), NOT a Signal-vs-Authority violation. The `boundK`
contract is sound (horizon-independent + anti-ping-pong + genuine-pressure guard + tested eternal-sentinel
rate-floor). The `models:` string-ref coupling is documentation/audit only and does not feed runtime policy.
The one lesson the foundation encoded but v2 failed to carry through — relief-bounding — is the CRITICAL
above, now folded.

## Round-2 convergence-check findings (2026-07-05) — folded into v4

`/spec-converge` round 2 (on v3): the same six internal reviewers + two external passes (codex-cli gpt-5.5
"MINOR ISSUES"; gemini-cli gemini-2.5-pro "MINOR ISSUES" — BOTH downgraded from round 1). 1 CRITICAL + ~9
MAJOR + several MINOR; no new structural direction (all refinements of the v3 corrections). All folded into
v4. Verbatim list retained as provenance.

### CRITICAL (1)
- **The v3 effectiveness "accepts" arm re-opened `external-hog` boundK:3 (LA-C1, grounded against the real
  registry; = ADV-M1).** `age-kill` is vetoed → v3 bounded it; but `external-hog`'s kill ACCEPTS every time
  (only the signature respawns), so "accepts ⇒ effective" bypassed boundK:3 (Distrust Temporary Success). →
  §"Bypass-eligible relief": the COUNT ceiling is a HARD FLOOR always (bypass relaxes only the RATE);
  ineffective relief re-fires the same target → hit at `boundK` by construction; effectiveness =
  pressure-reduction only, never acceptance; eligibility a closed set; swap/notify non-relief.

### MAJOR (folded)
- The "always yields an allow-token" clause re-opened R2 fail-open (SEC-M1 / ADV-M2 — a v3 self-contradiction).
  → §"Fail-direction": unconditional allow-token scoped to the DISABLED path only; enabled cost/safety error → queue.
- The governor's kill-switch disable was invisible to `GET /guards` + the Guard-Posture Tripwire (SEC-M2). →
  §"Fail-direction": posture registered in `/guards` + tripwire-watched; `emergencyDisable` lever, not a plain flag.
- `respawn-recovery` demotion contradicted "must not strand" (ADV-M3 / LA-M2). → exempt from
  count-ceiling/breaker demotion + un-confirmable→closed; rate-floor only; give-up via the ResumeQueue cap.
- Auto-demote promote↔demote flap → alarm flood (ADV-M4). → per-episode latch + P17-coalesced alarm.
- Host-file CAS conflated hardware-bound with host-shared, taxing the storm path (SC-M1). → CAS keyed on
  cross-PROCESS contention only; single-process kill/age-kill use in-memory CAS + keep `admitSync`.
- Pool-wide ceiling read on the swap/notify hot path uncommitted (SC-M2). → locally-cached lease-slice,
  bounded staleness, never a synchronous fan-out (resolves S6: notify stays sync).
- FD9's pool-wide ceiling coupled to the DARK multi-machine-only WS5.2 substrate + its "never machine-local"
  rule stranded the single-machine case (INT-M1). → `N=1` carve-out (machine-local = pool-complete) + honest
  fleet-observe-only disclosure + the substrate named.
- swap/notify `direction` unpinned → a successful swap read as effective-relief (ADV-M6). → declared
  non-relief; bypass eligibility is a closed set by construction.

### MINOR (folded)
- Count ceiling needs a runtime reset/horizon or it bricks a long-lived controller (CX2). → sliding
  window / convergence-epoch reset + recency-aware per-target eviction (SC-m3).
- `concurrencyCap` host-file holder-reclaim unspecified (SEC-m3). → dead-holder/TTL reclaim required for
  host-file-backed caps.
- default-on read as enforce-by-default (CX3). → §"The primitive": default-on = registered+funneled; a new
  controller starts OBSERVE.
- Capability-token compile-time guarantee overstated (CX4). → runtime consume is the authority; the type is
  defense-in-depth.
- `queue` under sustained pressure dead-letters (a real non-fire) (ADV-m5). → stated honestly (loud shed, not
  eventual-fire) + `maxReadmitCycles`.
- Bespoke justification under-addressed internal queue/lease alternatives + composition (CX5 / gemini-G3). →
  §"Why a bespoke primitive".

### Verified clean at round 2 (folds that held)
Decision-completeness: NO MATERIAL FINDINGS (Open questions empty; FD9 graduation guard structural; FD11
buildable-now; no un-frontloaded operator decision). Security/scalability/integration/lessons-aware each
verified ALL their round-1 folds landed correctly; the round-2 findings above are new-surface refinements,
not fold regressions. The `?scope=pool` counter fan-out (reuses PoolPollCache, dark-peer-tolerant) and
re-admit-at-drain self-pacing were checked and cleared.

## Round-3 convergence-check findings (2026-07-05) — folded into v5

`/spec-converge` round 3 (on v4): same six internal reviewers + two external passes (codex-cli gpt-5.5
"SERIOUS ISSUES" — driven by the FD2 miss + pool-shared scope; gemini-cli gemini-2.5-pro "MINOR ISSUES",
"v4 corrections decisive"). The round-2 relief CRITICAL was independently VERIFIED genuinely closed against
the real registry (external-hog keys on a stable signature hash). No new structural direction — one real
miss + seam-tightenings/consistency/buildability. All folded into v5.

### Real miss
- **FD2 (Frontloaded Decision) still carried the v3 fail-open wording** ("a disabled/errored governor always
  yields an allow-token") the §Fail-direction body had already corrected — QUADRUPLE consensus (codex CX3-1,
  security SEC3-M1, decision-completeness DC3-M1, + the body/FD drift). A builder implements the FD verbatim,
  so this re-opened R2. → FD2 reworded (enabled cost/safety `admit()`-throw → queue; allow-token
  disabled/kill-switched-path-only; env-override dropped).

### MAJOR (folded)
- Target-key-stability invariant — the "by construction" external-hog closure silently depended on the
  emit-site keying `targetKey` on the pressure-stable signature, not an ephemeral id; the ratchet PRESUPPOSED
  it (TRIPLE consensus: adversarial ADV3-M1, codex CX3-5, lessons-aware LA3-M1). → target-granularity
  invariant (runtime `targetKey` = model granularity, ratchet/lint-checked) + an incarnation-varying Tier-1
  fixture (vary the ephemeral id, hold the signature; a volatile-keyed relief controller MUST fail).
- Count-floor contradiction — "effective relief across distinct targets never count-denied" vs "total ceiling
  backstops fan-out regardless" (ADV3-M1). → `totalCountCeiling` is a genuine hard floor binding a
  distinct-target FLOOD; the RATE relaxation (not a count exemption) serves legitimate bursts; the `boundK`
  tuning tension named.
- Unlatched convergence-epoch reset re-introduced Distrust-Temporary-Success at the floor (ADV3-M2). →
  relief/accept-but-respawn classes use a fixed-bucket sliding window with NO epoch reset.
- FD9 N=1: "no machine-local enforce, ever" contradicted the N=1 carve-out and left the `1 → >1` transition
  ungoverned (DC3-M2 + INT3-M1). → FD9 + §Resource scope qualify to pool-size and add a LEVEL-triggered
  auto-demote on a 2nd-machine enrollment.
- Guard-posture "watched by the tripwire" was asserted, not wired; the env override was invisible to both
  posture surfaces (INT3-M2 + SEC3-m2). → two NAMED wiring deliverables (`GUARD_MANIFEST` entry +
  `collectGuardPosture` branch) + the `INSTAR_SELF_ACTION_GOVERNOR` env override dropped (config-only).
- Pool-wide ceiling hostage to the dark `accountFollowMe` feature (codex CX3-3 + gemini GX3-1, double). →
  DECOUPLED: B builds a standalone per-account sum-of-leases lease-slice (reuse the grant-ledger mechanism,
  not the flag).
- `respawn-recovery` fail-direction vs the queue dead-letter could strand a registered run (ADV3-m3). →
  `respawn-recovery` fails OPEN (never `queue`d, never dead-lettered); give-up is the ResumeQueue cap +
  liveness-reconciler P19 only.
- Host-file CAS holder reclaim + concurrencyCap (SEC-m3, verified) — carried; SC round-3 confirmed all four
  round-2 scalability folds landed.

### MINOR (folded)
- Sliding window must be fixed-bucket, not a per-event deque (SC3-m1). Per-target fan-out corner (full map,
  all active-at-ceiling) must fail CLOSED, not evict an active entry (SC3-m2). Numeric policy needed a default
  table (CX3-4 → added). "Hard floor at all times" overstated vs the two count-exempt classes (CX3-2 → FD5
  qualified). No-external-dep tradeoff stated for the bespoke lease-slice (GX3-2). Architectural-density /
  clean-spec extraction (GX3-3) noted as a maintainability follow-up, non-blocking. <!-- tracked: CMT-1911 -->

### Verified clean at round 3
Decision-completeness: Open questions still empty; all v4 additions frontloaded/FD11-cheap (SUBJECT to the
FD2/FD9 re-syncs, now done). Adversarial + lessons-aware independently confirmed (against the real registry)
that the round-2 external-hog closure and the respawn-recovery exemption HOLD, not merely re-labeled.

## Round-4 convergence-check findings (2026-07-05) — folded into v6

`/spec-converge` round 4 (on v5): six internal + two external (codex MINOR; gemini MINOR after a
timeout-degrade retry). **decision-completeness CONVERGED**; the round-3 folds were verified genuinely closed
by adversarial + lessons-aware + scalability + security against the DEPLOYED code. ~6 MAJOR + several MINOR —
ALL reconciliations / grounding-catches / wording, NO structural redesign. The MAJORs were concentrated in the
v4/v5-added multi-machine + guard surfaces (which is why grounding against the real code surfaced them).

### MAJOR (folded)
- Guard-posture `configPath` POLARITY-INVERTED (INT4-M1): `emergencyDisable` (true=off) named where the
  evaluator reads enabled-polarity → would alarm on healthy governors and stay silent on disabled ones. →
  synthetic enabled-polarity `configPath` + a computed `enabled = emergencyDisable !== true` branch in
  `extractGuardPosture` (the `PermissionPromptAutoResolver` pattern).
- N=1 level-trigger keyed on the ONLINE-peer collapse (INT4-M2) → a pool-shared class would enforce
  machine-local whenever the peer slept. → keyed on the REGISTERED-machine count; re-promote only on
  de-enrollment.
- "reuse the grant-ledger mechanism" overstated (INT4-M3) — that mechanism is itself spec-stage and the
  replicated-store foundation is dark-gated. → softened to "build a standalone durable multi-machine store,
  informed by the pattern"; the lease-slice handoff expanded (replication + writer↔lease-holder + failover +
  corrupt-ledger→observe).
- Lease-slice handed off a consistency model but not an INTEGRITY one (SEC4-M1) → the one cross-machine surface
  lacking the authenticate + fail-conservative discipline. → integrity constraint named in the handoff.
- `age-kill` default ceiling 30 < the cited 40-session bulk-reap it claimed to exceed (ADV4-M1) → ~60/window
  + tuning guidance corrected (the no-reset window may span multiple episodes).
- Target-granularity "volatile MUST fail" contradicted the shipped `ExternalHogKillLedger`
  `(key, classId, keyIsVolatile)` two-level design AND left the runtime-binding (L2) to an undecidable lint
  (ADV4-m2 / LA4-M1, double consensus, grounded) → restated to the real two-level design (effective
  granularity pressure-stable) + a shared `deriveTargetKey()` both model + runtime are lint-bound to call, with
  the fixture pointed at that shared derivation.

### MINOR (folded)
- Lease-slice per-admit write-side (SC4-m1): in-memory consume + out-of-band durable flush, never per-admit.
- `respawn-recovery` "rate-floor only" vs "fails open" contradiction (ADV4-m3 / LA4-m2) → "NO blocking bound."
- §Testing Tier-1 still un-capped (ADV4-m4) → synced to "distinct-target FLOOD past `totalCountCeiling` IS
  count-denied."
- Consistency envelope (CX4-3), token-coverage inventory test over sinks (CX4-4), queue fairness / reserved
  drain for recovery (CX4-5), explicit observe→enforce promotion criterion (CX4-2 → FD12), clock-sync
  assumption (gemini), delegated-give-up test focus (gemini). Density / clean-spec extraction (codex/gemini)
  noted as a non-blocking build-time deliverable.

### Not converged, but late-stage
decision-completeness converged; the rest are numeric/wording/mechanism/handoff reconciliations. The core
design (the governor, three-way admission, load-bearing count floor, effectiveness-gated relief, pool-shared
gate) is confirmed stable. The residual pattern — each fold introduces a little new surface the next round's
grounding catches — is why a round-5 confirm pass is warranted before the convergence tag.

## Round-5 convergence-check findings (2026-07-05) — folded into v7

`/spec-converge` round 5 (on v6): six internal reviewers (run on `claude-fable-5` — D7 per-round-model
disclosure; prior rounds ran on the authoring session's model) + two external passes, both CLEAN runs
(codex-cli gpt-5.5 "MINOR ISSUES"; gemini-cli gemini-2.5-pro "MINOR ISSUES"). Standards-Conformance Gate
ran (1 flag — grounded as a FALSE POSITIVE: the gate read a stale registry copy; the canonical registry at
`JKHeadley/main` contains both `### Bounded Blast Radius` and `### Capacity Safety — No Unbounded
Self-Action`; the exactness question it surfaced became LA5-3). decision-completeness: CONVERGED (counts
at v6: frontloaded=12, cheap-tags=4, contested-cleared=4; v7 adds FD13–FD15). ~11 distinct MAJOR + ~9
MINOR — the heaviest post-round-1 round, driven by two NEW review standards (A/B post-date rounds 1–4),
grounding drift (dist v1.3.778 → v1.3.780 shipped mid-process), and a deeper adversarial pass. All folded
into v7.

### MAJOR (folded)
- **LA5-1 (decisive re-grounding)** — the v6 lease-slice premise ("no shippable sum-of-leases primitive;
  `AccountFollowMeSpendSlice` is spec-stage; only `WalledEnrollmentOffer` exists") is FALSE against dist
  v1.3.780: `AccountFollowMeGrants.js` + `AccountFollowMeSpendSlice.js` are SHIPPED (pure + injectable,
  dark only at wiring); `WalledEnrollmentOffer` exists nowhere in the package. Building a second
  sum-of-leases store = dual accounting on a safety bound (reinvent-existing-infrastructure). → §Resource
  scope + §Multi-machine posture + §Status re-grounded: COMPOSE the shipped modules behind a new
  governor-owned wiring gate (FD15); already-implemented constraints cited, not re-specified; residual
  deferred-review scope shrunk. <!-- tracked: CMT-1911 -->
- **SEC5-1 / ADV5-8** — the controller-id argument to `admit()` was unauthenticated while being the
  POLICY/privilege selector (the unbounded lanes made it a target); the deployed lint checks marker
  existence only. → per-controller handles minted at registration; raw string-keyed admit lint-forbidden;
  lint asserts handle id = file marker; Tier-3 pins sink-side identity.
- **ADV5-3** — count-exempt lane MEMBERSHIP was open by declaration (any controller could claim
  `respawn-recovery`/`eternalSentinel`; `rateFloorMs: 1` unbounded-in-practice). → enumerated lint-bound
  allowlist + registry-declared `delegatedGiveUp` authority driven to trip by the fixture + code floor on
  `rateFloorMs`.
- **INT5-2 / ADV5-1 (double consensus)** — fail-direction for `kill`/`reaper`/`session-close` on governor
  ERROR was literally unspecified ("n/a (relief)" read as a decision, was an omission). → pinned
  OPEN-WITH-AUDIT + immediate errored-posture alarm (FD2; blocking relief under correlated failure is the
  worse direction; the pre-governor status quo was unbounded).
- **ADV5-2** — the relief `totalCountCeiling` static tuning premise was UNSATISFIABLE (legitimate relief
  load is population-proportional; no constant sits above worst-case-legit and below flood) — during a
  genuine mass incident the brake would throttle the reaper while the amplifying side ran free. →
  census-scaled ceiling `max(staticFloor, k% of live population)`/window + explicit designed degraded
  behavior + the operator relief valve named.
- **ADV5-4** — drain re-validation covered only governor-side pressure; a queued kill could fire on a NEW
  healthy incarnation (stable session names + volatile-key class collapse). → drain re-runs the
  controller's eligibility predicate + incarnation fence captured at enqueue (reject-on-mismatch,
  audited).
- **ADV5-5** — the retrofit made dual-use sinks (operator kills ride `SessionManager.killSession`)
  structurally deny a HUMAN's emergency action once a kill class enforces. → `origin: 'self'|'principal'`
  provenance set at operator-authenticated surfaces; principal lane always-allow + always-audited (FD13).
- **ADV5-6** — ALL admission state was in-memory; the storms that bounce the process (and self-triggered
  restarts) reset the count floor every time. → durable flush + recency-validated boot rehydrate (FD14).
- **SC5-1** — the queue's DISTINCT-TARGET axis (its own named growth axis, fed by two prior folds) had no
  ceiling, and `queueMaxDepth`'s scope was self-contradictory. → `queueMaxTargets` per-controller ceiling
  (same loud shed), scope wording reconciled, shed reporting P17-funnel-bound.
- **INT5-1** — the queue had no crash/durability semantics, no posture, no backup decision — the one v6
  surface holding real deferred intents <!-- tracked: CMT-1911 -->. → in-memory BY DESIGN (queue-eligible classes are
  level-triggered and re-generate) + restart-shed audit row + per-intent honesty; admission state is the
  durable half (FD14); posture/backup declared in §Multi-machine posture.
- **INT5-3 / LA5-2 (Standard B / P22, new-lens)** — the two governor-raised notices lacked the
  Self-Heal-Before-Notify contract; the demote alarm fired on first detection though re-promotion IS a
  self-heal. → demote alarm gated on heal EXHAUSTION (N failed cooldowns / flap / co-occurring
  hard-floor); transient cycles audit-only; full notice contracts (dedupe-key, latency ceiling, severity
  class, remediation, audit-location) for both notices; `lessons-engaged` P20–P23 declared; round-6
  lessons pass MUST read the canonical index (the local copy is stale at P19 — the same stale-copy trap as
  the gate false positive).
- **INT5-4 (Standard A, new-lens)** — per-class enforce-mode is per-machine state on a pool-shared
  resource; cross-machine mode skew silently halves the fleet guarantee (the coherence sentinel compares
  manifest-intersection keys only; class modes joined no compared dimension). → pool-shared class modes
  exported as compared coherence keys; per-POOL flip procedure stated.

### MINOR (folded)
- SC5-2 — FD9 level-evaluation read discipline pinned off the hot path (the pinned source does per-call
  sync file I/O in the deployed dist). SC5-3 — enqueue double-failure terminal defined (minimal
  policy-free path; audited drop + attention signal). SEC5-2 — numeric policy-override changes audited +
  `overridden` marker in posture (a cranked ceiling reads as loudly as a disabled flag). SEC5-3 — queue
  restart semantics stated honestly (subsumed into INT5-1's fold). ADV5-7 — mirror granularity fixture (N
  distinct stable targets → N independent ceilings; an all-collapsing coarse key fails). ADV5-9 —
  `emergencyDisable` flip raises an immediate audited attention item (flip-time, not probe-lagged; the
  disarm direction is the dangerous one). DC5-1 — queue fairness variant pinned (age-based promotion
  default; reserved slice = config variant). LA5-3 — parent-principle exactness (parent = Capacity Safety
  — the registry entry names this spec as its increment; Bounded Blast Radius → related). codex-r5 —
  normative companion PROMOTED to a required build-PR deliverable; observe-first wording sharpened
  ("registered and measured by construction; enforceable by construction"); respawn-recovery
  exception-evidence requirements (subsumed into ADV5-3's allowlist + delegated-give-up fold);
  alternatives table added. gemini-r5 — verdict explainability (aggregates + `reason` name the deciding
  sub-mechanism); optional pluggable external backend noted as a non-blocking extension point; normative
  companion (same fold as codex).

### Foundation audit (lessons-aware, mandatory-d) — SOUND (findings above excepted)
Verified against dist v1.3.780: P17 `AttentionTopicGuard.decide()` allow|coalesce/never-drop with
critical-never-coalesced holds; hostSpawnSemaphore dead-holder reclaim + foreign-hostname refuse-loud +
"never decline to bound" match the folds; `ExternalHogKillLedger` `(key, classId, keyIsVolatile)`
two-level match verified at the deployed source with `keyIsVolatile: false` wiring; ResumeQueue's
resurrection cap and the liveness-reconciler's P19 give-up are not only real but already UNIFIED
(`resurrectionCountForTopic` read by the reconciler) — strengthening the respawn-recovery
delegated-give-up design; the guard-posture polarity fix mirrors the deployed
`PermissionPromptAutoResolver` precedent; FD9's registered-machine count maps to
`PoolIdentityManager.getActiveMachines()` with real de-enrollment operations, so re-promote-on-de-enrollment
is actionable.

## Round-6 convergence-check findings (2026-07-05) — folded into v8

`/spec-converge` round 6 (on v7): six internal reviewers (claude-fable-5) + externals: codex-cli gpt-5.5
CLEAN run, "MINOR ISSUES"; gemini-cli gemini-2.5-pro DEGRADED (timeout) twice against the ~1300-line body
— the round carries a genuine cross-model pass via codex; the per-round gemini outcome is recorded
honestly and does NOT collapse the spec-level flag (a prior round's clean gemini pass exists).
Standards-Conformance Gate ran (1 flag — the SAME stale-registry false positive as round 5, re-confirmed
against the canonical registry, which also explicitly names this spec as the parent standard's follow-on
increment). decision-completeness: CONVERGED (frontloaded=15, cheap=4, contested-cleared=4). NO
structural findings against the core design — every MAJOR hardens round-5's own new surfaces ("each fold
introduces a little new surface" — the tail of convergence). All folded into v8.

### MAJOR (folded)
- **SEC6-1 / SEC6-2 / ADV6-1 (principal lane, triple consensus)** — the `origin` field was a
  caller-influenceable privilege selector (prose-only constraint), and the deployed kill routes stamp
  operator-origin for ANY Bearer holder — the agent itself holds that token, so an agent-scripted kill
  loop would ride always-allow AND audit as human. → the ordinary handle cannot express `principal`; a
  separate privileged API behind an enumerated module allowlist (lint-enforced); the stamp requires a
  HUMAN-principal signal (PIN / verified sender / mandate — "a Bearer token is structurally
  insufficient"); bare Bearer = `self`; volume-anomaly paging (codex-r6), never blocking.
- **SC6-1 / ADV6-2 / SEC6-6 (census, triple consensus)** — the one input that can WIDEN an enforcing
  relief ceiling had no read discipline: the example source does sync directory sweeps (would break
  `admitSync` if read per-admit), sampling time was undefined (mid-window re-read retroactively denies),
  and an INFLATED census (phantom/duplicate/foreign entries — potentially from the governed controller's
  own buggy enumeration) scales the kill budget with the bug. → cached integer off the hot path;
  roll-computed, widen-only mid-window; independent governor-owned source; `{value,asOf,confidence}` with
  confidence-gated widening; absolute code-constant clamp + clamp-hit audit.
- **SC6-2 / ADV6-5 / SEC6-5 (durable floor, triple consensus)** — cadence-only flush is defeated by a
  crash-loop bouncing faster than the interval (the floor never ratchets — cumulative-unbounded loss
  correlated with the storm), and missing/corrupt/deleted snapshots had no disposition (a silent
  budget-refill lever available to the governed loop). → async debounced eager flush
  (delta/half-ceiling/first-post-rehydrate/graceful-shutdown) + flush barrier before self-killing
  actions + pessimistic carry-forward; missing/corrupt-with-prior-flush-evidence → conservative posture
  + loud `state-reset` row (never-existed vs emptied per the registry-high-water pattern); flush async +
  size-bounded (SC6-4).
- **ADV6-3 / SC6-3 (errored-open relief path)** — cheaply reachable (a malformed config override throwing
  in policy evaluation) and unbounded once open, with per-emit audit rows re-introducing storm-rate disk
  amplification. → config overrides validated at LOAD (fall back to code default + audit); a POLICY-FREE
  code-constant last-resort rate floor paces the errored-open path; first-N + window-aggregated audit.
- **SEC6-4 / ADV6-4 (file↔controller binding)** — handle=marker still admitted a copy-pasted second file
  declaring an allowlisted marker id. → `models:` promoted to a lint-asserted file↔controller binding +
  marker-id uniqueness + runtime single-mint per id (duplicate → loud boot error).
- **INT6-1 (mode-skew mechanism, grounding catch)** — the v7 fold cited `GUARD_MANIFEST`, but the
  coherence sentinel compares ONLY `COHERENCE_CRITICAL_FLAGS` (no bridge exists) — the fold as written
  guarded nothing. → explicit new coherence-flag rows: an inverted-resolution governor row (the
  `meshTransport.enabled` precedent) + clamped scalar per-class mode rows for pool-shared classes (the
  `sessionPool.stage` precedent); feasibility verified (~18/64 rows used).
- **INT6-2 (Standard-B contracts for the three NEW raise paths)** — the flip item had per-flip semantics
  (a flapping writer = a flood), the errored alarm had no episode dedupe/severity, the enqueue-terminal
  signal was unbounded under bulk failure. → flip item episode-latched (N flips → one item, HIGH on
  disable) with its P22 tripwire basis stated; errored alarm level-triggered per episode, CRITICAL while
  relief enforces, P22 crashed-machinery basis stated; enqueue drops fold into the dead-letter coalesced
  notice as an `enqueue-drop` class (with ADV6-7, LA6-5).
- **LA6-1 (FD15 shipped-state honesty)** — "dark only at wiring" was too generous: the modules are pure +
  UNWIRED (only the deny-by-default `slice-renew` RPC pre-gate ships; in-memory store only; no holder
  handler; no requester loop) — failover re-derivation's no-double-allocation property needs the durable
  holder-shared store that does NOT ship. → §Resource scope/FD15 corrected; residual scope enlarged to
  six named deliverables (durable store, holder handler, requester transport, wiring gate + posture,
  replication, cached-read integration + denomination).
- **LA6-2 (foundation audit: ledger hygiene)** — the shipped grant ledger accumulates unboundedly
  (monotonic map, full rewrite per issuance) — composing it on a recurring renewal cadence would inherit
  the exact defect class this spec closes. → terminal-grant pruning/compaction on a bounded cadence;
  renewal cadence derived from slice TTL (never the 5 s control floor); Tier-1 O(outstanding) fixture.
- **SEC6-3 (single issuance authority)** — `SliceIssuer` is per-instance; both wiring gates on = two
  issuers each enforcing the full account ceiling (up to 2× over-allocation — dual accounting via dual
  INSTANCES). → invariant: ONE store + ONE fenced issuer per account regardless of gates; the governor is
  a slice CONSUMER against the same ledger; both-gates-on test asserts one shared outstanding-total.

### MINOR (folded)
- SC6-4 — flush async + size-bounded (folded into FD14). ADV6-6 — drain disposition pinned when fence
  absent AND predicate un-evaluable: audited drop, never fire-blind. ADV6-7 — errored-alarm +
  enqueue-drop dedupe/episode contracts (folded with INT6-2). INT6-3 — BackupManager exclusion via an
  explicit `BLOCKED_PATH_PREFIXES` entry (include-list omission is defeated by a user-added include;
  backups replicate cross-machine where a RECENT foreign snapshot passes recency-validation). INT6-4 —
  Standard-A key precision: pool-shared classes' admission state is per-machine slice-consumption
  records (its own justification), not `hardware-bound-resource`. INT6-5 — `restart-shed` fires on ANY
  boot with non-zero last-known population (clean shutdowns shed identically; the graceful path records
  its own final shed via the FD14 shutdown flush). DC6-1 — illustrative values pinned for the four
  symbolic constants (k ≈ 15%, censusAbsoluteMax ≈ 4× session cap, queueMaxTargets ≈ 64, rateFloorMs
  floor = 300,000 ms) in FD11. LA6-4 — transitions-audit enumeration completed (demote/re-promote,
  dead-letter shed, state-reset, census clamp). LA6-5 — P22 basis stated for the errored + flip alarms;
  frontmatter P22 entry widened to all four notices. codex-r6 — normative companion upgraded to
  implementation AUTHORITY; observe-limbo time-visibility nudge (30 d) added to FD12; principal-lane
  volume paging (folded into FD13); census-integrity + runtime green-gate (folded into the census
  discipline + FD15's runtime gate). gemini-r6 — degraded (timeout ×2); no findings to fold; recorded
  per-round.

### Fold-verification (round-5 folds, per the convergence-check mandate)
All five NOT-CONVERGED reviewers independently verified the round-5 folds they owned as GENUINE (not
papered over): queue axes/scope (SC), FD9 read discipline (SC), enqueue terminal (SC), controller-handle
triad (SEC — with the file-binding residual above), census concept (ADV — with the integrity residual
above), incarnation fence + eligibility re-check (ADV), principal-lane concept (ADV/SEC — with the auth
residual above), durable-state concept (ADV/SEC — with the flush-timing residual above), notice
contracts on demote + dead-letter (INT/LA — verified P22-compliant against the CANONICAL principles
index), FD15 module existence + all cited capabilities (LA — verified in dist; `WalledEnrollmentOffer`
absent as stated), parent-principle swap (LA — the canonical registry entry names this spec as the
standard's follow-on increment).

## Round-7 convergence-check findings (2026-07-05) — folded into v9

`/spec-converge` round 7 (on v8, the confirm pass): six internal reviewers (claude-fable-5) + externals
(codex-cli gpt-5.5 CLEAN "MINOR ISSUES"; gemini-cli degraded-timeout, third consecutive on the grown
body). Standards-Conformance Gate ran (1 flag — the standing stale-local-registry false positive,
re-confirmed). VERDICTS: scalability CONVERGED, lessons-aware CONVERGED, decision-completeness CONVERGED
(15/4/4; DC7-1/DC7-2 minors); security, adversarial, integration NOT-CONVERGED on FIVE distinct
one-sentence-pin MAJORs — every one round-6 fold text colliding with itself; every round-6 fold otherwise
verified GENUINE against dist v1.3.780. The adversarial reviewer's own close: "one more fold pass should
suffice."

### MAJOR (folded)
- **SEC7-1** — principal-lane disposition under an ERRORED governor was unpinned, and the last-resort
  floor is deliberately origin-blind: as written it would pace the operator's emergency mass-kill at the
  backstop rate during the correlated storm. → principal-origin fails OPEN unconditionally
  (respawn-recovery strength; a throwing `principalAdmit` resolves open); the floor is scoped to
  `origin: 'self'`.
- **ADV7-1** — FD11 classified the last-resort floor as "config-overridable," contradicting the body's
  "policy-free, code-constant" and re-opening ADV6-3 via a well-formed vacuous override. → the floor is
  one of two named FD11 overridability EXCEPTIONS: hard code constant, per-class-derived (SC7-3: the flat
  1/5s illustrative ≈ the flagship flood rate — now a small multiple of the class's static floor per
  window, a multiples-only backstop with the CRITICAL alarm as the 1× defense), evaluation reads NO
  config; `censusAbsoluteMax` pinned as tighten-only-below-code-ceiling via the audited surface (SEC7-3).
- **ADV7-2 / SC7-2** — eager-flush debounce edge semantics unpinned: trailing-edge + a crash-loop dying
  within ~1 s of first admission = every incarnation escapes every flush, and carry-forward at a ~0
  last-flushed rate contributes nothing; the round-6 fixture tested the cadence, not the debounce. → the
  first-post-rehydrate flush is IMMEDIATE/leading-edge; half-ceiling crossing debounce-exempt; fixture
  drives sub-debounce bounce periods; carry-forward gets a non-zero floor under prior-enforcement
  evidence.
- **INT7-1 / LA7-2** — the corrected coherence mechanism grounds cleanly EXCEPT the `demoted` value
  source: the shipped advert view is CONFIG-only and `demoted` is runtime latch state, so the naive build
  advertises `enforce` on a demoted machine — the alarm defeated silently. → the same-PR deliverable
  extends the caller-injected view with a governor-state accessor (`readSource: 'live'`), and includes
  the manifest-ratchet/membership test updates (INT7-4).
- **INT7-2** — the split-key fold named a justification OUTSIDE the closed Standard-A taxonomy (the lint
  itself would reject it). → the pool-shared admission-state content is declared `unified` — the local
  half of the surface whose replication half is FD15 deliverable (5); no taxonomy change.

### MINOR (folded)
- SEC7-2/SC7-4 — Standard-B contract for the principal-lane volume page (episode-latched, HIGH,
  P17-bound); frontmatter P22 entry widened to SIX notices (with INT7-5's FD12 nudge contract:
  one-shot per limbo episode, coalesced, routine). SEC7-3 — censusAbsoluteMax governance (folded with
  ADV7-1). SEC7-4 — multi-file controllers mint once + import; lint supports multiple markers/file +
  parseable path field (PromiseBeacon hosts two controllers; models: strings are prose-annotated).
  SEC7-5 — accepted local-fs-adversary residual stated (coordinated snapshot+aggregates deletion →
  fresh-install posture; transitions audit as third witness). SC7-1 — stale "per-emit" wordings in FD2 +
  one Tier-1 line restated to first-N/aggregated. SC7-3 — floor derived per-class (folded with ADV7-1).
  ADV7-3 — single-mint duplicate failure is controller-scoped errored posture, never process-fatal (the
  accidental dual-load residual; availability blast radius must stay smaller than what it guards).
  ADV7-4 — threat-model honesty: the PIN tier is a friction elevation vs buggy loops, not
  agent-impossibility (machine-local plaintext the agent is instructed to read), backstopped by
  always-audit + volume paging; the verifier-dark human valve is the `emergencyDisable` config edit.
  INT7-3 — telemetry-aggregates file joins the `BLOCKED_PATH_PREFIXES` exclusion. DC7-1 — illustrative
  values for the three remaining symbolic constants (delta ≈ 10, flip window ≈ 10 min, first-N ≈ 20).
  DC7-2 — floor override-exemption made explicit (folded with ADV7-1). LA7-1 — "imports" precision:
  NOTHING in dist imports either module; MeshRpc only defines the unwired seam. LA7-3 — two-channel
  interplay pinned: the early coherence episode on a mid-heal demote is the sanctioned multi-machine
  surfacing; channels dedupe independently. codex-r7 — companion carries the three-option tradeoff
  comparison; post-restart reasons name rehydrated state; break-glass vs ordinary-principal split noted
  as a future refinement (the emergency lane's unconditionality is not negotiable); companion-as-authority
  restated. gemini-r7 — degraded (timeout ×3); nothing to fold; recorded per-round.

### Fold-verification (round-6 folds)
Security: all six SEC6 folds verified genuine (privileged API + enumeration match; one-store/one-issuer +
both-gates-on test; lint promotion real vs the deployed marker-existence-only lint; reset dispositions +
BLOCKED_PATH_PREFIXES confirmed shipped; census quintet coherent). Adversarial: all seven ADV6 folds
verified (bare-Bearer→self is the material fix; census clamp/audit; errored-path mechanism; copy-paste
closure; reset levers; drain pin safe-by-construction; notice contracts complete). Integration: INT6-1
grounded EXACTLY (compared-source exclusivity, both precedents, 18/64, alphabet, version-skew
classification — with the INT7-1 residual); INT6-2/3/5 verified complete and deployable
(BLOCKED_PATH_PREFIXES at BackupManager.js:26 with both cited entries verbatim). Lessons: LA6-1..5 all
verified genuine against module internals (issue()/consume()/release() accumulation confirmed;
quota-fraction denomination verbatim; transitions enumeration complete; P22 bases legitimate canonical
arms); the coherence-manifest chain foundation-audited CLEAN for inheritance (bounded, receive-clamped,
episode-deduped, ratchet-tested).

## Round-8 convergence-check findings (2026-07-05) — folded into v10

`/spec-converge` round 8 (on v9, second confirm pass): six internal reviewers (claude-fable-5) +
externals (codex-cli gpt-5.5 CLEAN run, verdict "SERIOUS ISSUES" — all five findings recurring meta
themes, see below; gemini-cli degraded-timeout, 4th consecutive). Standards-Conformance Gate ran (the
standing parent-principle false positive + two new flags, both engaged and dispatched by the
lessons/integration reviewers: "No Unbounded Loops" — a misread of the FD1 graduation ladder, answered
with the INT8-2 scope-honesty sentence; "Mobile-Complete Operator Actions" — legitimate, answered with
the LA8-2/INT8-3 valve layering). VERDICTS: scalability, decision-completeness (4th consecutive),
lessons-aware, integration CONVERGED; security + adversarial NOT-CONVERGED on ONE MAJOR each — both
one-sentence mechanism pins on v9 fold text, both stating convergence expected once folded.

### MAJOR (folded)
- **SEC8-1 / ADV8-3** — the mint-once-IMPORT pattern for multi-file controllers exports a handle ANY
  file can import, and the deployed lint's scan surface (controller-shaped/marker-carrying files only)
  never scans a rogue helper file — the SEC6-4-closed privilege borrow re-opened one import away, with
  the unbounded lane as the prize. → the lint's scan scope is pinned CODEBASE-WIDE over handle USAGE
  (`for()` AND `admit()` on an imported handle); handle use in a file without a matching marker fails the
  build; exempt-lane handles are never exported beyond the controller's allowlisted files.
- **ADV8-1** — the single-mint defense was instance-scoped, and its own named residual case (accidental
  dual-package/duplicated-dist load) duplicates the whole module graph including the registry — each copy
  sees one clean claim, no collision fires, and the flagship in-memory-CAS classes run ~2× budgets with
  two uncoordinated snapshot writers (a partial budget refill, the unsafe direction). → the mint registry
  + the in-memory admission-state anchor key on a process-GLOBAL `Symbol.for` token (the standard Node
  dual-instance pattern); cross-copy claims collide into the already-specified controller-scoped errored
  posture; Tier-1 dual-load fixture added.

### MINOR (folded)
- SEC8-2 — errored-window instrumentation honesty: the volume counter/audit are governor machinery and
  may be dead during the errored episode; the CRITICAL errored alarm is the covering signal. ADV8-2 —
  transitions enumeration completed (principal-volume-anomaly episode, observe-limbo nudge) + the
  per-admit principal-row carve-out named explicitly. ADV8-4 — LA7-1 grounding made grep-proof (one
  type-only declaration-file import exists and erases at runtime). SC8-1 — the stated flush residual is
  coupled to the debounce interval. INT8-1 — FD14 wording matched to the body's leading-edge pins (the
  round-3 FD-drift lesson). INT8-2 — observe-window scope honesty: "existing guards still apply" is
  retrofit-only; a green-field controller's observe window is the stated accepted residual (time-bounded
  by FD12, visible via aggregates, Increment-E review gate as the authority for interim brakes /
  expedited flips). INT8-3/LA8-2 — the Mobile-Complete valve layering: conversational primary,
  PATCHABLE_CONFIG_KEYS addition named as a deliberate deliverable (the deployed allowlist would 400
  `intelligence.*` today), file edit as the verifier-independent floor. INT8-4 — FD12 nudge contract
  field symmetry (max-latency + remediation). LA8-1 — the retrofit is ADDITIVE at every rung: enforce
  graduation never licenses removing an incident-earned bespoke brake; double-bounding is the intended
  defense-in-depth. DC8-1/DC8-2 — companion-pinned illustratives (floor multiple ≈ 3–5×; volume-page
  threshold + re-arm). codex-r8 — recurring meta (companion primacy; phase-1 scope = the ladder already
  sequences it; principal split stays a named extension point with the emergency lane non-negotiable;
  alternatives decision-record + mechanical terminology as required companion sections). gemini-r8 —
  degraded (timeout ×4); recorded per-round.

### Fold-verification (round-7 folds)
All five round-7 MAJOR pins verified GENUINE by the owning reviewers with line-level grounding: SEC7-1
unambiguous and collision-free across §Fail-direction, FD2, FD13, and the Tier-1 test (the API-layer
separation makes the origin-blind floor structurally unable to see principal traffic); ADV7-1 watertight
(the vacuous-override fixture catches the last plausible misreading behaviorally); ADV7-2 fully closed
(leading-edge per-boot flush guarantees ≥1 durable admission per bounce; sub-debounce fixture; carry
floor); INT7-1 concretely buildable (injection-constructed view verified at the deployed heartbeat
callsite; readSource is a real hashed per-row field; in-module special-case precedent exists; 18/64
exact); INT7-2 Standard-A clean (unified is the marker-absent default; the deployed lint's own header
declares it; no marker line to mis-fire on). Grounding spot-checks all pass (PromiseBeacon dual-controller
file; prose-annotated models: strings; MeshRpc ?? false seam; BLOCKED_PATH_PREFIXES entries verbatim;
deployed lint marker-existence-only).

## Round-9 convergence-check findings (2026-07-05) — CONVERGED

`/spec-converge` round 9 (on v10, third confirm pass): six internal reviewers (claude-fable-5) +
externals (codex-cli gpt-5.5 CLEAN run — verdict text repeats rounds-7/8 meta themes, all already
engaged in-body, non-material as repeats; gemini-cli degraded-timeout, 5th consecutive). VERDICTS: ALL
SIX INTERNAL REVIEWERS CONVERGED — decision-completeness with ZERO findings (5th consecutive, 15/4/4);
security, scalability, integration, lessons-aware, adversarial each with only explicitly non-blocking
one-clause MINORs. Standards-Conformance Gate: the standing parent-principle false positive
(re-confirmed against canonical a 5th time). Convergence criteria: (1) no material new issues — MET;
(2) §Open questions empty — MET (verified mechanically by the tag writer).

### Round-9 MINORs and their disposition
- **ADV9-2** (folded into the spec, this batch) — errored-alarm Standard-B field completion
  (max-latency, remediation, audit-location) + `errored-episode open/close` and `mint-collision`
  transitions rows: the SEC8-2 covering signal now carries a durable trace.
- **ADV9-3** (folded into the spec, this batch) — the green-field observe-window time bound was
  overclaimed (a storming controller never meets the criterion, so the limbo clock never starts):
  wording corrected + the INVERSE nudge added (sustained would-deny above the flip floor on a
  no-bespoke-brake controller raises the one-shot coalesced posture item).
- **ADV9-1, ADV9-4, INT9-1, INT9-2, SC9-1, SEC9-1, LA9-1, DC8-1/DC8-2** — REQUIRED COMPANION CLAUSES,
  enumerated verbatim in the Status head. Each is a one-clause pin on build mechanics (anchor lifecycle,
  PATCH granularity + disable-direction gating choice, lint self-scope, test-reset, value-passing
  widening, template valve naming, illustrative constants); none changes the design.

### Fold-verification (round-8 folds)
SEC8-1/ADV8-3 verified genuine (usage-scan pin + never-export clause + the Tier-1 helper-file fixture;
grounding verbatim against the deployed lint's self-declared controller-shape scope). ADV8-1 verified
genuine end-to-end (process-global single-mint precludes interleaved dual budgets by construction; the
shared anchor precludes dual writers; collision resolves into the contracted controller-scoped errored
posture; dual-load fixture present). SEC8-2, ADV8-2, ADV8-4, SC8-1, INT8-1..4, LA8-1/LA8-2 all verified
landed, with ADV8-4's precision grep-proof (exactly one type-only .d.ts import; zero runtime callers;
the `?? false` seam verbatim at the deployed MeshRpc callsite).
