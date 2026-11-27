# First audited result-supervision benchmark — 2026-10-28

## Result

The corpus has 35 synthetic cases, with three Jev trials per case. The first
30 general cases matched the reviewed labels in all 90 calls. The five
cases shaped like the production `llm-decision-grading` script matched in 9
of 15 calls. Overall, Jev matched 99 of 105 *working labels*. The `routine`
labels on the two healthy grading-receipt cases are provisional: the receipt
proves the endpoint answered, but the model did not see a separate effect
proof, and the nonempty-work case has no independent effect verifier yet.
Those six disagreements are safe abstentions, not confirmed accuracy failures.
Jev never called an
expected problem routine, and it never called a missing-proof result routine.

| Gold label | Jev routine | Jev needs-session | Jev cannot-tell |
|---|---:|---:|---:|
| routine | 27 | 0 | 6 |
| needs-session | 0 | 42 | 0 |
| cannot-tell | 0 | 0 | 30 |

All six label disagreements were the two grading-job cases with a healthy server receipt.
Jev said `cannot-tell` in every trial. A separate three-call diagnostic on
the idle receipt showed the forward and reverse questions disagreed or sat
near the confidence boundary. This is a conservative abstention: it leaves the
result open instead of falsely declaring it safe. It also means the current
prompt and evidence cannot produce the hoped-for routine closure on the only
script in the first rollout cohort. The grading receipt proves the endpoint
ran; the stronger idle effect proof is deliberately kept out of Jev's input
and used only for later independent grading. We will not turn that later
proof into prompt leakage to improve this score.

Jev served `jev-1.13.0` in all 105 corpus calls. There were no Jev transport
failures. Total reported usage was 68,364 input tokens and 8,829 output
tokens. Observed median latency was 91 ms and p95 was 163 ms. The table
measures agreement with working synthetic labels, not independent production
accuracy. This measures
short synthetic inputs, not the live queue or end-to-end result latency.

## Outage replacement

The Haiku subscription route returned exit 1 on 21 attempts. A diagnostic
response identified the cause as `usage_limit_reached` (HTTP 429, weekly
limit). One interrupted attempt is explicitly recorded as unknown. Haiku has
no scored result and cannot be considered a benchmarked replacement.

One Luna pilot returned the expected `routine` verdict, but the Codex CLI
used 13,712 input tokens for that short case and its JSON stream did not
report an independently verifiable served-model field. Its audit row marks
`actualModel: null`. We stopped before a full Luna batch to avoid spending
hundreds of thousands of tokens on an unqualified route. Luna is not a
benchmarked replacement on this evidence.

## Rollout decision

Keep `JOB_COST_AUDIT_READY.resultTriage=false` and
`JOB_RESULT_SUPERVISION_COHORT='off'`. The synthetic benchmark is incomplete
for the backup route and does not supply the 300 observed, independently
gradable production outcomes per fixed shape, supervised test-agent proof,
or seven-day measured development trial required by the approved spec.
Next, review the grading receipt's meaning and the two-question Jev contract
without letting later outcome labels into the prompt; rerun the exact corpus
after a reviewed change. Retry Haiku only after its quota resets, or obtain a
different benchmarked replacement with verified served-model identity.

The content-free per-call evidence is in `results/pilot-20261028.jsonl` and
`results/diagnostic-20261028.jsonl`. Every provider attempt has a flushed
pre-call row and a settled, failed, or unknown terminal row. No production
job output or credential appears in these files.
