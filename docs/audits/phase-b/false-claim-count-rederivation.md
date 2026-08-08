# Ruling (2) — re-deriving the false-claim count with job-enforced standards visible

**Directed at window-7 cycle 2:** *"the false-claim count and any ratchet floor calibrated on it are
QUARANTINED until the resolver learns that jobs enforce standards too… Report the corrected count when
you have it."*

## Corrected count: **0**

`falseClaimCount` was **1**. The single entry — `Cross-Store Coherence Is an Invariant` — is enforced by
a job that demonstrably runs:

| evidence | value |
|---|---|
| registration | `.instar/jobs/schedule/coherence-audit.json`, `enabled: true`, `20 9 * * *` |
| present on both machines | yes |
| activity events | **40** (32 `job_triggered`, 3 `job_alert_delivered`) |
| first / last | `2026-07-02T00:40Z` / **`2026-08-04T23:20Z`** |

**Corrected `falseClaimCount` = 0.** No standard in the registry asserts machinery that does not exist.

**The `false-claims <= 1` floor was therefore calibrated on a phantom** — it has been reserving headroom
for one false claim that was never false. The floor should be re-derived to 0 once the resolver is
fixed, which *tightens* it.

## The fix is NOT "make jobs count" — that swaps one weak proxy for another

The obvious repair is to teach the resolver that a job file is enforcement. **That would reproduce the
defect it is fixing.** Measured, of five candidate enforcement jobs:

| job | file exists | registered | **actually runs** |
|---|---|---|---|
| `coherence-audit` | ✅ | ✅ | ✅ 32 triggers |
| `correction-class-review-backstop` | ✅ | ✅ | ✅ 14 triggers |
| `correction-analyzer` | ✅ | ✅ | ⏳ registered 4h ago, first fire is Wed 09:00 — **correct, not dead** |
| `docs-coverage-audit` | ✅ | **disabled** | ❌ never |
| `failure-analyzer` | ✅ | **disabled** | ❌ never |

**Two of five job files enforce nothing.** A resolver counting file presence would classify their
standards as enforced — a *new* instance of the same defect, in the fix.

> **The correct predicate is `the job RUNS`, evidenced by activity-log triggers — not `the job file
> exists`, and not `the job is enabled`.** `docs-coverage-audit` is enabled-in-file and disabled-in-
> registration; `correction-analyzer` is enabled everywhere and legitimately has no runs yet. Only run
> history separates these three states, and only run history is causally tied to the claim.

## What I do NOT yet have, and why I am not guessing it

**The corrected GAP count.** It is at most 15 (16 minus Cross-Store Coherence) and probably lower, but
producing a defensible figure requires judging, per standard, whether a job **enforces** it or merely
**relates** to it — e.g. does `correction-class-review-backstop` (which does run) enforce *Never-Waste
Feedback — corrections compound*, or just operate nearby?

**That is a judgment, and making it across 15 standards by keyword match is precisely the technique
this audit has now been burned by four times.** The count comes when the resolver is fixed and the
judgment is made per standard with evidence, not before.

**So the quarantine stands on the gap count and lifts on the false-claim count:** `falseClaimCount = 0`
is verified by run history, not inference, and is safe to consume.

## Method note for the record

Three findings did not become false reports tonight because of one habit: **checking whether a thing is
supposed to be running before calling it dead.**

1. The laptop's `scheduler.enabled = missing` — correct; the Mini holds the lease.
2. The constitution's "false claim" — correct; the job runs.
3. `correction-analyzer` with no run history — correct; registered 4 hours ago, first fire pending.

**Each looked exactly like a defect. All three were healthy.** The habit is cheap — one query about
intent before one conclusion about health — and it is the specific practice the operator asked to have
named in the method lessons.
