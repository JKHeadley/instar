# Job-result supervision v2 benchmark

This runs the synthetic, reviewed cases in
`tests/fixtures/job-result-supervision-benchmark-v1.json` through the exact
Jev question set used by the job-supervision worker. The optional Haiku route
uses the exact outage-replacement prompt. It does not run a scheduled job or
send production output to either provider.

Build first (`npm run build`), then run from this directory:

```bash
node run.mjs --state-dir /path/to/agent/.instar --route jev --trials 1 --stamp pilot
node run.mjs --state-dir /path/to/agent/.instar --route haiku --trials 1 --stamp pilot
node run.mjs --state-dir /path/to/agent/.instar --route luna --trials 1 --stamp pilot
```

Add `--only <case-id>` for a single-case transport check before a full run.

The Jev key is read in process from that agent's encrypted secret store. It is
never printed or passed on a command line. Each call writes and flushes a
`pre-call` record before contacting a provider, then a `settled` or `failed`
record with the served model, prompt and evidence hashes, latency, usage,
verdict, and synthetic working label. Two healthy grading-receipt labels are
provisional, as explained in `ANALYSIS.md`. Provider text and the key are
not stored. A failed or wrong-model call does not count as a scored answer.
Codex's JSON stream may omit the served model. In that case Luna's result is
marked `actualModel: null` and `modelEvidence: unverified-command-pin`; it is
research evidence, not eligible to authorize the replacement route. Haiku
quota exhaustion stops the batch after the first detected 429.

Results go to `results/<stamp>.jsonl`; rerunning the same stamp skips settled
case/route/trial combinations. This is benchmark evidence, not the 300 observed
production outcomes required for a fixed-result certificate. A benchmark alone
cannot open the code-owned rollout gates.
