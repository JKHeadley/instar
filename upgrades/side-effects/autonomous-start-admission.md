# Side-Effects Review — autonomous runs start active unless an open window can promote them; never-started runs are reported

**Version / slug:** `autonomous-start-admission`
**Date:** `2026-11-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

`POST /autonomous/register` (src/server/routes.ts) chose `initialStatus: 'preparing'` for every Echo run whenever window-run liveness was enabled with `dryRun: false`. Only `WindowRunLivenessAuthority` promotes a preparing run, it holds a single binding (`window-run-liveness/state.json`), and nothing binds an ordinary run to it automatically. The W32 window ledger has been `closed_failed` since 2026-09-08. Result, read from Echo's run store on 2026-11-02: dozens of runs since 2026-09-06 ended their lives in `preparing`; five open runs were stuck at the time (topics 10000001156, 127504, 130715, 131439, 9210). A preparing run is skipped by `AutonomousLivenessReconciler` (it reconciles active runs) and its Stop hook does not hold the session (`active: false`), so it is silently dead.

Changes:
- `src/core/AutonomousStartAdmission.ts` (new): `decideAutonomousStartStatus` — pure decision. `preparing` only when Echo + liveness enforcing + the W32 ledger is in an admitting/active lifecycle state, not recurrence-frozen, before its ceiling (when it has one) + the liveness slot is empty, or holds a finished binding for a DIFFERENT window (the only states in which `WindowRunLivenessAuthority.register` would accept a new run). Otherwise `active`. `findStuckPreparingRuns` + `PreparingRunWatchdog`: open runs still `preparing` ≥5 min after registration (≥45 min after the authority bound that exact run) get one notice in their topic. Each send is claimed under the run lock first, re-checking the live record (still `preparing`, not yet noticed, under the cap), and marked `preparingNoticeAt` before sending; a failed send releases the mark; `preparingNoticeAttempts` caps sends at 3 per run.
- `src/core/AutonomousRunStore.ts`: `listOpen()` (shares the directory scan with `listActive()`); two optional record fields.
- `src/server/routes.ts`: register route uses the decision.
- `src/server/AgentServer.ts`: arms the watchdog (60 s interval, unref'd, cleared on stop) when a Telegram adapter exists and `autonomousSessions.preparingWatchdog.enabled !== false`; exposes it for wiring tests.
- `src/core/types.ts`: the `preparingWatchdog` config type.
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts`: one awareness bullet, content-sniffed migration, framework-shadow marker.
- `src/testing/selfActionRegistry.ts`: `preparing-run-watchdog` convergence model.
- Tests: unit, integration, e2e, migration, parity list.

## Decision-point inventory

- `/autonomous/register` initial status — modify — narrows `preparing` from "liveness enforcing" to "an open window can actually promote this run".
- Preparing-run notice — add — a deterministic notify on an objective state (status + age), with a once-per-run mark and an attempt cap.

---

## 1. Over-block

No block/allow surface: neither change refuses anything. The narrowing only moves runs from `preparing` to `active`. A run that should have waited (a genuine W32 window run) still gets `preparing` while its window is open and the slot is free or its own.

---

## 2. Under-block

- A W32 window run registered while the liveness slot holds a live binding (any topic, including an earlier run of this same topic), or a finished binding for this same window, now starts `active` instead of `preparing`. The authority would refuse to bind it (`active-binding-exists` / `terminal-binding-closed`), so `preparing` meant "silently dead"; `active` means it runs under the ordinary Stop hook and reconciler.
- A session that voluntarily binds an ordinary active run to the liveness authority (`ordinaryRunLifecycle`) is demoted to `preparing` by the authority's own projection, as before. If it never goes green, the watchdog now reports it after 45 minutes; before, nobody heard.
- Runs already stuck before this release are not promoted. The watchdog reports each open one once. Expired ones are left alone.

---

## 3. Level-of-abstraction fit

The start decision stays at the registration route that owns it; the logic moved into a pure function so both sides are testable. The watchdog is a signal: it reads the run store and tells the operator. It does not promote, kill, or respawn anything. Revival stays with the existing `AutonomousLivenessReconciler`, which now sees these runs because they are active.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The register change chooses a start state, it refuses nothing. The watchdog only informs the operator.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is a W32 window open, and is the single slot free for this topic" is enumerable from two durable documents. "Still preparing after N minutes" is an objective age on a status that should last seconds for an ordinary run; the 5/45-minute thresholds only decide when to tell the operator, never what happens to the run.

---

## 5. Interactions

- **Shadowing:** the register decision runs where the old one-liner ran; nothing else read the old expression. The window-lifecycle enforcement middleware still sees `/autonomous/register` before the handler (unchanged; enforcement is `off` on Echo).
- **Double-fire:** the liveness authority sends its own failure notice for a stalled/failed window (it projects `failed`, not `preparing`), so the two never report the same state. The reconciler acts only on active runs; the watchdog only on preparing runs.
- **Races:** the watchdog writes the run record through `AutonomousRunStore.update` (per-run lock), the same path the liveness projection uses. A run promoted between the scan and the claim is re-checked inside the lock and skipped (no false "did not start"). The notice is marked before the send, so a lock contention after a delivered send cannot produce a second copy; a busy lock at claim time just defers to the next tick. A single in-flight flag stops overlapping ticks.
- **Feedback loops:** a notice does not change run status, so it cannot re-trigger itself; the once-per-run mark and attempt cap bound it (registered with the self-action ratchet).

---

## 6. External surfaces

- Telegram: at most one automation message per stuck run, in that run's own topic. On the first deploy to Echo, the open stuck runs (5 at the time of writing, including 9210) each get one message. That is the intended disclosure.
- Persistent state: two optional fields on run records; old records read fine without them.
- Other agents: no change unless an agent has an enforcing liveness authority, which only Echo can.
- **Operator surface:** no operator-facing actions added; the notice tells the operator to ask the agent to start the run again (conversational, phone-complete).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** The run store (`state/autonomous-server`) is per machine: a run is registered on the server whose session runs it, and that server's watchdog is the one that can say it never started there. User-facing notices: one per run, from the machine that registered it; there is no replicated copy for a second machine to also report. No URLs generated.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. The watchdog is also silenced live with `autonomousSessions.preparingWatchdog.enabled: false`. The two record fields are optional and harmless if left behind. The CLAUDE.md bullet stays in migrated agents' files after a revert (wording only).

---

## Conclusion

The review led to design changes before commit. My own pass added the attempt cap (an always-failing Telegram send would otherwise retry every minute forever) and the "slot held → active" rule. The independent second pass then found four more, all fixed: a same-topic live binding and a finished binding for the same window both refuse a new run, so both now start `active`; the send is claimed under the run lock with a fresh status check (no false notice after promotion); and the notice is marked before sending (no duplicate after a busy lock). The 45-minute allowance for a bound run now counts from when it was bound. The change is clear to ship as Tier 1: narrow, reversible, no refusal surface, and the watchdog has an off switch.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (fresh context, given the diff)
**Independent read of the artifact:** concern, then resolved.

- Same-topic live binding exempted from the slot check → a new run waited for a slot it could never bind. Fixed: any live binding → `active`.
- Finished binding for the current window counted as free → `terminal-binding-closed` on bind. Fixed: same-window finished binding → `active`.
- Status not re-checked before sending → false notice after a promotion. Fixed: claim under the run lock with a fresh check.
- Mark written after the send could fail on a busy lock → duplicate notices. Fixed: mark before send, release on failure.
- Minor: bound allowance counted from registration. Fixed: counts from `boundAt`.

---

## Evidence pointers

- Live reproduction on Echo, 2026-11-02 01:45Z: this fix's own run registered with `{"initialStatus":"preparing","preparationRequired":true}` while the W32 ledger was `closed_failed`.
- Run-store census at the same time: every open run on Echo was `preparing`.
- Tests: `tests/unit/autonomous-start-admission.test.ts`, `tests/integration/autonomous-register-start-status.test.ts`, `tests/e2e/autonomous-start-admission-production.test.ts`, `tests/unit/PostUpdateMigrator-preparation-awareness.test.ts`, `tests/unit/self-action-convergence.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (the watchdog is a self-triggered notifier).
- **`closure`** — `guard`.
- **`guardEvidence`** — `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (entry preparing-run-watchdog in src/testing/selfActionRegistry.ts), howCaught: under an always-rejecting delivery path the real findStuckPreparingRuns stops selecting a run once its durable preparingNoticeAttempts reaches PREPARING_NOTICE_MAX_ATTEMPTS (3), so the count settles at 3 per run, horizon-independent, and the counter lives on the run record so a restart does not reset it}`.
