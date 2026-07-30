# A background check stops generating an answer it throws away

## What Changed

`ClaimClauseArbiter` asked every call for a two-part envelope — `legacy` (the clause labelling the
system consumes) and `general` (an experimental extraction of up to 4 factual claims, ~20 fields
each, with byte offsets and 8–11-option enums).

But the call site admits `general` only on one framework:

```
const general = resolvedModel?.framework === 'claude-code' ? parsedGeneral : null;
```

The prompt was never told about that rule. On an install whose internal components route off
Claude — which is now the shipped default (`provider-fallback-default-policy`) — the model was
asked for `general`, spent real latency and tokens producing it, and the result was discarded
100% of the time.

The knock-on effect is what makes it a fault rather than only waste: generating the discarded
half regularly pushed the call past its own `timeoutMs: 60_000`, which killed the `legacy` half
the system actually uses.

Now the framework is resolved **before** the prompt is built, via the router's existing
`for(component)` resolver, and `general` is requested only when that resolves to `claude-code`.

- **Claude-routed installs are byte-identical.** `includeGeneral` defaults to `true`; only a
  positively-resolved, non-empty, non-`claude-code` string suppresses it.
- **Every uncertainty fails toward the old behaviour** — resolver absent, returning `undefined`,
  returning a non-string, or throwing all send the full prompt. Suppressing a shipped (if dark)
  extractor on a guess is the one outcome worth avoiding, so nothing guesses.
- **The two prompt shapes get distinct ids.** `CLAIM_ARBITER_PROMPT_ID_LEGACY_ONLY` keeps
  per-prompt latency/quality attribution from blending a fast small prompt with a slow large one.
- **`CLAIM_ARBITER_COMPONENT` is shared** between the resolver and the call's attribution, so the
  gate can never consult a different routing entry than the call bills to.

The admission rule itself is unchanged, byte for byte. This changes what is *asked for*, never
what is *accepted*.

## Evidence

Measured on a live two-agent machine, 2026-07-29, before writing the change.

**Production symptom** (`/metrics/features`, 24h, `completion-claim-verify`): 1,207 calls,
**956 errors (83.5%)**, 62 shed, 189 succeeded. `p50 49,315 ms`, `p95 60,082 ms`, `max 64,966 ms`
against a 60,000 ms wall. Input 2,430,258 tokens; output 462,638. 964 of the 1,207 calls ran on
`codex-cli` — the path where `general` is discarded.

**Controlled A/B**, interleaved A,B,A,B,A,B so a slow patch on the door could not be attributed
to one variant. Same model (`gpt-5.4-mini`), same door, same message, clauses and evidence.

| Variant | n | Median | Range | Avg output tokens | Inside the 60s wall |
|---|---|---|---|---|---|
| Full (`legacy`+`general`) | 3 | **129,204 ms** | 91,520 – 148,719 | 8,338 | **0 / 3** |
| Legacy-only | 3 | **28,153 ms** | 24,965 – 33,708 | 1,386 | **3 / 3** |

**4.6× median latency, 6.0× output tokens, and the ranges do not overlap.**

**Correctness, not only speed.** The legacy-only reply was confirmed valid JSON matching the
legacy schema and materially correct: it labelled *"Restart whenever suits you"* as `neither`
(*"imperative to the user, not a commitment or completion assertion"*) and flagged
*"Everything green"* as `corroborated: false` (*"no independent test evidence is provided here"*).
So this is a cost removal, not a capability trade.

**Test discrimination.** The new tests were run against the unfixed source with only the test
staged: **6 failed / 4 passed**. The 4 passes are labelled `CONTROL` and pass on both revisions by
design — two of them only revealed themselves as non-discriminating *because* that unfixed run was
performed. Only the 6 failures are counted as evidence.

## Honest limits

- n=3 per arm. The conclusion rests on the non-overlap and the size of the gap, not on sample count.
- Timings came from a direct `codex exec` invocation rather than through instar's provider
  (different sandbox/env/out-dir), so **absolute** numbers may differ in production. The **ratio**
  is the load-bearing result and it is controlled.
- The expected drop in that 83.5% error rate is a **prediction until the shipped number moves**,
  and is deliberately not claimed as proven. <!-- tracked: CMT-1118 -->

## What to Tell Your User

If your agent's internal checks run on a non-Claude model — the shipped default — one background
check was quietly asking for a large answer it then threw away, and the cost of producing it was
making that check time out and fail about 83% of the time. It now asks only for the part it uses.
Nothing changes for agents routed to Claude.

## Summary of New Capabilities

None. This removes waste from an existing check; no new surface, route, config key, or capability.
