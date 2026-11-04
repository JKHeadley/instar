# Jev first: decision inventory (working baseline)

Captured 2026-11-04T02:24:23.019716+00:00 from this agent’s feature-metrics SQLite ledger. Rolling seven-day window, LLM rows only. Token count is input plus output; cached tokens remain included, so it measures model workload rather than billed cash. This is a ranking, not a savings claim.

Total: 51,792 LLM calls and 484.1 million tokens across 44 components.

| Rank | Component | Calls | Tokens, M | p50 ms | Current model | Decision shape | Wrong answer / authority | Jev share evidence |
|---:|---|---:|---:|---:|---|---|---|---|
| 1 | MessagingToneGate | 4,932 | 116.94 | 4471 | gpt-6-luna | Jev before gate | hard block: message quality and self-stop | 20% prior held-out; revalidate |
| 2 | UnjustifiedStopGate | 3,248 | 60.37 | 4710 | gpt-6-luna | Jev before gate | hard block: unjustified stopping | unknown; zero confident unsafe clears |
| 3 | TopicIntentArcCheck | 3,622 | 59.06 | 4279 | gpt-6-luna | Jev-shaped | signal only; missed contradiction | unknown |
| 4 | completion-claim-verify | 3,990 | 57.47 | 6475 | gpt-6-luna | Jev-shaped clauses | false completion claim | unknown |
| 5 | TopicIntentExtractor | 2,761 | 49.91 | 6290 | gpt-6-luna | Jev before generation | missed durable topic signal | unknown |
| 6 | SessionActivitySentinel | 2,764 | 34.70 | 6603 | gpt-6-luna | Jev before generation | missed activity digest | prior test weak; retry |
| 7 | PromptGate | 20,128 | 32.52 | 5003 | gpt-6-luna | Jev-shaped | missed terminal UI prompt; false alerts | unknown; 88% errors in current calls |
| 8 | telegram-origin-recovery | 200 | 12.13 | 10532 | gpt-6-luna | Jev before generation | wrong origin recovery message | unknown |
| 9 | SessionWatchdog | 631 | 9.11 | 5342 | gpt-6-sol | Jev-shaped | wrong stuck-process action | unknown |
| 10 | MessageSentinel | 510 | 7.28 | 5003 | gpt-6-sol | Jev-shaped | wrong incoming message disposition | unknown |
| 11 | FeedbackReadinessArbiter | 381 | 5.98 | 18195 | gpt-6-astra | Jev-shaped | wrong work readiness | unknown |
| 12 | FeedbackTriageArbiter | 320 | 5.47 | 15074 | gpt-6-astra | Jev-shaped | wrong feedback triage | unknown |
| 13 | Usher | 339 | 5.38 | 5084 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 14 | StandardsConformanceReviewer | 131 | 4.48 | 14837 | gpt-6-astra | To inspect | Varies; inspect before migration | unmeasured |
| 15 | PresenceProxy | 266 | 3.70 | 4391 | gpt-6-luna,gpt-6-sol | Jev-shaped | false/missed standby reply | unknown |
| 16 | CommitmentSentinel | 208 | 2.94 | 4364 | gpt-6-luna | Jev-shaped | missed or false promise | fresh held-out pending |
| 17 | correction-class-review | 166 | 2.66 | 12941 | gpt-6-sol | To inspect | Varies; inspect before migration | unmeasured |
| 18 | jev-signal-shadow | 4,772 | 2.63 | 167 | jev-1.13.0 | To inspect | Varies; inspect before migration | unmeasured |
| 19 | server:correction-learning | 164 | 2.32 | 4745 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 20 | StandardsConformanceReviewer/fit | 109 | 2.08 | 7130 | gpt-6-astra | To inspect | Varies; inspect before migration | unmeasured |
| 21 | DashboardInsightEngine | 57 | 0.84 | 6593 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 22 | InputGuard | 59 | 0.78 | 4483 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 23 | jev-circles-shadow | 301 | 0.72 | 169 | jev-1.13.0 | To inspect | Varies; inspect before migration | unmeasured |
| 24 | GoalPriorityExtractor | 47 | 0.69 | 5151 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 25 | AlignmentReviewer | 48 | 0.64 | 5609 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 26 | MachineLoadAssessor | 36 | 0.51 | 4392 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 27 | correction-meaning-grouping | 604 | 0.39 | 93 | jev-1.13.0 | To inspect | Varies; inspect before migration | unmeasured |
| 28 | ProfileIntentClassifier | 31 | 0.36 | 3947 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 29 | jev-correction-shadow | 454 | 0.34 | 205 | jev-1.13.0 | To inspect | Varies; inspect before migration | unmeasured |
| 30 | CorrectionMeaningGrouping | 24 | 0.33 | 4028 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 31 | crossModelReviewer | 16 | 0.31 | 18239 | gpt-6-astra,claude-opus-5-5 | To inspect | Varies; inspect before migration | unmeasured |
| 32 | TopicSummarizer | 14 | 0.24 | 7205 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 33 | FeedbackTriageSecondOpinion | 18 | 0.20 | 2238 | opus | To inspect | Varies; inspect before migration | unmeasured |
| 34 | jev-load-assessment | 309 | 0.17 | 377 | jev-1.13.0 | To inspect | Varies; inspect before migration | unmeasured |
| 35 | PeerUserMeantJudge | 9 | 0.11 | 6403 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 36 | PipeSessionSpawner | 8 | 0.11 | 3974 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 37 | EcosystemIdeaReview | 6 | 0.10 | 9696 | gpt-6-astra,claude-fable-5 | To inspect | Varies; inspect before migration | unmeasured |
| 38 | jev-memory-picker | 72 | 0.06 | 170 | jev-1.13.0 | To inspect | Varies; inspect before migration | unmeasured |
| 39 | InputClassifier | 4 | 0.06 | 5471 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 40 | MoveIntentClassifier | 3 | 0.03 | 4532 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 41 | WarrantsReplyGate | 1 | 0.01 | 3603 | gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |
| 42 | CompletionEvaluator | 1 | 0.00 | 0 | unknown | To inspect | Varies; inspect before migration | unmeasured |
| 43 | CompletionEvaluator/P13 | 1 | 0.00 | 0 | unknown | To inspect | Varies; inspect before migration | unmeasured |
| 44 | peer-user-meant | 27 | 0.00 | 395 | jev-1.13.0,gpt-6-luna | To inspect | Varies; inspect before migration | unmeasured |

## First replay order

1. **MessagingToneGate:** largest token volume. Recheck a Jev first pass that preserves every hard block; earlier held-out work cleared 18.3% of messages but had one coverage gap. Prespecified bar for a new live candidate: zero confident unsafe clears in at least 100 independently labelled messages; uncertain or uncovered rules always reach the full gate. The earlier 20% share is a planning assumption, not a new measurement.
2. **TopicIntentArcCheck:** 59.1M weekly tokens, signal-only classifier. Test a complete snapshot of draft and tracked refs, with explicit cannot-tell. Prespecified bar: >=95% agreement on actionable signals and zero confident misses on authoritative contradictions in at least 100 labelled pairs.
3. **Completion claims:** 57.5M weekly tokens, structured clause decision. Prespecified bar: >=95% recall for unsupported completion claims, >=90% precision, no confident miss of a fabricated completion in at least 100 labelled clauses.
4. **Interactive prompt detection:** 32.4M tokens and 18.9k real calls in the latest seven-day window; 16.7k errored (88.4%). It detects blocking terminal UI prompts, despite the old provenance name `prompt-injection-detect-v1`. First investigate the error path before judging Jev; a failing current comparator cannot be used as truth.

## Savings arithmetic

For each decision, potential weekly big-model tokens saved = current weekly tokens × Jev-settled share × fraction of the original call actually skipped. A decision inside a generation call may save nothing unless the full call is avoided. Each estimate stays explicitly assumed until measured on held-out rows and verified in live feature metrics. Benchmark-selected fallback and one-provider behavior are required before any promotion.

## Fresh shadow-log analysis, 3 November

I re-counted the last seven days of the live Jev artefact-signal log. It contains 4,651 compared messages on pinned `jev-1.13.0` and 186 that were not compared (116 timeouts, 40 expired-soak events, 16 concurrent skips, 10 breaker-open events, 4 HTTP errors). Jev gave confident negative answers to all seven current artefact questions on 3,398 of the compared messages (73.1%). That is an **artefact-only upper bound**, not a safe full-gate bypass: the current battery does not cover the gate's behavioral, health-alert, style, or other signal rules. No big-model tokens have been credited as saved. A full-coverage replay with independent labels remains the promotion gate.

## Fresh promise replay, 3 November

The precommitted `jev-1.13.0` threshold was `no <= 0.2`. On all 151 eligible user/agent pairs since 2 November, Jev answered all 151, median 145 ms, p95 213 ms. The existing sentinel-derived label and a new GPT-6 Luna label disagreed on 88 pairs, so only 63 had agreement (24 positive, 39 negative). Within those 63, Jev caught 23/24 positives (95.8% recall) but only 23/32 positive flags were agreed positives (71.9% precision, below the 85% bar). The 40-agreement minimum was met; the precision bar was not. Jev returned a negative at this threshold on 57/151 pairs (37.7% potential skip), but the negative direction has not passed independent human or batch-level review. No live shortcut or token saving is claimed from this replay. The harness output stays machine-local because it contains conversation text.

## Earlier multi-point replay recovered from the handoff

The pre-swap helper had already run a larger Jev-first battery on local, gitignored samples. I recovered its content-free results instead of repeating the calls. The first frozen thresholds were very conservative: on the test split, MessagingToneGate could clear 13/1,492 (0.9%) with zero raw misses; TopicIntentArcCheck 2/616 (0.3%); TopicIntentExtractor 19/660 (2.9%); and UnjustifiedStopGate 1/825 (0.1%). Completion claims had 46/1,413 clears (3.3%), but there were **zero positive labels**, so the safety direction was never exercised. MessageSentinel's design split had misses even at its lowest candidate threshold, so it selected no live threshold.

The helper then tuned per-question thresholds after inspecting the first test split. Exploratory later results suggest larger shares but are **not a fresh held-out confirmation**: the tone gate cleared 236/1,492 (15.8%) with three raw hard-block misses; the stop gate cleared 625/825 (75.8%) with 29 raw soft misses; the arc check cleared 117/616 (19.0%) with nine raw soft misses; the extractor cleared 105/660 (15.9%) with eight raw soft misses. These rows cannot support a live promotion without independent adjudication of misses and a new future holdout, especially the tone gate's hard-block misses. The files are under the local `docs/research/jev/harness/jev-first/` directory; raw samples remain gitignored.

**Revised engineering order:** (1) Stop gate, because its exploratory 75.8% share against 60.4M weekly tokens is the largest potential gain, contingent on a new independent hard-block holdout; (2) tone gate, 116.8M weekly and 15.8% exploratory share, but first resolve the three hard misses; (3) topic arc, 59.0M weekly and 19.0% exploratory share, lower authority; (4) topic extraction, 50.3M weekly and 15.9% exploratory share; (5) completion claims, 57.2M weekly but the current replay contains no positives; (6) prompt detection, 32.4M weekly but fix the 88.4% LLM error path before a model comparison. These are priorities for validation, not credited savings.

The three tone-gate hard misses are all the same real rule: the reply parks substantive work for later. The first Jev question asked only about stopping because of the agent's *own state* (context limits, fatigue, fresh session), so it did not cover this broader deferral rule. A second question from the exploratory run asks whether work is stopped, paused or left for later for any reason. Requiring that probability to be at most 0.2 would have removed all three misses while still clearing 168/1,492 test rows (11.3%, roughly 13M weekly big-model tokens at current volume). This is retrospective tuning on the same test set, **not** a passing validation. Freeze the revised question and threshold now, then test on new future rows with independent adjudication before live use.

The prospective tone run began after the frozen time. At 19:32 PST on 3 November, 36 new gate rows had both pinned Jev question sets completed: 4 incumbent blocks, 9 proposed Jev clears, and no clear/block disagreement. This is an early operational check of the runner, not a quality result; the predeclared minimum is 500 rows, 100 blocks, and independent adjudication. The future output remains local and is excluded from the earlier retrospective figures.

## Measurement limitations

The metrics ledger counts retries and cached input, and some decisions have no labelled ground truth. Runtime `PromptGate` is interactive-terminal-prompt detection despite its provenance identifier saying “prompt injection”; its error rate must be traced before interpreting agreement. The prior tone-gate replay used old thresholds and version 1.13.0; new thresholds need a fresh, pinned run.

The 88.4% seven-day `PromptGate` error rate is dominated by a six-hour incident on 1 November, 12:00–17:59 UTC: the ledger records thousands of errors per hour then. In the latest 24 hours at 19:37 PST on 3 November it recorded 715 rows: 20 errors, 493 calls shed without running, and 202 completed calls. Thus the weekly error percentage is not the current error rate, but the current shed rate still needs investigation. The ledger has no error reason, so the incident's cause is not established by these counts.
