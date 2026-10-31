# Convergence Report — Queue pace: arrivals vs completions for every work queue, and a bounded pace tuner

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in all six rounds; each returned
SERIOUS ISSUES that were then resolved in the spec.

## ELI10 Overview

Instar has several to-do piles that background jobs work through: feedback sorting, feedback fixes,
maturation fixes, promises and self-improvement items. Justin asked whether each pile is shrinking or
growing, and for something that speeds a job up when its pile grows faster than it is worked. Today
nothing measures that and every job runs at a fixed pace.

This design adds an hourly measurement of every pile (items in, items done, items that left for other
reasons, what is still open), a plain verdict (catching up, holding, falling behind, shrinking but not
by finishing work, or unknown), and the reason a pile is behind (the worker itself, a fixed limit,
the account's usage limit, or a person). Where — and only where — the worker itself is the slow part,
it asks the feedback sorting service for a few extra rounds a day, inside every limit that already
exists. Everything shows on a Pace card in the console and on the maturation board; Justin hears about
a pile only after the speed-up has done all it can, and work waiting on him is shown as information,
never pressure.

## Original vs Converged

- **Evidence.** The first draft decided "the worker is the slow part" from a workload ledger that no
  feedback job writes and any session could fake. Now the triage service itself writes a row for
  every tick and every refusal, and "worker" needs positive evidence in at least 3 of the last 4 ticks.
- **Counting.** The first draft's "open = previous + arrived − completed" broke on holds, requeues and
  expiry, and hourly snapshots miss fast in-and-out items. Now each queue counts from the owner's own
  timestamped events, reconciles them id-by-id against a snapshot read at the same boundary, counts
  non-success exits separately, and refuses to count gap recoveries or snapshot-only guesses toward
  rates or tuning.
- **Verdicts.** Disjoint rules with a tolerance and hysteresis; "shrinking by exits" is no longer
  mistaken for progress; days-to-clear only when genuinely draining.
- **What the tuner does.** The first draft triggered extra job runs; the triage job turned out to run as
  a full AI session, so extra runs would have cost whole sessions and bypassed the right gates. Now it
  asks the triage service directly for an extra tick (`acceptTick` only), which carries the service's
  own single flight, rate limit, quota pause and call cap; a busy service is a skip, not a slowdown;
  the daily budget is reserved durably before each call and fails closed if its state is lost.
- **Honest limits.** When the daily triage call cap would be reached, the bottleneck is named `cap`
  and nothing is pushed — which may well be the steady state, in which case v1's value is the
  measurement and the named limit.
- **Notices.** The first draft waited 24 h, breaking the 300 s visibility ceiling, and framed work
  waiting on Justin as a red "falling behind". Now the card shows the state within minutes; an
  attention item fires only after the speed-up is exhausted or unavailable; work waiting on a person is
  neutral information.
- **Machines.** Commitments and action items turned out to be per-machine, and feedback has its own
  operated host; rows are keyed per machine and owner, notices carry the machine id, and an
  "owner not serving" state stops false alarms while the feedback host is not the one running ticks.
- **The motivating incident** was re-diagnosed during review: the four stuck feedback PRs were not
  waiting for Justin but had failed independent review; that fix is a separate spec
  (`feedback-executor-review-failed-recovery.md`).

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, security+adversarial, scalability+integration, standards+lessons | 30+ | 0 | evidence source, counting, retries, quota, notices, person framing, multi-machine, precedence, verdicts |
| 2 | codex, combined internal | 8 | 0 | event-sourced counts, verdict shrink case, evidence freshness, immediate-only, refusal rows, heal-unavailable path, baseline rows, explicit enable owner |
| 3 | codex, combined internal | 6 | 0 | spec-path completion, elapsed-time coverage, budget fail-closed, in-process service tick, projected cap |
| 4 | codex | 3 | 0 | gap events separated, spec-path context only, crash-safe commit order |
| 5 | codex | 2 | 0 | post-gap baseline, durable budget reservation |
| 6 | codex, combined internal | 3 | 6 | read boundary + id-level reconciliation, `acceptTick` only with row-read outcomes, leftover sentence removed |

Standards-Conformance Gate: ran (0 flags) in round 1; later rounds: not re-run (unavailable in this
session's flow), honestly recorded.

## Proportion

Tier 2 (new authority to add work ticks; ~6 queue adapters, a ledger, a tuner, a route, a card). 6
rounds used of the Tier-2 cap of 6.

## Left behind

- Rename `maxExtraRunsPerDay` → `maxExtraTicksPerDay` (cosmetic; builder may rename).
- `callsUsedToday`: the tuner reads it from the triage summary's existing `drainStore.authorityCallsToday`
  source; the builder adds an accessor beside `quotaStatus()`.
- `pauseThreshold` is the constant 75, so the 10-point margin means "below 65%"; stated in code comments.
- "Remaining scheduled ticks today" comes from the triage job's `*/15` cron, which also defines the
  ±2-minute exclusion window.
- The projected-cap condition appears in both the `worker` definition and step-up; the builder keeps
  one implementation.
- Accepted at the cap (not safety, security or data loss): v1 may rarely tune at all if the call cap
  binds first; the measurement and the named limit are the deliverable in that case.

## Full Findings Catalog

See the iteration summary; every design finding from every round is resolved in the spec text named
above, and the reviewers' raw outputs are kept in the session log.

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The final round's design findings were resolved in the spec;
the remaining items are precision and listed above. Spec is ready for approval.
