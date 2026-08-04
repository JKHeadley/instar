# Phase A — Verdict Ledger (running)

**Every row is DERIVED from a measurement with a source and a machine-stamped time.** No row is asserted.
Per the architect amendment, `aligned` is true only if `effective` passes on **every** machine on the
node's critical path. Per the counter-method three-way rule, **`unmeasured` is NOT `false`.**

**As of 2026-08-04 08:28Z · Mac Mini** (laptop verdicts are a separate pass and are NOT inherited).

## Verdicts obtained

| node | tranche | exists | wired | effective | basis |
|---|---|---|---|---|---|
| `sessionPool.inboundQueue` | T1 | ✅ | ✅ | ❌ **false** | Mini `dryRun:true` (cannot bite); Laptop live but `queued/held/delivered24h = 0` |
| `orphanedWorkSentinel` | T3 | ✅ | ✅ | ❌ **false** | ticking, `verdictUnknown` every tick — worktree enum fails (agent home is not a git repo); 34 worktrees unseen |
| `agentWorktreeReaper` | T3 | ✅ | ✅ | ❌ **false** | same blindness, **mislabelled `on-dry-run`** so the blindness is hidden |
| `selfActionGovernor` | T4-A | ✅ | ✅ | ❌ **false** | **1,616 wouldDeny · 0 denies** across 4 live classes (5 further classes unmeasured) |
| `blockerLedger` | T4-A | ✅ | ❌ | ❌ **false** | guard **off**; `/blockers/self-unblock-runs` → 503 |
| `testRunnerCap` | T4-A | ✅ | ✅ | ⚪ **unmeasured** | `wouldBlock` never true in 15h — **cap never contended** |
| `throughputFloor` | T4-A | ✅ | ✅ | ⚪ **unmeasured** | 2 runs, both `ineligible` — never evaluated anything |
| `ws13Reconcile` | T4-A | ✅ | ✅ | ⚪ **unmeasured** | `pinState: actuated` = desired==actual **now**; no correction event |
| **`machineCoherence`** | T4-C | ✅ | ✅ | ✅ **TRUE** | **live (`dryRun:false`); raised an episode 07:06:26Z detecting the version skew I created at 07:02:56Z — unprompted** |
| `missingLoginSession` | T4-C | ✅ | ✅ | ⚪ **unmeasured** | 156 ticks, `wouldRaise: 0` — no stranded session existed |
| `autonomousLivenessReconciler` | T4-C | ✅ | ✅ | ⚪ **unmeasured** | `respawnTotal: 0`, all topics `healthy` — no dead run to revive |
| `singleMachineFailoverGap` | T4-C | ✅ | ✅ | ⚪ **unmeasured** | `singleMachine:false` — cannot fire while 2 machines are online |
| `degradedTmuxGuard` | T4-D | ✅ | ✅ | ⚪ **unmeasured** | ticking (36ms); exposes no would/did counters |
| `scheduler` | T4-D | ✅ | ✅ | ⚪ **unmeasured** | running, 42 jobs; its `pausedJobCount:15` = **disabled** jobs, not pause actions |
| **`CrashLoopPauser`** (excluded) | new | ✅ | ❌ | ❌ **false** | **never constructed** (control passed); 21 jobs failing, top **477 consecutive**, none paused |
| `grounding gate` (A0 #18) | A0 | ✅ | ✅ | ❌ **false** | matcher read from source: one `grep -qiE`, 6 literals; **10 blocks · 2 true · 8 false** |

### Added 08:39–08:41Z — Tranche 2 cited guards, tested by deliberate injection on current code

| node | exists | wired | **effective** | basis |
|---|---|---|---|---|
| `lint-llm-attribution.js` (**Observability**) | ✅ | ✅ | ✅ **TRUE** | 3-sided: violation caught (1) · compliant allowed (0) · `component:''` evasion caught (1) |
| `lint-dev-agent-dark-gate.js` (**Ship Live**) | ✅ | ✅ | ✅ **TRUE** | 2-sided: hand-rolled gate caught w/ file+line+class · funnel form allowed (0) |
| orphan-deferral scan (**Deferral = Deletion**) | ✅ | ✅ | ⚪ **UNMEASURED** | test invalid — empty-index control ALSO exits 0; gate skips when no `src/` staged |

**Provenance:** all three lint scripts diffed against `origin/main` before testing — **UNCHANGED**, so the
injections tested shipped code, not a day-old checkout. Baseline controls green before each injection;
worktree left at 0 changes.

**The B-case rule (new, from this pass):** a rung-3 claim needs a **negative control** — the guard must
ALLOW the compliant form. Without it, a catch cannot be distinguished from a guard that rejects
everything. **The three lint passes obtained earlier tonight lack their B case and are downgraded to
provisional until re-run.**

## Tally

- **effective TRUE: 46** — ⚠️ **DENOMINATOR RETRACTED 10:27Z:** "lint tier complete 30/30" was scoped
  to the filename prefix `lint-`. There are **27 further guard-shaped enforcement scripts**, all wired,
  **none swept**. Honest enforcement-script population ≈ **57**, verified **26**.
- ~~lint tier complete~~ — 1 runtime of 90 · **lint tier COMPLETE (30/30 accounted, 26 TRUE)** ·
  **ratchet tier COMPLETE (18/18 TRUE)** + lint-chain-completeness. Two whole populations measured;
  ZERO genuine guard failures found across 48 guards.
- ~~effective TRUE: 43~~ — 1 runtime · **26 lint (tier COMPLETE: 26 true + 2 A-only + 1 config-gated-verified + 1 warning-only = 30)** · 16 of 18 ratchet
- ~~effective TRUE: 41~~ — 1 runtime · 24 of 28 always-enforcing lint-class · 16 of 18 ratchet-class
- ~~effective TRUE: 40~~ — 1 runtime · 24 of 28 always-enforcing lint-class · 15 of 18 ratchet-class
- ~~effective TRUE: 37~~ — 1 runtime · 24 of 28 always-enforcing lint-class · 12 of 18 ratchet-class
- ~~effective TRUE: 34~~ — 1 runtime · 24 of 28 always-enforcing lint-class · 9 of 18 ratchet-class
- ~~effective TRUE: 31~~ — 1 runtime · 24 of 28 always-enforcing lint-class · 6 ratchet-class
- ~~effective TRUE: 29~~ — 1 runtime · 22 of 28 always-enforcing lint-class · 6 ratchet-class
- ~~effective TRUE: 27~~ (recounted 09:15Z, not incremented) — 1 runtime · 20 of 29 enforcing
  lint-class · 6 ratchet-class (3 by my injection, 3 by construction). Denominator note: the lint
  population is 29 enforcing + 1 warning-only, not 30.
- ~~effective TRUE: 22~~ — 1 runtime guard · 19 of 30 lint-class · 2 ratchet-class. The three layers
  (lint detects → ratchet pins baseline at zero → chain-completeness stops silent removal from CI) are
  each verified by injection, so the 19 lint verdicts are CI-enforced, not merely "a script exists".
- ~~effective TRUE: 20~~ — 1 runtime guard + **19 of 30 lint-class**, each two-sided
- ~~effective TRUE: 19~~ — 1 runtime guard (`machineCoherence`) + **18 of 30 lint-class guards**,
  each two-sided. Detail: `journals/lint-class-rung3-verification.md`
- ~~effective TRUE: 13~~ — 1 runtime guard (`machineCoherence`, natural violation) + **12 of 30
  lint-class guards**, each verified two-sided (violation caught AND compliant form allowed) against
  scripts diffed UNCHANGED vs origin/main
- ~~effective TRUE: 6~~ — `machineCoherence` + FIVE lint-class guards, each two-sided
  (`llm-attribution` · `dev-agent-dark-gate` · `no-direct-destructive` · `no-unbounded-llm-spawn` ·
  `sync-subprocess-chokepoint`)
- ~~effective TRUE: 3~~ — `machineCoherence` (natural violation, unprompted) · `lint-llm-attribution`
  (injection, 3-sided) · `lint-dev-agent-dark-gate` (injection, 2-sided)
- **effective FALSE (evidenced): 8** (+ `CrashLoopPauser`, never constructed)
- **unmeasured (no opportunity, or invalid test — NOT false): 9**
- **aligned: 0** — no node has passed `effective` on **every** machine on its path.

## Why so much `unmeasured`

**8 of 16 could not be settled because the guard never had an opportunity to act.** That is the honest
state, and it is the tranche's real cost driver: settling them needs a *staged violation*, which needs
the throwaway-agent + demo-channel harness that does not exist yet.

**A binary pass/fail audit would have recorded all 8 as failures — over half of these rows falsely** —
and inflated the headline severity, which is the single most common error mode caught tonight.

## Not inherited

Every row above is **Mini-only**. `aligned` cannot be claimed for any of them until the laptop is
measured — and the laptop is currently **two versions behind** (1.3.1122 vs 1.3.1124), so its verdicts
will not be identical by construction.


---

## RUNTIME TIER — counter-method sweep (2026-08-04 10:03Z)

The runtime tier's 90 guards remain overwhelmingly unmeasured, but **8 expose effectiveness counters on
their own per-feature routes** (never in the `/guards` inventory row — that surface is heartbeat-only).
Sweeping them yields **evidence-backed** classifications where I previously had bare "unmeasured":

| guard | looked | would-act | did-act | classification |
|---|---|---|---|---|
| `selfActionGovernor` | admits 1940 | **1616** | 0 | **effective: FALSE — evidenced** (observe-only by design) |
| `machineCoherence` | compared 2 | 0 (live) | raised 1 episode | **effective: TRUE** — verified independently |
| `missingLogin` | ticks 358 | 0 | 0 | **unmeasured — EVIDENCE-BACKED** (looked, found nothing) |
| `failoverGap` | ticks 358 | 0 | 0 | **unmeasured — EVIDENCE-BACKED** |
| `duplicateReconciler` | ticks 179 | 0 | 0 | **unmeasured — EVIDENCE-BACKED** |
| `staleOwnerRelease` | **attempts 0** | 0 | 0 | ⚠️ **never ATTEMPTED** — ticks, but its evaluation has not run |
| `writeAdmission` | **none** | 0 | — | ⛔ **AMBIGUOUS ZERO** |
| `threadlineNegotiator` | **none** | 0 | — | ⛔ **AMBIGUOUS ZERO** |

**"Evidence-backed unmeasured" is a materially stronger verdict than "unmeasured"** — the guard's own
counter proves it had no opportunity, rather than my having failed to create one.

⛔ **Two guards sit in the ambiguous class**, where a blind detector and a quiet world are
indistinguishable — the `CrashLoopPauser` shape, and precisely what `lint-chain-completeness` names as
*"a check whose absence is indistinguishable from its success."*

**Minimum honest schema for a guard's runtime row: `{looked, wouldAct, didAct}`.** Two of the three is
worse than none — it makes an uninterpretable zero look like health.
