# Convergence round 1 — findings catalog

**Spec:** `docs/specs/memory-pressure-degraded-tier.md`
**Round:** 1 of N — **NOT CONVERGED**
**Run:** 2026-08-04 ~21:57–22:04Z
**Reviewers:** 6 internal (security · scalability · adversarial · integration · decision-completeness · lessons-aware) + 1 external cross-model (codex-cli / gpt-5.5, `crossFamily: true`, status `ok`) + the Standards-Conformance Gate (82 standards).

> **Status of the spec after this round: the premise is refuted, not the prose.** Findings 1–3 below
> are not defects in the writing. They mean the problem was mis-diagnosed and the remedy mis-aimed.
> Editing this document into compliance would produce a well-formed spec around a wrong premise.
> Reported to the operator 22:05Z with a recommendation to withdraw the build approval.

---

## The three that decide it

Each was reached **independently by more than one reviewer**, which is why they are listed first.

### F1 — The causal chain is CORRELATION. (security · adversarial · lessons-aware)

The spec claims, in the section it labels *"the strongest argument in this document"*:

> *"The gate runs by spawning a session (`JobScheduler.runGateAsync`), so it passes through
> `evaluateRerouteGate` and inherits the refusal. The job-gate failures ARE the memory refusals,
> one layer up."*

**`JobScheduler.runGateAsync` runs `execFileAsync('/bin/sh', ['-c', job.gate], { timeout: 10000 })`.**
It never calls `spawnSession` and cannot reach `evaluateRerouteGate`. The 125 ms co-occurrence is a
shared cron tick.

**Disconfirming evidence already in the system:** a memory refusal records `reason: 'memory-pressure'`;
a gate-command failure records `'gate'`. The observation was `skipped (gate)`.

Concrete counter-example: `evolution-proposal-evaluate`'s gate is a `curl … | python3 … exit(0 if
len(proposals) > 0 else 1)` — it exits 1 **by design** when there is no work. That is an ordinary
no-work skip, not a refusal.

**Consequence:** the retry-budget-compounding argument — escalated to the operator at 12:06Z as
measured fact — rests on this chain. It must be re-derived from skip reasons, not timestamps.

### F2 — The proposed fix reproduces the condemned harm, to the percentage point. (adversarial)

Constraint 3 admits `critical`/`high`, defers `medium`/`low`. Enumerated across all **33** shipped job
manifests:

| priority | count |
|---|---|
| `critical` | **1** (`health-check`) |
| `high` | **2** (`commitment-detection`, `evolution-overdue-check`) |
| `medium` | 15 |
| `low` | 15 |

**Admits 3, defers 30 = 91%.** All five `overseer-*` jobs are `medium`/`low`, so **100% of the tier
that notices is shed.** The spec's own 20:40Z addendum condemns exactly this: *"a refusal switches off
~91% of the scheduled supervisory layer and 100% of the tier that would notice."*

All three jobs the spec names as harmed — `insight-harvest` (low), `identity-review` (medium),
`evolution-proposal-evaluate` (medium) — are shed by the remedy.

**Root cause of the error:** `JobPriority` encodes *scheduling urgency*, not *supervisory
load-bearingness*. The author reached for the field that existed rather than the property meant.
Re-tagging 30 manifests to `critical` is not available either — it would destroy the taxonomy the
quota gate already consumes.

### F3 — A second authority gates the same decision at the same threshold, and fires FIRST. (adversarial · lessons-aware)

`server.ts` wraps `scheduler.canRunJob` with `memoryMonitor.canSpawnSession()`.
`MemoryPressureMonitor`'s `elevated` threshold is **75%** — identical to `currentMemoryPressure()`'s
`high` — and it is evaluated **before** the job gate and before `spawnSession`. It ignores the
`priority` argument entirely.

**So a DEGRADED tier built only in `evaluateRerouteGate` is unreachable for the entire scheduled-job
population.** Direct violation of *"each decision point has exactly one authority."*

The spec measured a two-resolver divergence and attributed 100% of it to the reroute gate.

---

## Corroborated design findings

| # | finding | raised by |
|---|---|---|
| F4 | **`deferrable` is on `IntelligenceOptions`, not the spawn path.** The quoted safety property (*"a `gating:true` call is ALWAYS non-deferrable"*) governs the LLM router; nothing on `spawnSession` reads it. The spec cites it as *"exactly the safety property DEGRADED needs."* | **5 reviewers** |
| F5 | **`types.ts:1575` is `ActionItem.priority`, not `JobDefinition.priority`** (real: `:441`, typed `JobPriority` at `:638`). The 20:40Z correction re-verified this exact constraint and missed it — the author grepped the union literal and landed on the wrong interface. | 4 reviewers |
| F6 | **A DEGRADED deferral still burns the retry ladder.** Force-mode refusal throws → `recordCompletion({result:'failure'})` → `consecutiveFailures++` → `scheduleRetry`. The headline harm survives, and a policy deferral becomes indistinguishable from a crash (can trip consecutive-failure alerts). | external + 4 internals |
| F7 | **`jobSlug` is an unauthenticated admission-priority capability.** `POST /sessions/spawn` validates it by charset only — never checks existence, never checks caller is the scheduler. Any Bearer holder posts `jobSlug:"health-check"` and buys `critical` admission. | security |
| F8 | **Dwell can hold permissive through an escalation to `critical`.** The spec never states that a MORE restrictive tier bypasses dwell, so a natural min-dwell holds `high` while the real reading passes 90. No attacker needed. | security |
| F9 | **The pressure read fails OPEN to `low`.** `readSystemMemoryPressure` falls back to an RSS estimate documented as biasing "toward LOW pressure" — safe for a reaper, wrong for an admission gate. The failing operation is a `fork`, likeliest to fail under the very pressure it measures. | security · scalability · adversarial · lessons-aware |
| F10 | **"Serialize starts" is a TOCTOU.** `countReroutedInteractiveSessions()` counts sessions already persisted as running; `launchLane` is written long after the gate. Concurrent callers all read the same stale count. The six-jobs-at-one-tick case is the worst case: today all six throw; under DEGRADED all six could read count=0 and admit — turning a relaxation into a pressure amplifier. | security · scalability · adversarial · lessons-aware |
| F11 | **No supervisory/productive carrier exists anywhere in the tree.** `grep supervisory\|isSupervisor\|jobClass` returns nothing. Testing addendum §3's *same-priority* clause structurally rules out `JobPriority`. The classification must be invented and backfilled across 42 manifests. | 4 reviewers |
| F12 | **9 of 10 `spawnSession` callers carry no priority at all** (A2A, dispatch, mentor, upgrade-notify, spawn-request). The default for unclassified spawns decides whether DEGRADED is a no-op or breaks A2A — and is unstated. | security · decision-completeness · adversarial |
| F13 | **The reconciler depends on the thing it fixes.** The in-tree precedent (`AutonomousLivenessReconciler`) is explicitly *"pressure-gated"*, fails **closed to `critical`** on read error, and gives up after 30 min. A stale-anchor reconciler modelled on it is blocked by the condition it exists to heal. | adversarial |
| F14 | **The force-mode branch never records a fallback**, so the *"reroute is effectively DEAD"* escalation (cap 5 / 30 min) cannot fire in the one mode where refusal is fatal. That is why 173 refusals produced no escalation. | lessons-aware |
| F15 | **Pool placement ranks on `loadAvg` alone.** The heartbeat never publishes `memPressure`, `activeSessionCount`, or `maxSessions`, so **two of three scoring terms resolve to constant 0** — leaving the one metric instar's own doctrine says never to judge load by. | integration |
| F16 | **The guard-manifest lint is structurally blind here** via a stale affirmative exemption (`SessionManager` = *"the thing guards act ON, not a guard"*) — true when written, and **this spec is what invalidates it**. The lint passes forever while a real guard grows inside an excused component. | integration |
| F17 | **Dwell state has no home and no restart semantics.** Every comparable field in this class is a plain instance field lost on restart — and the spec's own evidence records **five server restarts that day**. A restart *relaxes*, the unsafe direction. Test §1 never restarts the process, so it passes against a build with zero persistence. | 4 reviewers |
| F18 | **Head-of-line blocking.** `subscriptionReroutedLifetimeMinutes ?? 45` means one long job can hold the sole slot at `degradedMaxRerouted: 1` for 45 minutes, starving all 21 supervisors — strictly worse than today's cap of 3. | scalability |
| F19 | **Likely net throughput LOSS.** Today's memoryless gate leaks admissions through troughs — measured 51% (`health-check` admitted 64 of 125). Asymmetric dwell deliberately closes that leak; at cap 1 with a 45-min lifetime it is a loss. The spec has the data to compute this and does not. | scalability |
| F20 | **The admission decision forks `1 + 2N` subprocesses synchronously** (`vm_stat`, plus `tmux has-session` + `display-message` per running session), each with a 5 s timeout, on the event loop. Forking is what degrades under memory pressure — the observer contributes to the condition. | scalability · lessons-aware |
| F21 | **Expected capacity enforcement filed as degradation.** Both refusal branches report through `DegradationReporter`; the standard says a bounded resource applying its declared budget is a successful primary path. A lint for this is already in the blocking chain. | lessons-aware |
| F22 | **Unconsulted in-tree prior art.** `SpawnRequestManager` already implements degraded admission, a bounded give-up latch, and an anti-flap cooldown written *"so near-threshold memory pressure cannot flap the latch"*. `MemoryPressureMonitor` already carries a 20-reading ring buffer + trend. The spec asserts no dwell/hysteresis exists — true of `evaluateRerouteGate`, false of the subsystem. | lessons-aware |
| F23 | **Declared `parent-principle` is wrong** — the gate's fit check returned verdict `none`. Correct parent: **Signal vs Authority** (a threshold detector holding veto power), secondary **No Unbounded Loops**. | gate + lessons-aware |
| F24 | **Config path does not exist.** `sessions.memoryPressure` appears nowhere; every sibling knob lives under `intelligence.subscriptionPath.*`. Also: `sessions` IS Bearer-patchable while `intelligence` was deliberately excluded *for this exact class of protection*. | security · lessons-aware |

---

## Structural gaps (independent of findings — these block the tag writer)

- ✗ **`## Decision points touched`** — absent entirely. The convergence tag writer **refuses** without it.
- ✗ **Unresolved open question** — *"Should DEGRADED also apply in `auto` mode? … flags the question rather than deciding it."* The tag writer **refuses** while unresolved entries remain. (Also duplicates external finding 5.)
- ✗ **`## Multi-machine posture`** — absent. Correct split per integration: `hardware-bound-resource` for the reading/dwell, `unified` for the admission policy.
- ✗ **`## Frontloaded Decisions`** — absent. Decision-completeness enumerated **14** decisions requiring frontloading, **0** surviving cheap-to-change tags.
- ✗ **`## Maturation plan`** — absent; `## Rollout` carries none of the required fields and skips the test-agent rung.

## Standards-Conformance Gate (82 standards, 2 flags)

- **A Dark Feature Guards Nothing** — ships a load-bearing fix behind a default-off flag. Mechanically, a literal `enabled: false` would also fail the existing dark-gate lint; the convention is to omit and let the dev-agent gate resolve.
- **Maturation Path** — jumps to dev-then-fleet, skipping the test-agent rung with graduation evidence.

## Where reviewers found nothing (recorded so absence is visible)

- *"Not a threshold retune"* — holds exactly; no threshold literal moves.
- The metric reconciliation (compressed memory attribution) — verified correct.
- `SessionManager:2836` / `:2840` citations — verified correct.
- `evaluateRerouteGate` has exactly one call site and `options` is in scope — verified; the gate-side hop genuinely is small.
- No new HTTP endpoint, no new prompt-injection vector, no credential/PII surface introduced.
- In-memory dwell has no classic read-modify-write race (Node single-threaded, gate is synchronous) — the real risks are restart-loss and machine-scoping.

## Disposition

**Round 2 is not scheduled.** F1–F3 invalidate the problem statement and the remedy; the correct next
step is re-derivation, not revision. Recommendation sent to the operator 22:05Z:

1. Withdraw the build approval.
2. Re-derive the actual cause of the job failures from **skip reasons**, not timestamp co-occurrence.
3. Split the four bundled pieces — noting that the tier and the priority plumbing are genuinely
   inseparable, while the stale-anchor reconciler is fully independent.
