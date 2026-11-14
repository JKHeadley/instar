# Convergence Report — Planned restart waits for accepted peer verifications (amendment)

## ⚠ Cross-model review: DEGRADED — ALL ROUNDS (degraded-all-rounds)

The GPT-tier reviewer (`codex-cli:gpt-5.5`) was invoked on all three rounds and failed every time with reason `error`. The wrapper discards the underlying message, so the cause is unknown; a direct `codex exec` on the same machine answered normally at 17:38Z. Filed as feedback `fb-3b1bf462-4cf`. The clean-door Anthropic read (`--family claude-code`) degraded in round 1 with `override-not-frontier`. This spec therefore converged on internal Claude reviewers and the Standards-Conformance Gate only. Read this before approving.

## ELI10 Overview

The machine that coordinates test runs sometimes restarts itself for routine reasons, such as installing an update. When it does, it throws away every test run it had handed to helper machines, even runs that were nearly finished. In one recent day that wasted about 78 minutes of helper work, and a pull request that loses its helper attempts falls back to a slower queue.

This amendment makes a routine restart wait, briefly, for those helper runs. The test service is the only part that knows whether a helper run is still alive and belongs to the current coordinator. It keeps a small note on disk, refreshed every 30 seconds while any helper run is in progress. The restart waits only while that note is fresh, and only for a run handed out within the last 21 minutes. In the last week, 412 of 414 helper runs finished inside that time. If the note is missing, stale or unreadable, nothing waits, which is exactly today's behavior. Emergency restarts and forced restarts never wait.

The trade-off is that routine maintenance can be delayed by up to 21 minutes. In return, finished work stops being thrown away.

## Original vs Converged

- **Originally**, the restart guard read the coordinator's queue file and waited for any reservation marked "accepted", for up to 20 minutes after dispatch. **After review**, a marker alone is not trusted. A stale marker from an old lease, a stopped service or a dead helper would have held restarts for nothing. The verifier now writes a heartbeat listing only runs that are under the current lease and whose helper answered within two minutes. The guard honors only a heartbeat that is under 90 seconds old.
- **Originally**, the heartbeat would have appeared only once a restart was pending, and counted as fresh for 30 seconds. **After review**, it is written whenever helper work is in flight and counts as fresh for 90 seconds. The first version would have failed open on almost every restart, because the restart checks every 10 seconds while the verifier writes every 30.
- **Originally**, a just-accepted run would not have counted until its first poll. **After review**, the accept itself counts as the first successful contact.
- The bound moved from 20 to 21 minutes, to allow one poll interval for the result to be imported. It is now backed by a 414-attempt measurement.
- Added: one wiring point, so all three consumers inherit the hold; audit events, so the hold can be measured; a rule for reconstructing the pre-period exposure; and a rollout note on supervisor version skew.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | security+adversarial, scalability+integration, decisions+lessons+P20, SCG (1 flag) | 7 (S1/P20-1/F3 stale marker, S2, F1 wiring, F2 import lag, DC-1 statistic, P20-2 persist, P20-3 exposure) | 6 | Heartbeat design, 21-min bound with data, wiring in guard, audit events, measurement rule, rollout note |
| 2 | all-lens | 2 (N1 freshness = tick, N2 first-heartbeat gap) | 3 | Write whenever work is in flight, 90 s freshness, atomic single write site, `lastPollOkAt` |
| 3 | all-lens (cap) | 1 (N6 accept seeds `lastPollOkAt`, low) | 4 | N6 and P1–P4 folded in as text and tests |

Standards-Conformance Gate: round 1 ran (1 flag: Verify the State, Not Its Symbol, engaged and resolved by the heartbeat corroboration). Rounds 2 and 3: not re-run (the internal all-lens reviewer carried the P20 lens).
Externals: codex-cli degraded (`error`) in rounds 1, 2 and 3 (body hashes 9be91491…, 58a22380…, 74d631da…); claude-code clean door degraded (`override-not-frontier`) in round 1, not retried.
Reviewer model: internal reviewers ran as Claude subagents on the session model (claude-opus-5-5). Round 1 grouped the six lenses into three subagents; rounds 2 and 3 used one all-lens subagent each. That is fewer independent reads than six separate reviewers would give.

At tag time, after round 3: the four structural sections were promoted to top-level headings, the base decision's decision point was added to the table, and a `## Maturation plan` was added because the tag writer requires it. These restate decisions already in the spec and add no new behavior. The plan was not reviewed by a round.

## Proportion

Tier 1: a small, reversible change to one guard module and the verifier tick, with tests. The amendment section is about 170 lines. Three rounds were used against a cap of 3. That fits the size of the change; the round-2 timing flaw justified the third round.

## Left behind

- S2: the marker can be persisted as `sending` for up to one loop iteration after accept. Moot now, since the heartbeat comes from the in-memory state.
- P1 (round 1): the observation is anchored at dispatch, not acceptance. Resolved by the 414-attempt data.
- P2 (round 1): a reservation accepted just before the request holds for its full bound. Stated under "No chaining".
- L-2: the same-holder `lease-lost` cause is out of scope. Tracked in the throughput ledger's open measurement gaps.
- F4: the multi-machine marker now cites the ratifying commit and approval line.
- F5: supervisor version skew is stated under "Rollout".
- N3–N5, P1–P5 (rounds 2–3): folded in as wording.
- Accepted residual: a helper that answers polls but never finishes can hold a routine restart for at most 21 minutes. Two of 414 runs in the last week exceeded 21 minutes and would still be abandoned.

## Full Findings Catalog

Round 1, security+adversarial: S1 (DESIGN, stale epoch or stopped service defers for nothing → heartbeat with epoch and lease check); S2 (DESIGN, low, `sending` ordering → left behind); P1–P3 (PRECISION).
Round 1, scalability+integration: F1 (DESIGN, the hold must live in `plannedRestartVerifyState()` → done); F2 (DESIGN, the 60 s import lag → 21-min bound); F3 (DESIGN, the standby sentence was false on disk → heartbeat staleness); F4–F5 (PRECISION).
Round 1, decisions+lessons+P20: DC-1 (DESIGN, the bound's statistic → 414-attempt audit); P20-1 (DESIGN, dead peer → `lastPollOkAt` within 2 min); P20-2 (DESIGN, import→persist→clear test → added); P20-3 (DESIGN, pre-period exposure → reconstruction rule and audit events); DC-2, L-1, L-2, J-1 (PRECISION).
Round 2, all-lens: N1 (DESIGN, high, freshness equal to the tick → 90 s); N2 (DESIGN, high, no heartbeat before the first tick → written whenever work is in flight); N3–N5 (PRECISION).
Round 3, all-lens: N6 (DESIGN, low, a new reservation lacks `lastPollOkAt` → seeded at accept); P1–P5 (PRECISION).
Decision-Completeness, final round: 9 frontloaded or stated decisions, 0 surviving cheap tags, 1 contested and cleared.

## Convergence verdict

Converged at round 3, the Tier-1 cap. The final round's one design finding (N6, low) was a single seeded field and has been folded in. No safety, security or data-loss finding remains. The outside GPT review never succeeded, so this convergence carries reduced assurance. The spec is ready for approval review.
