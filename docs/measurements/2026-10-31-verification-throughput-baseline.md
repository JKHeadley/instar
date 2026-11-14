# Verification throughput baseline — 2026-10-30 23:23 PDT

Window: 2026-10-30 06:23 UTC through 2026-10-31 06:23 UTC. Sources: Echo's `.instar/state/local-verify/journal.jsonl`, `.instar/logs/local-verify.jsonl`, live `GET /local-verify`, `GET /test-runner-limiter`, and selected peer run logs. The journal records completed checks; it does not count a queued or cancelled attempt as a completion.

| Machine | Completed checks | Green | Red |
| --- | ---: | ---: | ---: |
| Studio | 3 | 3 | 0 |
| Mac Mini | 21 | 15 | 6 |
| M5 | 23 | 11 | 12 |
| Total | 47 | 29 | 18 |

The 47 checks covered 29 PRs and 46 distinct `(PR, head SHA)` pairs. Green runs consumed 369.5 machine-minutes (median 12.7 minutes); red runs consumed 198.2 machine-minutes (median 11.1 minutes). Those red minutes include necessary defect detection and cannot all be called avoidable waste. The M5/Mini red-rate comparison is confounded by which PRs and revisions each machine received; same-head comparison is needed before attributing the difference to M5.

The audit log provides a partial queue-wait sample by matching a `queued` event to the first `started` or `peer-dispatch` event for the same PR and head. For 56 peer dispatch events, the median was below one second and the maximum was 46.3 minutes. For four local PR starts, the median was 22.7 minutes and the maximum was 49.2 minutes. These are event-level samples, not a complete head-to-green distribution: the log has multiple events for some heads and excludes PRs still waiting. Track queue admission, supersession, dispatch, run start, run finish, and merge as one attempt lifecycle before treating this as a durable service-level metric.

At the live check, Studio's sole full-suite slot was held by an unrelated `test:all` run for over 90 minutes, with four ordinary suite requests waiting; the run was advancing through E2E output. Local Verify had `main` queued and two PRs already dispatched to peers. The existing host semaphore gives an ordinary waiter aged 15 minutes precedence over a merge-gate waiter. That prevents ordinary starvation, but can prolong a merge wait when several ordinary suites have aged. The host still has a one-suite limit for stability, so raising the cap or killing an advancing run needs separate evidence.

Representative failures: a recent M5 check of PR #2479 failed in `messaging-routes.test.ts` and its next check of the same head failed in `subscription-pool-routes.test.ts`; their differing files do not prove either a flaky test or an M5 fault. PR #2475 failed twice on M5 in a changed unit test, and PR #2480's failed unit file also failed in isolation, showing some reds are actionable regressions. The verifier already reruns eligible unrelated failed files in isolation and stops later lanes after a gating failure. The pre-push smoke runner already selects affected unit/integration tests, with breadth caps and an E2E path gate; its selection can skip broad or indeterminate changes. Any new early check should reuse or extend these mechanisms and remain non-authoritative for merge.

A second pass over the Studio journal found a first failed lane for 17 of the 18 red checks: 9 unit, 7 integration, and 1 E2E. The remaining red check was an error outside those failed-lane records. This is an upper bound on failures an early unit/integration check could catch, not an estimate of savings: the journal does not establish how many of those failed files would be selected by a bounded change-related preflight, and the preflight itself consumes machine time.

Before/after measurement should use fixed windows with at least: ready-to-green latency, queue wait versus execution time, ordinary suite occupancy on the coordinator, first-pass green rate, machine-minutes per merged PR, superseded-head work, failure attribution coverage, and main-red events. Preserve full-suite merge authority.
