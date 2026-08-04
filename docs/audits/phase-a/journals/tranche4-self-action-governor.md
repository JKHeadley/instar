# L2 / Tranche 4 / self-action-governor — the first rung-3 verdict on a TRUSTED guard

**Guard:** `intelligence.selfActionGovernor.enabled` · **posture: `on-confirmed`** (the system's highest
trust tier) · **load-bearing** · measured **2026-08-04 06:55Z**, Mini.

## VERDICT

| rung | Mini | evidence |
|---|---|---|
| exists | ✅ | governor constructed, `/self-action-governor` answers, 9 controller classes registered |
| wired | ✅ | **1,940 self-actions actually evaluated** — it is in the live path, not idle |
| **effective** | ❌ | **0 denies out of 1,616 would-denies. Every class is `mode: observe`.** |

**`aligned: FALSE`.**

## The number

| controller | mode | admits | wouldDeny | **denies** |
|---|---|---|---|---|
| `age-kill-backoff` | observe | 1,702 | **1,534** | **0** |
| `promise-beacon-notify` | observe | 184 | 57 | **0** |
| `proactive-swap-monitor` | observe | 44 | 21 | **0** |
| `liveness-heartbeat` | observe | 10 | 4 | **0** |
| 5 others | observe | 0 | 0 | 0 |
| **TOTAL** | | **1,940** | **1,616** | **0** |

> **1,940 self-actions evaluated. 1,616 judged deniable. Zero denied.**

## ⚠️ THIS IS NOT A DEFECT — and that is what makes it the perfect Tranche 4 case

The governor **ships observe-only on every class by design**; a class enforces only after the operator's
deliberate per-class flip. **The design is honest and the rollout is deliberate.**

**The gap is between what `on-confirmed` communicates and what it means.** The guard-posture surface marks
this guard with the system's highest trust label while it is, by construction, incapable of denying
anything. Anyone reading the posture — including a future audit node — would record it as a working guard.

**This is `confirmation-is-not-effectiveness` with a hard number**, and it is precisely why Ruling 4 made
Tranche 4 a full audit: *"the guards the system currently trusts, so wrong trust there is the most
dangerous class."* It was right, and this is the first instance measured.

## A live operator decision sits behind this

`age-kill-backoff` alone recorded **1,534 would-denies** against 1,702 admits — it is watching a genuinely
active pressure (the reaper age-kill class, whose ancestor incident is the 17,503-kills/day flood the
standard was built for) and **not acting on any of it**, pending a flip that is the operator's.

**So this is not merely an audit finding: there is a pending decision with 1,534 recorded would-denies of
evidence behind it.** Surfacing that is worth more than the verdict.

## Method note — no injection needed, and that is legitimate

I did not inject a violation. **I did not have to:** the guard's own counters record 1,616 occasions on
which it judged an action deniable and denied none. **That is stronger evidence than a single injected
case** — it is 1,616 natural violations, self-recorded, with the outcome attached.

**Rung 3 asks whether the guard bites. The guard's own ledger says it has never bitten, across 1,940
opportunities.** Recording that as `effective: false` on observational evidence rather than manufacturing
an injection that would tell me less.
