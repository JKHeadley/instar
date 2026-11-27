# Convergence Report — Fast focused preflight before full PR verification

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra reviewed the design through the installed Codex CLI. An attempted Claude Fable clean-door pass returned `no-supported-framework`; this report does not count it as a cross-model pass. The standards gate checked 93 articles on the final body and reported no findings.

## ELI10 Overview

Echo already builds and lints a proposed PR merge before the long tests. This design adds a small, time-limited check of tests affected by that exact PR version. It starts off. An observe mode measures whether the small check catches real failures and what it costs green PRs. Only a later, controlled enforce trial may report a repeated test failure early; the complete test suites remain the only way to say a PR is safe to merge.

An early red result does not make the PR disappear. Echo schedules one lower-priority full replay of the same PR, so a false early red can still be corrected by the normal green gate. This means the change may help green PRs move ahead in the queue, but it does not promise fewer total machine minutes. The rollout requires measured green-PR latency and throughput gains before continuing enforcement.

## Original vs Converged

The first draft said a test failing twice could end a PR check early. Review established that two exit codes are insufficient: both attempts must prove an assertion failed in the same selected file, with complete structured reports and zero unhandled errors from the trusted reporter. The final design also confines temp files, confirms child cleanup, keeps the full deadline allowance, and records evidence in validated peer records.

The first draft had no concrete path back from a false red. The final design gives the merge coordinator a durable, bounded replay obligation tied to PR head and target, handles crashes and base refreshes, and keeps replay behind already waiting PRs. Enforcement is limited to PRs the watcher can rediscover after a lease move. Observe qualifies detection and overhead; a later enforce experiment must demonstrate actual scheduling benefit.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
| --- | --- | ---: | ---: | --- |
| 1 | internal security, integration, scalability, decisions; Astra | 7 grouped | 4 | Strict stable-red proof; temp/process cleanup; deadline; peer record; matched observe outcome; staged rollout. Standards-Conformance Gate: ran (1 flag). |
| 2 | internal security, integration, decisions; Astra | 3 grouped | 3 | Durable automatic same-head replay, base refresh, queue-full status; clear liveness/cost tradeoff. Standards-Conformance Gate: ran (0 flags). |
| 3 | internal decisions; Astra | 4 grouped | 3 | Trusted unhandled-error reporter; fresh replay FIFO; explicit active deadline; two-way crash recovery; target identity. Standards-Conformance Gate: ran (0 flags). |
| 4 | internal security and integration; Astra | 4 grouped | 2 | Short macOS temp paths; stale peer guard; lifetime retry bound; namespace-only enforcement on lease movement. Standards-Conformance Gate: ran (0 flags). |
| 5 | Astra | 1 | 2 | Observe qualifies accuracy/overhead; bounded enforce trial measures actual throughput. Standards-Conformance Gate: ran (0 flags). |
| 6 | internal reviewers quiet; Astra | 1 corrected; final delta quiet | 4 | Admission backoff and breaker; same-key full-suite bypass after first early red. Final gate ran 93 articles with zero findings. |

## Proportion

Tier 2 design, six rounds against a six-round cap, for a roughly 100-line initial spec that grew substantially. The replay safety requirements are the principal source of complexity. Implementation should keep the feature dark until the measured tradeoff justifies enforcement.

## Left behind

- The exact statistical comparison for the 24-hour enforce trial needs a code-pinned measurement rule and a sufficient sample; insufficient evidence must be reported as inconclusive and leave the host off.
- Join observe preflight and full outcomes by the exact attempt, merge tree, head, base, and target when implementing telemetry; same-head alone is not enough.
- A same-user test can forge a convincing local report; structural validation prevents malformed or inconsistent evidence, not deliberate OS-user compromise.
- The pre-push helper's current listing functions return counts only; implementation must retain bounded normalized selected-file identities before enforcement.
- The push config's known-flaky exclusions narrow eligible coverage. Measure that limit instead of claiming detection of all changed-test failures.
- Admission and execution rearm allowances are both finite; implementation should use one shared lifetime counter and test exhausting both paths in sequence.
- Reserve a fixed cleanup window inside the 90-second cap so a timeout can kill and confirm descendants before the aggregate deadline.

## Full Findings Catalog

- **Round 1, security/adversarial (design):** A repeated exit code can be a collection crash or unhandled error. Resolution: structured assertion evidence from the same selected file on both attempts, zero trusted-reporter unhandled errors, uncertainty runs full lanes.
- **Round 1, integration/scalability (design):** Preflight can leak temp state or descendants into full tests, and selected integration/E2E tests may not be repeatable. Resolution: short private temp roots, bounded process-tree cleanup, dirty-tree recoverable error, matched test-agent rehearsals and exclusion of unsafe file classes.
- **Round 1, decisions/lessons (design):** A 90-second preflight consumes the full-run deadline, and peer records cannot carry its reason. Resolution: policy-hashed 90-second extension for entered attempts and bounded validated record metadata through peer import.
- **Round 1, decisions/lessons (design):** Observe needs a false-red comparison and real fail-fast savings estimate. Resolution: cross-tab to full outcome; replay costs included, no net machine-minute savings claim.
- **Round 1, standards (precision):** Maturation path and tier0 supervision were unclear. Resolution: 48-hour dark window, test agent, Echo observe/enforce, fleet opt-in; inherited Local Verify tier0 exception explained.
- **Round 1, Astra (precision):** Observe acceptance and exact-base command were underspecified. Resolution: mode-specific acceptance and complete `--changed <baseSha>` listing/run arguments.
- **Round 2, all internal reviewers (design):** A false early red could strand an unchanged PR. Resolution: automatic authoritative same-head full replay and supersession only by full-green proof.
- **Round 2, Astra (design):** Base refresh and queue-full admission lacked durable semantics. Resolution: replay obligation survives base SHA refresh, initial enqueue attempt bounded, pending status and admission retry breaker.
- **Round 3, Astra (design):** Vitest JSON lacks unhandled-error counts; replay could retake FIFO position. Resolution: installed trusted reporter required and fresh ordinary-priority replay timestamp.
- **Round 3, decisions/security (design):** Crash between red publication and replay marker could lose or create work. Resolution: persist before publish and reconcile both directions, exact current PR state checked before resurrection.
- **Round 4, integration (design):** Long worktree paths break tmux sockets; once-daily rearm was an unbounded loop. Resolution: existing short `/tmp/lv-*` seam and one lifetime rearm per replay key.
- **Round 4, Astra (design):** A non-namespace requested PR is not auto-rediscovered after coordinator lease movement. Resolution: enforcement only for watcher-rediscoverable namespace candidates; others use observe behavior.
- **Round 5, Astra (design):** Observe cannot measure the scheduling gain of a deferral it does not perform. Resolution: observe qualifies safety and overhead, then a time-bounded single-host enforce experiment measures the actual benefit.
- **Round 6, standards gate (design):** Five-minute indefinite admission polling violated the bounded-loop standard. Resolution: persisted exponential backoff, twelve attempts/24-hour breaker, one event-based rearm, then blocked status.
- **Round 6, Astra (design):** A full-red replay followed by a base refresh and permitted same-head request could create another early red without another replay allowance. Resolution: keep a bypass tombstone for that PR/head/target/policy until the key changes; every later verify runs full lanes.
- **Round 6, Astra (precision):** Exact-attempt telemetry join and baseline comparability need implementation detail. Resolution: recorded in Left behind; neither changes green authority or the bounded experiment rule.
- **Round 6 final delta, Astra (precision):** Shared versus separate one-time rearm and the teardown reserve need code-level choices. Resolution: recorded in Left behind; both interpretations are bounded and the implementation will pin one.

## Convergence verdict

Converged at round 6 after the P19 breaker and same-key bypass corrections. Internal reviewers found no remaining material design issue; the final standards gate checked 93 articles with zero findings. The final Astra delta review found precision issues only. Cross-model review ran on each changed body. Remaining measurement precision is recorded above. The spec is ready for implementation under Justin's existing 24-hour throughput authorization; that authorization is not a claim that he separately read this spec.
