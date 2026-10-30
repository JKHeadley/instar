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

A direct synthetic Claude CLI probe on 2026-10-27 at 21:47 PDT identified the
failure as this agent's exhausted weekly Claude quota. The CLI reported a reset
of October 29 at 2 PM Pacific. This is an availability result, not a Haiku
quality result. A Haiku benchmark must wait until that quota is available;
the one-provider path and unchecked accounting remain the safe behavior now.

## Current production sample

As of October 30 at 8:36 AM PDT, Echo's run history contains 68 production
`llm-decision-grading` script attempts since the conversion: 65 successful,
two skipped, and one still marked pending in run history. Its matching
supervision row is `expired-unchecked:outcome-unknown`, so it is visible rather
than treated as success. Six `script-canary` side runs are excluded from that
production count. The supervision ledger has 68 matching attempt rows, all
with unknown independent grades while the decision gate is
off. This is below the spec's 300 observed **and** 300 independently gradable
outcomes per common fixed shape. No fixed-routine certificate is justified.

## October 30 outage replacement trial

The approved replacement prompt changed to v2 (`46589a…`) after Haiku's
unconstrained replies included prose outside the required JSON. The new
Haiku path requests a JSON schema and disables the Claude CLI's hidden
structured-output retries. The Codex path now supports a strict model pin
that disables its automatic model-retirement retry for audited calls. These
opt-ins keep one logical model request per durable pre-call record.

Before that change, Haiku's fail-safe parser produced 2 of 10 expected labels
on the v1 prompt. This is **not** a valid-format accuracy score: invalid
response formatting could be mapped to `cannot-tell`, including for the two
cases whose expected label was `cannot-tell`. It made no false routine closure,
and its 10 calls consumed 225,453 reported input tokens. The benchmark now
records malformed replies as failed calls, with no settled verdict. Haiku is
**not qualified**. The next run pins a concrete Haiku version and requires
the CLI response's single served-model report to match it. The old alias and
new concrete pin share the same daily token cap. The schema-constrained
retry must wait until the next UTC-day allowance under the 250,000-input-token
daily benchmark cap.

Luna's fail-safe parser produced the expected label for 17 distinct v2 corpus
cases: routine, actionable failure, and cannot-tell cases all appeared in the
sample. These five run summaries predate the `strict-json-v2` evaluator field.
Thirteen routine or actionable answers necessarily had valid JSON;
four `cannot-tell` answers still need a strict-format rerun because the old
parser could map malformed output to that same label. There were zero false
routine and zero unchecked cases under the earlier parser. The 17 calls reported 233,166 input
tokens and 187 output tokens; observed p95 was 4.8 seconds. All calls used the
production worker's pre-call SQLite audit and settled under the pinned
`gpt-6-luna` CLI route. The Codex CLI reports the resolved local model pin,
not an independent served-model attestation; that distinction remains a
qualification gate. The run IDs are
`2026-10-30T15-11-27-026Z-luna-bec4dc8e`,
`2026-10-30T15-11-56-786Z-luna-fd4583c7`,
`2026-10-30T15-14-39-775Z-luna-669c62c5`,
`2026-10-30T15-15-16-047Z-luna-bf233a6d`, and
`2026-10-30T15-15-42-802Z-luna-c03bc370`.
The first nine calls preceded the strict-pin code change; the last eight ran
after it. No model-retirement fallback was reported in any call.

The v2 corpus has 35 cases. Seventeen synthetic cases are an encouraging
initial sample, not replacement qualification. The four format-ambiguous
cases, remaining corpus, a real outage
trial, and development shadow evidence remain open. No production gate changed.
