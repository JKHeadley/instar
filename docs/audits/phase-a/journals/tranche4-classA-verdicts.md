# L2 / Tranche 4 / Class A — the 5 "safely injectable" guards: VERDICTS

**Measured 2026-08-04 07:39–08:08Z, Mac Mini.** Ruling 4 made Tranche 4 a FULL audit.
**Status DERIVED from the evidence below — not asserted, not cached.**

`machines_on_critical_path: [mini]` for all five (host-local resources: test slots, self-action
ceilings, blocker settles, throughput scope, pin state). Laptop verdicts are a separate measurement.

---

## VERDICT TABLE

| guard | exists | wired | **effective** | method | basis |
|---|---|---|---|---|---|
| `intelligence.selfActionGovernor` | ✅ | ✅ | **FALSE — evidenced** | counter | 1,616 wouldDeny · **0 denies** across 4 live classes |
| `monitoring.blockerLedger` | ✅ | **❌** | **FALSE — structural** | route probe | guard **off**; `/blockers/self-unblock-runs` → 503 |
| `intelligence.testRunnerCap` | ✅ | ✅ | **UNMEASURED** | counter | `wouldBlock` never true in 15h — **cap never contended** |
| `monitoring.throughputFloor` | ✅ | ✅ | **UNMEASURED** | counter | 2 runs, **both `ineligible`** (scope-or-ownership) — never evaluated |
| `multiMachine.…ws13Reconcile` | ✅ | ✅ | **UNMEASURED** | state probe | `pinState: actuated` = desired==actual **now**; no correction event |

**`aligned: false` on all five.** Two are false on evidence; **three are unmeasured, and unmeasured is
NOT false** — recording them as failures would be exactly the error this tranche exists to avoid.

---

## ⭐ THIS CORRECTS MY OWN TRANCHE 4 COST ESTIMATE

`tranche4-testability.md` (06:38Z) called these five **"Class A — safely injectable in isolation …
Cost: low."**

**Measured: the cheap method settled 2 of 5. Three still require a staged violation.**
- `testRunnerCap` needs **two genuinely concurrent suites** to contend a cap of 1.
- `throughputFloor` needs a run that is **in-scope and owned** — every observed run was ineligible.
- `ws13Reconcile` needs a **real divergent pin**, because a state match can never prove a correction.

**So "low cost" was my estimate from each guard's declared critical path, and it was 60% wrong in the
expensive direction.** This is precisely the caveat I wrote into that document — *"a guard I filed under
B might turn out to be A once someone reads it"* — landing in the **opposite** direction from the one I
anticipated. **I hedged the error I expected and not the one I made.**

## ⭐ The three-way outcome is doing the real work
Across the 9 governor classes + these 5 guards, the split is **6 evidenced-false · 8 unmeasured**.
A binary pass/fail would have marked all 14 as failures. **More than half of that would have been
false reporting**, and it would have inflated the audit's headline severity — the same over-read I
caught in the governor cross-check at 08:02Z.

## Honest limits
- `wouldDeny`/`wouldBlock` are **each guard's own self-report**. That a guard *would* have denied is not
  proof it would have denied *correctly*. **Verifying would-deny logic is a distinct question** and is
  not answered here.
- Mini only. Per the architect amendment, `aligned` needs `effective` on **every** machine on the path;
  these five are host-local, so the laptop needs its own pass before any of them can ever read `aligned`.
- The `testRunnerCap` window shows **posture `off` for 15 of 50 events** — the guard was disabled for
  part of the observed period. **Its "enforcing" posture is not continuous**, which is itself unexplained
  and worth a follow-up.
