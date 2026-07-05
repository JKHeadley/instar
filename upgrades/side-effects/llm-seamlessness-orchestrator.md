# Side-Effects Review — LLM-Driven Seamlessness Orchestrator (lease-gated, propose-only, preload-focused)

**Version / slug:** `llm-seamlessness-orchestrator`
**Date:** `2026-07-05`
**Author:** Echo (autonomous)
**Second-pass reviewer:** not required (multi-reviewer spec-converge already ran on the spec, incl. cross-model codex-cli:gpt-5.5)

## Summary of the change

Adds a lease-gated tier-1 LLM loop that ANTICIPATES which working-set artifacts a conversation will
need next and PROPOSES a bounded, side-effect-free preload — modeled on the `CartographerSweepEngine`
pattern (a pure engine + a separate cadence poller). It is **propose-only / signal-only**: the LLM
NEVER authors a machine-move; placement stays with the deterministic `RebalancePlanner`/`PlacementExecutor`.
The first PR ships spec **Phases 1-3** (skeleton + guards + brakes); Phases 4-5 (live auto-prefetch, the
feedback-outcome memory) are the spec's own operator-gated later increments. Implementation:

- **`SeamlessOrchestratorEngine.ts`** (new, pure) — `pass()` is lease-gated at entry (F2 → standby no-op),
  suspends under load-shed pressure (F7), reads bounded top-N active topics + their `ready` working-set
  rows (injected readers, NO HTTP in the engine), ranks DETERMINISTIC-FIRST (recency/running), and invokes
  the LLM residual ONLY when there is no clear deterministic winner (F4 A/B-lift gate) on the `LlmQueue`
  `background` lane inside a neutralized `<untrusted-data>` envelope. Emits ≤3 deduped proposals (F6).
- **`OrchestratorActuator.ts`** (new) — the guarded actuation layer: re-validate-at-execute (compare-and-act,
  FAIL-CLOSED), yield-to-failure-movement, respect pins + user provenance, per-window disk-byte budget,
  audit-BEFORE-actuate; a `preload-artifact` is the ONLY ever-auto action (side-effect-free fetch); a
  `placement-signal` writes evidence to the planner and NEVER moves. `dryRun` logs would-actuate + audits and
  actuates NOTHING.
- **`OrchestratorPoller.ts`** (new) — `IdleAwareCadence`-driven, reentrancy-guarded; drives `engine.pass()` →
  `actuator.actuate()` per proposal → records the per-topic actuation time (feeds the F6 cooldown); idle-backoff
  + a coarse consecutive-error breaker. Modeled on `CartographerSweepPoller`.
- **`OscillationBreaker.ts`** (new) — the F6 sliding-window blacklist: ≥3 actuations of a topic in a window →
  blacklist (suppressed from proposals) for a TTL, with a one-shot trip signal (one attention item per episode).
- **Routes** — `POST /intelligence/seamless-orchestrator/tick` (a manual soak tick) + `GET .../audit` (the
  bounded audit tail + last-tick surface); both 503 when the orchestrator is dark.
- **Server wiring** — a dev-gated-dark (`resolveDevAgentGate`), dryRun-first construction block in `server.ts`
  that injects the readers/actuator-deps as tick-time closures over the existing seams (`sharedLlmQueue`,
  `leaseCoordinatorRef.holdsLease()`, `sharedPressureTier()`, `ParallelActivityIndex.activities`, #4's
  `WorkingSetArtifactManager.getReadyRows`, `workingSetPullCoordinator.fetchWorkingSet`); threaded into
  `RouteContext` via `AgentServer`.
- **Config** — `multiMachine.seamlessOrchestrator` (dryRun-first, `enabled` omitted so the dev-gate resolves it)
  in ConfigDefaults; ships to existing agents via `applyDefaults()` deep-merge (Migration Parity).

Files: `SeamlessOrchestratorEngine.ts` (new), `OrchestratorActuator.ts` (new), `OrchestratorPoller.ts` (new),
`OscillationBreaker.ts` (new), `commands/server.ts`, `server/AgentServer.ts`, `server/routes.ts`,
`config/ConfigDefaults.ts`, `core/WriteDomainRegistry.ts` + 5 test files (engine/actuator/poller/breaker/route) +
1 modified test (dark-gate golden map).

## Decision-point inventory

This change adds NO block/allow decision point that gates a user or another agent. Every "decision" is a
propose/suppress signal or a self-guard on the orchestrator's OWN optional action.

- Engine deterministic-first + A/B-lift gate (`SeamlessOrchestratorEngine`) — **add** — decides whether to
  spend an LLM call; a "no" runs deterministic-only (a complete result), never a block.
- Actuator guards (`OrchestratorActuator`) — **add** — decide whether the orchestrator's OWN preload may run;
  a refusal is a bounded no-op (nothing moves), never a user-facing block.
- `OscillationBreaker` — **add** — suppresses re-proposing a thrashing topic; suppress-only, self-clearing.
- `POST /intelligence/seamless-orchestrator/tick` — **add** — a Bearer soak trigger; 503 when dark, no block surface.

---

## 1. Over-block

No user/agent block surface — over-block not applicable. The nearest "reject" is the actuator refusing to
preload (pinned/provenance/failure-episode/budget) — a bounded no-op that moves nothing; and the oscillation
breaker suppressing a thrashing topic. Neither denies a user or peer anything; they only decline the
orchestrator's own optional optimization.

## 2. Under-block

No block surface — under-block not applicable. The honest coverage gap by design: under `dryRun` (the shipped
default) NOTHING actuates, so the actuation guards + oscillation breaker are exercised only for AUDIT rows — they
become load-bearing ONLY after the operator flips the P4 live increment. The precise pin/provenance/episode
sourcing behind `revalidate()` is a tracked prerequisite for that flip (see Tracked deferrals) — not a defect
in the dark ship, where no guard decision has any effect.

---

## 3. Level-of-abstraction fit

Correct layer. This is a lease-gated background OPTIMIZER that PROPOSES; it re-uses existing authorities rather
than re-implementing them. Placement stays with `RebalancePlanner`/`PlacementExecutor` (the orchestrator only
feeds a signal). The preload rides the existing `WorkingSetPullCoordinator.fetchWorkingSet` (with its slices,
hash-verify, caps, `PendingPullLedger`). The LLM call rides the existing `LlmQueue` (background lane + daily cap).
Pressure rides `sharedPressureTier()`; the lease-gate rides `leaseCoordinatorRef`. The engine/poller split mirrors
the shipped `CartographerSweepEngine`/`CartographerSweepPoller`.

## 4. Signal vs authority compliance

- [x] No — this change produces signals consumed by existing smart gates / has no block-authority surface.

The whole feature is the constitutional "an LLM loop is signal-only unless authority is earned + gated" applied
literally: the LLM emits a preload PROPOSAL or a placement SIGNAL; it never self-authorizes a move on a predicate
it evaluates itself. The one ever-auto action (`preload-artifact`) is side-effect-free (a local copy lands; no
ownership/lease mutation) and rides the coordinator's own refusals. The dark→dryRun→live ladder is operator-only,
one increment at a time.

---

## 5. Interactions

- **Shadowing:** the routes are new; nothing pre-existing shadows them. The orchestrator ADDS a background poller
  beside the Cartographer/autonomous-heartbeat pollers; it reads shared state, writes only its own audit logs.
- **Double-fire:** the poller is reentrancy-guarded (a second tick while one runs is a no-op); the actuation cooldown
  (F6, injected `lastActuatedAt`) + dedupe (`topic+action+target`) + the oscillation breaker prevent re-proposing.
  It yields to failure-movement (mesh-self-heal wins) so it never fights a recovery move.
- **Races:** the engine is pure + single-flight (`inflight` guard). The per-window byte budget + per-topic cooldown
  are in-process counters read at tick time; a stale read only ever UNDER-proposes (the safe direction).
- **Feedback loops:** bounded by construction — ≤3 proposals/tick, per-topic 30m cooldown, the oscillation breaker
  (blacklist after 3-in-window + give-up), the poller error-breaker, and the `LlmQueue` daily spend cap. Under
  `dryRun` there is no actuation to feed back at all.

---

## 6. External surfaces

- **Other agents on the same machine:** none — the orchestrator is a per-machine lease-gated optimizer; its routes
  are Bearer-auth API.
- **Install base (Migration Parity):** existing agents receive the `multiMachine.seamlessOrchestrator` config block
  via `ConfigDefaults` deepMerge (the established multiMachine-subblock path). No new hook, no settings.json change.
  On the fleet the dev-gate resolves the feature OFF, so it is never constructed — zero runtime cost.
- **External systems:** none (Telegram/Slack/GitHub/Cloudflare untouched). The only external-ish call is the
  in-process `LlmQueue` background lane, itself gated by the A/B-lift gate + daily cap + `dryRun`.
- **Persistent state:** NEW append-only logs under agent-home `logs/` (`orchestrator-actions.jsonl` +
  `orchestrator-placement-signals.jsonl`) — per-machine soak evidence, never converged, rebuildable. The
  oscillation-blacklist is in-process memory (not persisted this increment).
- **Timing/runtime:** a 15m-cadence background poller when enabled; on the fleet (dark) it is never constructed.

"No operator-facing actions" — the routes are Bearer-auth API; there is no dashboard form, grant/revoke, PIN gate,
or secret-drop surface.

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches no `dashboard/*` renderer/markup, approval page, or
grant/revoke/secret-drop form. The only human-visible artifact is the audit log (read via the Bearer `GET .../audit`).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local (lease-gated), with a replicated safety follow-up.** The orchestrator runs ONLY on the lease
holder (F2) — a standby machine's `pass()` is a strict no-op — so exactly one machine optimizes at a time; there
is no cross-machine double-optimize. Its audit logs are per-machine soak evidence (never converged). The ONE piece
of state the spec says SHOULD replicate is the oscillation-blacklist (so "don't move topic T again" survives a lease
failover, spec §85) — that WS2 replication is a tracked follow-up (see Tracked deferrals), load-bearing only after
the P4-live flip; a machine-local blacklist degrades safely (a new lease holder re-learns the thrash) and moves
nothing on its own. A single-machine agent holds its own lease and runs locally — a strict no-op cross-machine.

- **User-facing notices:** none in the dark ship (the oscillation trip is a `console.warn`; the deduped
  attention-item raise is a tracked P4-live prerequisite). No Telegram/one-voice surface.
- **Durable state on topic transfer:** the audit logs are machine-local by design and do not need to follow a move.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Hot-fix release:** the whole feature ships dark (dev-gate OFF on the fleet; `dryRun:true` even on a dev agent).
  Set `multiMachine.seamlessOrchestrator.enabled:false` (or leave it dev-gated) and it is never constructed. To
  fully back out: revert the change and ship a patch.
- **Data migration:** the only persistent state is the append-only audit logs under `logs/` — orphaned harmlessly
  on rollback (or deleted); no schema/column migration, no downtime.
- **Agent state repair:** none. The ConfigDefaults addition is idempotent and inert while dark.
- **User visibility:** none while dark.

---

## Conformance fixes surfaced by the local ratchet pass (pre-push)

The four constitutional-enforcement ratchets were run LOCALLY before pushing (the #4 lesson — targeted local test
runs don't exercise them). Each was a real, correct requirement, fixed:

- **Dark-gate golden map** (`lint-dev-agent-dark-gate`): the `seamlessOrchestrator` block at the TOP of the
  `multiMachine` ConfigDefaults block shifted every subsequent `enabled:` line by +21; the hand-authored dotted-path
  map was updated by hand (12 entries).
- **Write-domain classification** (`write-domain-conformance-ratchet`): `POST /intelligence/seamless-orchestrator/tick`
  is classified in `WriteDomainRegistry` as `machine-local` with an `ephemeral-rebuildable` convergence story
  (per-machine append-only logs under agent-home `logs/`, outside git, never converged) — modeled on the
  review-canary soak trigger. `GET .../audit` is read-only (correctly not flagged).
- **No Silent Fallbacks** (`no-silent-fallbacks`): three intentional deterministic-first catches (LLM-residual →
  deterministic ranking, unparseable-residual → null → deterministic, poller tick-error → onError + breaker) are
  annotated `@silent-fallback-ok`; none is a data-loss fallback (back to the 491 baseline).
- **Compaction Parity** (`session-context-compaction-parity`): N/A — the orchestrator adds no `/session-context`
  injector.

## Tracked deferrals (P4-live prerequisites) <!-- tracked: topic-29836 -->

The first PR ships spec Phases 1-3 (the dark/dryRun skeleton + guards + F6 brakes). The following are the spec's
OWN operator-gated later increments — each is load-bearing ONLY after the operator flips `dryRun:false` / enables
the P4 auto-prefetch increment, and each is enumerated here (not silently dropped) per Deferral = Deletion:

- **revalidate() precise sourcing** — `OrchestratorActuator.revalidate()` ships as a dark-first conservative reader
  (pinned/recentlyUserMoved/inFailureEpisode all false), exercised only for `dryRun` audit rows. The precise pin /
  provenance / stale-owner-release + lease-handback episode sourcing is required BEFORE any `dryRun:false` flip.
- **WS2 oscillation-blacklist replication** — the blacklist is in-process this increment; replicating it (spec §85,
  survives a lease failover) rides the WS2 store machinery (#4's working-set-artifact kind is the model).
- **Deduped attention-item raise** — the oscillation trip currently `console.warn`s; the one-per-episode tone-gated
  `/attention` raise (F6) lands with the live flip.
- **F8 feedback-outcome derivation** (spec Phase 5) — structured, suppress-only, machine-local preload hit-rate
  memory that drives the A/B-lift decision; a tracked Phase-5 follow-up.

## Conclusion

The build followed the converged spec (multi-reviewer + cross-model codex-cli:gpt-5.5) verbatim, grep-verifying each
foundation (the CartographerSweepEngine/Poller pattern, the LlmQueue lanes, `ParallelActivityIndex`, #4's working-set
manager, the `WorkingSetPullCoordinator` fetch, the pressure/lease seams) before writing — every piece typechecked
first-pass. The feature is additive, lease-gated, propose-only, dark on the fleet + dryRun-first on a dev agent, and
unit + route-integration tested (36 tests, Tier-1 + Tier-2). The Tier-3 cross-machine E2E is an honest named blocker
(the Laptop is offline). The four P4-live prerequisites are enumerated + tracked, load-bearing only after an
operator-only flip. Clear to ship dark.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact: concur**

The converged spec (review-convergence + approved, cross-model codex-cli:gpt-5.5 ran clean) already provided the
multi-angle adversarial read this change's risk class warrants; the build introduced no design deviation from it.

---

## Evidence pointers

- 36 tests green: `seamless-orchestrator-engine` (10), `orchestrator-actuator` (10), `orchestrator-poller` (6),
  `orchestrator-oscillation-breaker` (4), `seamless-orchestrator-routes` integration (6).
- `npx tsc --noEmit` exit 0 across all edits.
- All 4 constitutional ratchets green locally (dark-gate, write-domain, no-silent-fallbacks, compaction-parity).
- Dark-ship verified: `resolveDevAgentGate` resolves the feature OFF on the fleet (never constructed); `dryRun:true`
  default actuates nothing even on a dev agent.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a net-new additive feature; it fixes no defect in an
LLM prompt/hook/config/skill/standards text. On the `unbounded-self-action` class: the orchestrator IS a self-triggered
controller, but it is bounded by construction and ships dark/dryRun — lease-gate (one machine), ≤3 proposals/tick,
per-topic 30m cooldown, oscillation breaker (blacklist + give-up), poller error-breaker, `LlmQueue` daily spend cap,
and `dryRun` (actuates nothing). The one ever-auto action is a side-effect-free preload behind an operator-only flip.
