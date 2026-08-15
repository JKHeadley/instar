# Benchmark-derived routing defaults — DRAFT for the LLM-ROUTING-REGISTRY update
(interim 2026-07-02 ~03:45 PDT; finalize after A/B verdicts + OpenRouter remainder)

Basis: INSTAR-Bench v2 critical set (runs `crit-cli` + `crit-metered`, 3,030
scored calls, 11 critical gates × 108 limit cases, 487 forensic verdicts).
Digest: results/instar-bench-v2/CRITICAL-SET-DIGEST.md. Policy: operator
directive 2026-07-02 — subsidized-NON-Claude-first, tiered fallbacks per task,
every choice citing its bench run.

## Hard rules (bench-derived, cite crit-cli/crit-metered)

1. **NEVER route bounded gate/sentinel work through opus×claude-code-CLI.**
   Opus 0.940 via API vs 0.713 via claude-code CLI on identical prompts
   (verdict-first-then-contradict). Replicated on wave-2 tasks (prompt-gate,
   presence-stall failures all claude-opus). Sonnet/haiku on the same door are
   unaffected — this is an opus×CLI interaction.
2. **NEVER route bounded contract work to qwen-tier** (0.116 / 0.028 —
   chronic reason-burn self-clipping; replicates v1).
3. **NEVER route bounded-budget gates to reasoning-heavy tiers** —
   gemini-3.1-pro burned a 1024-token bench budget (5× production's 200) on
   thinking and clipped its own JSON (tone-gate bad-json cluster).
4. **gpt-oss-20b: no evidence-judging or adversarial-facing gates** (fell for
   judge-directed injection; fabricated evidence wording; over-refusal emits
   unusable output on adversarial cases). gpt-oss-120b: mild version of same.
5. **llama-4-scout: not for gate verdicts** (systematic over-conservatism +
   contract-breaking prose across external-op-gate/gate-triage cells).
6. **llama-3.3-70b: not for strict-JSON array emission** (malformed syntax —
   usher case).

## Tiered defaults per task nature (interim)

**Nature A — bounded verdict/extract, high volume** (MessageSentinel,
CommitmentSentinel, TemporalCoherence, PresenceProxy, ResumeQueueDrainer,
PromptGate, InputClassifier, extractors):
1. codex-cli → gpt-5.4-mini (0.926, subsidized non-Claude; p50 ~11.5s — fine
   for background, NOT for latency-critical)
2. pi-cli → gpt-5.5 (0.907, subsidized, p50 6.2s — the latency-sensitive pick)
3. gemini-cli → gemini-flash (0.954, subsidized; free-tier RPM makes it a
   low-volume lane only — rate-limit rows bought under concurrency)
4. claude-code → sonnet (0.991 — the accuracy ceiling of the whole board;
   Claude-quota, so a fallback not a default)
5. metered: glm-5.2 via OpenRouter (0.967, ~$0.002/call) · Groq gpt-oss-120b
   (0.778, free) for non-adversarial batch only
   [OpenRouter small models (flash-lite, gpt-5.4-mini/nano metered, haiku
   metered) unmeasured on v2 until top-up — v1 says flash-lite ≈ 1.00 at
   ~1.1s; slot above glm-5.2 if v2 confirms.]

**Nature B — critical judgment gates** (MessagingToneGate, CompletionEvaluator
both surfaces, ExternalOperationGate, LLMSanitizer, SessionWatchdog,
StallTriageNurse, UnjustifiedStopGate):
1. codex-cli → gpt-5.5 (0.917-0.926 subsidized; slow but these are low-volume)
2. pi-cli → gpt-5.5 (0.907, faster door, same model)
3. claude-code → sonnet (0.991 — best-in-class; use where Claude quota is
   acceptable, e.g. the tone gate that guards every outbound message)
4. metered: glm-5.2 (0.967) then opus-4.8-via-OpenRouter (0.940) — NEVER
   opus-via-claude-code-CLI (rule 1)

**Nature D — background digests/summaries** (SessionActivitySentinel,
SessionSummarySentinel, TopicSummarizer wave-3):
1. codex-cli → gpt-5.4-mini · 2. Groq gpt-oss-120b (free, 0.778, fine for
   non-adversarial summarization) · 3. claude-code → haiku (0.870)

## Notes for the final PR
- Each row cites: run stamp (crit-cli / crit-metered), pass-rate, p50.
- Add per-component `nature` tags (the registry's own proposal) — the wave-2
  task files already carry `nature` per component; lift them.
- A/B-winning prompt edits change the denominators — re-cite post-ship runs
  where an edit shipped (tone-gate especially: the rule-id fix should lift
  EVERY route's tone-gate score; the registry should note pass-rates are
  pre-fix lower bounds).
- gemini-cli swap-timeout caveat stands (R4 finding: 5s failure-swap cap vs
  8.5s p50) until the per-target swap-timeout fix ships.
