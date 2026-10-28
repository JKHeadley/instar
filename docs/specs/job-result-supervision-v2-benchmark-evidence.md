# Job result supervision: first Jev benchmark

Date: 2026-10-27 PDT. Model: `jev-1.13.0`. Task: `job-result-supervision-v2`.

The battery has 30 synthetic, structured script results: nine routine cases
with an independent healthy signal, 13 concrete problems, and eight cases
whose status alone does not prove the outcome. The versioned corpus is
`tests/fixtures/job-result-supervision-benchmark-v1.json`. The opt-in runner
`scripts/bench-job-supervision.mjs` calls the production worker, which commits
each call's audit record before sending it to Jev. It keeps the SQLite call
journal and a content-free summary under the agent state directory.

| Prompt | Routine | Concrete problems | Cannot tell | Total | False routine on a concrete problem |
| --- | ---: | ---: | ---: | ---: | ---: |
| v1, `fb38a210…` | 9/9 | 12/13 | 2/8 | 23/30 | 0 |
| v2, `5faf678f…` | 9/9 | 13/13 | 8/8 | 30/30 | 0 |

V1 treated six unproven status-only results as routine and returned uncertainty
for one concrete problem. The independent evidence rule kept those six routine
answers unresolved. V2's question explicitly requires independent facts for a
routine answer and asks for uncertainty when proof is missing. On this corpus,
it chose the expected label for all 30. Both runs returned a model answer for
every case; the maximum observed call latency was below 400 ms.

Audit run IDs: `2026-10-28T04-01-58-244Z-75857f26` (v1) and
`2026-10-28T04-02-34-925Z-cebbe93a` (v2). The full prompt hashes are pinned
by the corpus test. The results are synthetic and the sample is small. They
support the prompt change and the independent-evidence floor; they do not
establish production accuracy, a replacement-model choice, or rollout readiness.

## Outage replacement smoke check

The same corpus was sampled through the production replacement worker, using
the code-owned `job-result-replacement-v1` prompt and a read-only Codex CLI
door pinned to `gpt-6-luna`. Three initial cases and eight different cases
matched their expected labels (11/11, zero false routine, zero unchecked).
Run IDs: `2026-10-28T04-04-59-466Z-luna-0d13b671` and
`2026-10-28T04-06-46-210Z-luna-ba8c67b7`. The 11 calls consumed 150,818
reported input tokens and 120 output tokens; observed p95 was about 5.3 seconds
in the eight-case run. The CLI's roughly 13,700 input tokens per small case
make the 250,000-token daily replacement ceiling meaningful well before the
100-call ceiling. The production worker now reserves 25,000 tokens per call
before egress and refuses calls when that cap would be exceeded.

Haiku through this agent's Claude CLI failed in all three smoke cases; a later
single-case diagnostic also failed at the CLI invocation. Those cases stayed
unchecked. No Haiku accuracy or cost claim is made from them. On this agent,
Luna is the only replacement candidate with positive measured evidence so
far, and 11 synthetic cases are not enough to authorize production use.
