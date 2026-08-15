# INSTAR-Bench v2 — Critical-Set Digest (interim, 2026-07-02 ~03:00 PDT)

3,030 scored calls · 11 critical gates/sentinels · 108 limit cases (5 stress axes)
Runs: crit-cli (8 subscription-CLI routes, 864 calls) + crit-metered (Groq free
lanes + 3 OpenRouter frontier models measured before the vendor wall).
All 487 failure groups forensically judged (model-limit vs prompt-improvable vs
case-defect vs infra-transient). OpenRouter remainder (~16 routes) pending top-up.

## Route leaderboard (pass-rate on deterministic cases, post-rescore)

| route | door | pass | p50 ms | cost |
|---|---|---|---|---|
| claude-sonnet | claude-code CLI | **0.991** | 3784 | sub |
| glm-5.2 | OpenRouter API | 0.967 | 4650 | $0.31 |
| gemini-flash | gemini CLI | 0.954 | 9053 | sub |
| gemini-3.1-pro | OpenRouter API | 0.948 | 5378 | $1.75 |
| claude-opus-4.8 | OpenRouter API | 0.940 | 2442 | $2.54 |
| gpt-5.5 | OpenRouter API | 0.930 | 3325 | $2.04 |
| gpt-5.4-mini | codex CLI | 0.926 | 11537 | sub |
| gpt-5.5 (plain) | codex CLI | 0.926 | 11958 | sub |
| gpt-5.5 | codex CLI | 0.917 | 9778 | sub |
| gpt-5.5 | pi CLI | 0.907 | 6198 | sub |
| claude-haiku | claude-code CLI | 0.870 | 6311 | sub |
| llama-4-scout | Groq free | 0.810 | 1097 | ~0 |
| gpt-oss-120b | Groq free | 0.778 | 916 | ~0 |
| llama-3.3-70b | Groq free | 0.764 | 682 | ~0 |
| **claude-opus-4.8** | **claude-code CLI** | **0.713** | 4024 | sub |
| gpt-oss-20b | Groq free | 0.657 | 736 | ~0 |
| qwen3-32b | Groq free | 0.116 | 1443 | ~0 |
| qwen3.6-27b | Groq free | 0.028 | 2059 | ~0 |

(or-* rows with 0/N calls are pre-wall stubs — excluded; they re-measure after top-up.)

## The findings that matter

1. **The DOOR degrades Opus specifically.** Identical model, identical prompts:
   Opus via OpenRouter API 0.940 · Opus via claude-code CLI **0.713** (−0.23).
   Sonnet and Haiku via the SAME CLI door are fine (0.991 / 0.870), so it is an
   opus×CLI interaction (verdict-first-then-contradict pattern per forensics),
   not a door defect in general. Routing rule: bounded gate/sentinel work must
   not ride opus-through-claude-code; sonnet-CLI is the top route outright.
2. **Sonnet-CLI 0.991 is the quality ceiling of the whole board** — on
   subscription, beating every metered frontier route on these bounded tasks.
3. **glm-5.2 (0.967, $0.31) is the metered value pick** for critical gates;
   gemini-flash-CLI (0.954, subscription) the free runner-up.
4. **qwen-tier is disqualified for bounded contract work** (0.116/0.028 —
   chronic reason-burn cuts off its own verdicts; replicates v1).
5. **The #1 defect was OURS**: the tone-gate prompt enumerates short rule ids
   ("rule MUST be exactly one of B1–B9, B11, …") while the production parser
   demands full identifiers and fails closed on the short form. Every model
   through every door obeyed the prompt and "failed". Fix in A/B now
   (variants/tone-gate.rule-id-contract.json).
6. **Five more cross-model prompt gaps queued + in A/B**: completion-judge
   claim-is-not-evidence (5 models credited bare assertions); external-op-gate
   in-content approval-injection compliance + degenerate-input branch;
   p13-stop-judge undefined no-stop branch + wall-clock off-ramp;
   input-classifier "unsure" catch-all over-relay; sentinel-classify empty-input.
7. **2 bench case defects found and fixed** (b18 stacked-reason ambiguity,
   buried-evidence test-file provenance) — the bench fixes itself; models were
   not blamed for defensible readings.

## Infra honesty
248 metered + 1 CLI failure groups were rate-limit/vendor-wall/transport noise,
verdicted infra-transient and EXCLUDED from model + prompt signals.
