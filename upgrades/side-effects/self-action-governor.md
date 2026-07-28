# Side-Effects Review — SelfActionGovernor (unified self-action backpressure, Increment B)

**Version / slug:** `self-action-governor`
**Date:** `2026-07-10`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `dedicated reviewer subagent (high-risk: governor/gate surface)`

## Summary of the change

Builds the runtime primitive the converged spec `docs/specs/unified-self-action-backpressure.md` (approved 2026-07-05; the companion `unified-self-action-backpressure.companion.md` is the implementation authority) defines: `SelfActionGovernor` (`src/monitoring/selfaction/{types,policies,anchor,governor}.ts`) — ONE in-process admission chokepoint for self-triggered actions, keyed on controller id, with count/rate/breaker ceilings, a bounded coalescing queue, capability tokens, a principal lane, durable admission state, and a per-class fail matrix. Ships OBSERVE-ONLY on every class, fleet-wide (FD1): admit() records would-verdicts and ALWAYS allows. Retrofits the five registry-modeled controllers additively (SessionManager age-kill, ProactiveSwapMonitor both paths, PromiseBeacon heartbeat + liveness, ExternalHogScanTick kill). Adds `GET /self-action-governor`, the nested-path PATCH /config validator (PIN-gated disable direction), guard-posture + coherence rows, the `lint-emit-without-admit` usage-scan lint, registry field additions (`modelsPath`, `delegatedGiveUp`), CLAUDE.md template section + `migrateClaudeMd`, state-registry/retention/backup-exclusion declarations, and the three-tier test battery (122 new unit tests + 10 integration + 4 e2e + the generalized convergence ratchet).

## Decision-point inventory

- `SelfActionGovernor.admit()/admitSync()` — **add** — the new admission gate; in observe mode (the ONLY shipped mode) it never blocks: every verdict resolves to an allow-token, would-denies are recorded.
- `consumeAdmissionToken()` sink guards (5 sites) — **add** — signal-only in observe mode (`proceed: true` always); blocking exists only behind a per-class enforce flip no fleet config sets.
- `PATCH /config` — **modify** — adds a nested-path validator branch for `intelligence.selfActionGovernor` (previously the whole `intelligence` key 400'd); the disable direction is PIN-gated.
- `DELETE /sessions/:id` + `POST /sessions/:name/remote-close` — **pass-through** — an optional PIN-proof header records principal provenance on the always-allow audited lane; the kill itself is untouched (same terminateSession call, same origin stamp).
- Retrofitted emit paths (age-kill, proactive swap ×2, beacon send, hog kill) — **modify** — an observe-mode admit + token consume is inserted BEFORE each existing emit; all existing brakes retained (additive retrofit, LA8-1).
- P17 attention funnel — **pass-through** — six governor notices ride the injected `createAttentionItem` seam (the existing AttentionTopicGuard chokepoint), never a new send path.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

In the SHIPPED state (observe-only, every class): nothing — every admit resolves to an allow-token, including under a throwing governor (observe branch of the fail matrix allows), an uninitialized governor (disabled-passthrough), and a dead dual-load handle (errored-open → allow for observe). The three enforce-only rejection surfaces (policy deny → queue/coalesce, sink `proceed:false`, last-resort errored floor) are structurally unreachable without a per-class `mode: 'enforce'` config override no default sets — and pool-shared classes auto-demote at registered machine count > 1 even then (FD9). One PATCH-surface narrowing is deliberate: `PATCH /config` with `intelligence.<anything-but-selfActionGovernor>` now 400s with a named reason — previously the whole `intelligence` key 400'd generically, so no previously-legal input is newly rejected. The PIN gate rejects a bare-Bearer `emergencyDisable: true` — deliberate (ADV9-4), and two verifier-independent valves remain (conversational config edit; raw file edit).

## 2. Under-block

**What failure modes does this still miss?**

- Observe mode measures but bounds nothing — a live runaway loop today is still bounded only by its bespoke brake (stated FD1 posture; the enforce flip is the operator's later action, nudged by FD12 observe-limbo + the inverse storm nudge).
- The ~18 non-retrofitted emit sites don't ride admit() yet (staged follow-up PRs <!-- tracked: CMT-1911 -->); the lint binds only sites that USE the governor — it cannot force a site that never imports it (that forcing job belongs to the existing `lint-no-unregistered-self-action`, report-only until the classClosure flip).
- The usage-scan lint is a string-level guard: deliberate obfuscation (`const g = governor; g['f'+'or'](...)`) evades it — same honest coverage limit the sibling lint states; the runtime single-mint + sink consume are the backstops.
- Coordinated local-fs deletion of snapshot + aggregates degrades to fresh-install posture (spec-accepted residual, SEC7-5).
- The PIN tier defeats buggy runaway loops, not a deliberately adversarial self that can read machine-local config (spec-stated threat-model honesty, ADV7-4; covering controls: per-admit principal audit + volume page).

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes — this IS the layer consolidation the spec exists for: the generalization of the host-spawn-semaphore (which stays at the provider layer, never re-acquired — FD4) and P17 (which stays the notify coalescer; the governor's notify classes fold INTO it, and all six notices ride the existing attention funnel rather than a parallel send path). It composes existing primitives (token bucket, P19 breaker, count ceiling, bounded queue) behind one Admission contract instead of re-implementing any; the registry's proven `boundK`/`perTargetBoundK` seed the runtime ceilings; the ExternalHogKillLedger's (key, classId, keyIsVolatile) triple is mirrored, not replaced. The existing bespoke brakes stay where they are (additive retrofit) — the governor is defense-in-depth above them, not a replacement.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic?**

Reference: `docs/signal-vs-authority.md`. In the shipped state the governor is a pure SIGNAL producer: would-deny aggregates, transitions audit, six P17-funneled notices — zero blocking authority anywhere. The blocking authority it CAN hold (per-class enforce) is (a) deterministic count/rate arithmetic — the sanctioned deterministic-ratchet class, not heuristic content judgment; (b) gated behind a deliberate per-class operator flip (FD8) with a review-gated promotion criterion (FD12); (c) fail-safed per class so a broken governor never blocks relief (open-with-audit + config-immune floor), never strands cost/safety work (closed-to-QUEUE, never drop), and never touches a human action (the always-allow principal lane). The `emit-without-admit` lint is a deterministic build-time ratchet (the sanctioned lint class, twin of `lint-no-unbounded-llm-spawn`). No brittle string-matching holds runtime blocking authority.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race?**

- Bespoke brakes (AgeKillBackoff, swap anti-thrash, beacon suppression, hog kill-ledger) run FIRST; the governor sees only what they let through — double-bounding is intended (tightest bound wins), and in observe mode the governor changes nothing they decide.
- The governor's admit sits between the KEEP-guard veto path and terminateSession in SessionManager — in observe mode it cannot flip a keep/kill decision; the ReapAuthority funnel and its lease/KEEP gates are untouched.
- The P17 funnel is the single notice path — the six governor notices are budget-subject like every other attention source (no new topic-creation surface).
- Anchor single-mint vs vitest module graphs: test environments get a per-graph anchor (key-salt design) so unrelated test files can never cross-collide; production uses the real `Symbol.for` global.
- The slow tick (60s, unref'd) samples census/config/drains queues — it reads `state.listSessions()` through the existing memoized cache, no new hot-path I/O; `admitSync` is zero-I/O by construction except the debounce-EXEMPT eager flushes (the once-per-boot leading-edge rehydrate flush + at most one half-ceiling-crossing flush per class per window — both spec-mandated event-aware flush edges, ADV7-2/SC6-2; each a try/catch-wrapped ~few-KB temp+rename that can never affect the admission outcome).
- PATCH /config: the sag branch runs BEFORE the generic allowlist check and removes its keys from the generic loop — no double-application; `pin` is stripped so it can never land in config.

## 6. External surfaces

**Anything visible to other agents/users/systems?**

- New Bearer route `GET /self-action-governor` (scrubbed: no target identities, no absolute quota values); `?scope=pool` fans out to peers' same route (rate-limited 6/min, URL-allowlist-guarded, dark-peer-tolerant — the /guards pattern).
- Six operator notices, all attention-funnel-bound and episode-latched/coalesced — worst-case notice volume is bounded by construction (dedupe keys per companion §8).
- The advert grows three coherence rows (~120 bytes) — within the MC byte budgets (ratchet tests pass); older peers treat unknown keys as version skew (the designed path).
- Timing dependence: `emergencyDisable` live-read is cached ≤1s; flip observation latency ≤ max(1s, next admit/slow-tick) — documented in the template section ("read live, no restart").

## 7. Multi-machine posture (Cross-Machine Coherence)

- Hardware-bound class state (age-kill, hog, respawn): **machine-local BY DESIGN** — the resource is this host's (`machine-local-justification: hardware-bound-resource`); counters served machine-local.
- Pool-shared classes (swap/notify): counters **proxied-on-read** via `?scope=pool`; their window buckets are declared `unified` in the spec's taxonomy — the LOCAL half of the FD15-replicated surface whose replication half is the deferred pool-ceiling deliverable <!-- tracked: CMT-1911 -->; until then they are structurally prevented from enforcing on a multi-machine pool (FD9 auto-demote, level-triggered on REGISTERED count, re-promote only on de-enrollment).
- Mode coherence: per-class mode rows + the inverted governor row join `COHERENCE_CRITICAL_FLAGS`, read LIVE via the governor-state accessor on the advert view — cross-machine mode skew raises the standard machine-coherence alarm.
- Durable files (snapshot + aggregates) are BackupManager-excluded via `BLOCKED_PATH_PREFIXES` — a foreign restore would carry the wrong machine's counts / fabricate prior-flush evidence.
- One-voice: notices route through this machine's attention funnel only (no cross-machine sends). No generated URLs. No durable state strands on topic transfer (admission state is per-machine by design; queued intents are in-memory level-triggered regenerables with restart-shed honesty).

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Cheap, layered: (1) `intelligence.selfActionGovernor.emergencyDisable: true` — live-read, no restart, degrades every class to unconditional pass-through (the flip is audited + surfaced, by design); (2) per-class numeric/mode overrides for a single misbehaving class; (3) full revert — the retrofit is five small additive blocks + wiring, no data migration, no config migration (`migrateConfig` writes nothing), no schema change; deleting the two state files after a revert is safe (they are advisory admission history). The CLAUDE.md template section is content-sniffed append-only (idempotent, non-destructive). Worst production wedge identified: none blocking — observe mode cannot withhold an action; the only new synchronous work on hot paths is in-memory arithmetic plus the once-per-boot flush.

---

## Second-pass review

**Reviewer subagent verdict (independent audit, 2026-07-10):** Concur with the review.

- Observe-only cannot withhold — verified on every path: uninitialized deps / emergencyDisable → unconditional allow (`admitFor`); dead mint-collision handle + throwing `evaluate` route to `failDisposition`, which returns allow for any non-enforce mode and allow-unconditional for the respawn-recovery lane; a policy deny in observe/demoted mode returns allow via `nonAllow` (would-deny recorded). `consumeToken` returns `proceed: !enforcing` on every rejection. Shipped defaults set no enforce anywhere (`freshClassState` starts observe; mode overrides come only from config).
- All five retrofits are additive, non-throwing, and sit before the emit: SessionManager (non-allow → continue; ageKillBackoff + KEEP-guard/ReapAuthority untouched); ProactiveSwapMonitor ×2 (non-allow → continue inside existing try blocks; anti-thrash/deferral/pile-on brakes intact); PromiseBeacon (non-allow → fold, hot-state cadence still advances so a fold can't tight-loop); ExternalHogScanTick (non-allow → alert-only + surfaceLeftAlive, never silent). The diff removes zero brakes.
- PATCH /config confinement holds: sibling `intelligence.*` keys 400 before anything is written; the disable direction rides `checkMandatePin` (sha256 + timingSafeEqual + durable rate-limited lockout); `pin` can never land in config on either path; the sag subtree is removed from the generic merge loop (no double-application).
- Anchor test isolation cannot leak into production: the module-local symbol resolves only under VITEST/NODE_ENV=test; the key-salt override requires an explicit globalThis assignment; production resolves the real `Symbol.for` key; `resetAnchorForTest` throws outside a test env without force.
- No unlisted material risk found: all six notices are episode/window-latched and ride the P17 attention seam (per-source topic budgets bound a pathological reopen ping-pong); audit buffer (512), file retention (5,000 rows), and token map (4,096) are bounded; a throwing flush can never reroute an admission. `lint-emit-without-admit` passes over the full tree (1,494 files, 0 violations).
- One precision nuance (folded above, non-blocking): the eager-flush wording in §5 now names BOTH debounce-exempt synchronous flush edges (leading-edge post-rehydrate + once-per-window half-ceiling), not just the boot one.

---

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure:** `guard` — **enforcement:** `ratchet` — **citation:** `tests/unit/self-action-convergence.test.ts`
- **How caught (convergence argument):** the generalized convergence ratchet drives every registered controller's worst-case emissions THROUGH `SelfActionGovernor.admit()` in enforce mode and asserts the steady-state action count stays bounded at each model's proven `boundK` — horizon-independent (fixed-bucket sliding windows with NO episode reset for relief classes; the demote latch re-promotes only after a clean cooldown dwell, so the floor cannot flap). Eternal sentinels stay rate-floored (never count-bounded, never starved), and the P19 breaker + per-target/total count ceilings make every retrofitted loop converge rather than storm. The `lint-emit-without-admit` usage-scan lint is the completeness half: a controller cannot mint/borrow a looser class's ceiling by construction.

## Addendum (same PR, parity commit)

The delivery-completeness parity guard caught that the new CLAUDE.md governor section was absent from `migrateFrameworkShadowCapabilities` markers[] — added (plus the featureSections registry entry), so Codex/Gemini agents receive the capability block too. No runtime surface beyond the migrator's existing marker-mirroring mechanics; idempotent by the same content-sniff.

## Addendum 2 (same PR, CI-ratchet conformance commit)

Two CI ratchets caught conformance gaps, both folded: (1) the no-silent-fallbacks ratchet — the governor's boot-init catch in `src/commands/server.ts` now reports through DegradationReporter (never-silent degradation; admits resolve disabled-passthrough for the boot, behavior unchanged); (2) the G3 load-bearing manifest lint — the `intelligence.selfActionGovernor.enabled` GUARD_MANIFEST entry now declares its uniform `soakWindowDays`/`declaredLoadBearingAt` fields (the guard reports enabled/never-dryRun, so no gap/soak posture arises in the shipped observe-only state).
