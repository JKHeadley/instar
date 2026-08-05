# LIVE DEFECT — the memory gate has refused 626 job spawns on a machine under no pressure

**Found:** 2026-08-05 ~12:00Z, investigating a management ruling that pre-authorised memory cleanup.
**Status:** ONGOING. Most recent refusal was ~10 minutes before this was written.

## The numbers

| | |
|---|---|
| job spawns refused for "memory pressure" | **626** |
| window | `2026-08-04T00:00:00Z` → `2026-08-05T11:55:00Z` |
| worst consecutive-failure streak | **492** |
| top refused | `commitment-detection` 245 · `health-check` 233 · `mentor-onboarding` 74 · `llm-decision-grading` 23 · `hourly-realignment` 21 |

## The machine is not under memory pressure

| signal | reading |
|---|---|
| `memory_pressure` — the OS's own | **43% free** |
| `Pageouts`, two samples 5s apart | **1,589,709 → 1,589,709 — identical** |
| `Swapouts`, same interval | **217,427,150 → 217,427,150 — identical** |
| swap used | 18.9 GB of 19.5 GB (**97%**) |
| our gate's `hostFreeMemPct` | **18.2%** |

**Zero paging activity.** Nothing is thrashing.

## Two distinct defects, both of the phase's signature shape

### 1. Swap-used is a high-water mark read as a live gauge

macOS allocates swap and **does not shrink it**. The 97% figure records the worst moment this machine
has had — during the pressure period that was already documented — not its current state. It has been
reporting that historical worst as though it were now, ever since.

> **MEASURES:** cumulative swap allocated since boot. **CERTIFIES:** the machine is under memory
> pressure now. **The gap:** every hour since the pressure passed.

### 2. Our free-memory metric disagrees with the OS by 25 points

`hostFreeMemPct()` computes `(free + inactive + purgeable) / total` and reads **18.2%**. The OS's own
pressure facility reads **43%**. The gate's refusal threshold sits between those two numbers.

**So the gate refuses on a healthy machine**, and has done for a day and a half. This sharpens Phase A's
B5.2 (the gate/reaper threshold mismatch) considerably: the problem is not only that two of *our*
thresholds disagree with each other, but that our metric disagrees with **the operating system's**.

## Why this is the window's most consequential finding

Everything else found this window is a *spec-level* or *verification-level* defect — real, but nothing
was actively broken while I described it.

**This one is switching off the scheduler right now.** `commitment-detection` — the job that notices
what I have promised — has been refused 245 times. `health-check` 233 times, one streak reaching 492.

> **The measure-vs-certify defect, in the place where it costs the most:** not a wrong verdict on a
> dashboard, but 626 pieces of work that did not happen, on a machine that was fine.

## What was NOT done, deliberately

Cleanup was pre-authorised. **None was performed, because there is nothing to clean** — three agent
servers (echo, codey, bob, all live), three sessions, and an operator-owned browser. No leak, no
runaway, no dead process.

Killing something here would have produced a satisfying report and left the actual defect untouched.
**The pre-authorisation was granted on the strength of a number that does not mean what it appears to
mean**, which is exactly why the first step was measuring rather than acting.
