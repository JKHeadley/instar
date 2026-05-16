# Model Fitness Catalog — v0.1

**Status:** Active, living document. **Adopted 2026-05-15** as part of Phase 5a (model+framework fitness research).

## What this is

A per-model assessment of strengths, weaknesses, and best-fit task types. The selection layer (Phase 5b) consumes this catalog when suggesting a model for a given task. The benchmarking framework (Phase 5d) keeps it honest over time.

## What this is NOT

- NOT the Anthropic path constraints (Rules 1+2 in `04-anthropic-path-constraints.md`). Those are non-negotiable architectural floors. This catalog is the OPTIMIZATION layer that sits on top.
- NOT the cost-routing policy (Phase 5c). That layer reads quota state and routes; this catalog tells THAT layer which models are equivalent on capability.
- NOT a benchmark leaderboard. Numbers cited below are research-grade — single-analyst observations or third-party leaderboard relays. Confidence markers are explicit per entry.

## How to read confidence

- **HIGH** — multi-source corroboration, recent empirical verification, or directly from vendor API/docs.
- **MEDIUM** — one strong source (third-party benchmark, vendor model card) or two weak sources agreeing.
- **LOW (single-analyst)** — single transcript or single anecdote. Useful directional signal, NOT load-bearing for routing rules without verification.
- **PROVISIONAL** — based on indirect signal or our own probing during Phase 4; treat as known-fragile.

Every claim ends with `[source-id confidence:LEVEL]`. Sources are video IDs from `research/synthesis-nate-b-jones.md` or other research files.

## Task type taxonomy

We assess models on these axes. The selection layer maps incoming task descriptions to these tags.

- `code-generation` — write new code from spec
- `code-review` — critique existing code, find bugs, suggest improvements
- `code-maintenance` — fix bugs in existing codebases without regressing prior features
- `agentic-execution` — multi-step autonomous loops with tools (the durable agent pattern)
- `web-research` — open-ended browsing, comparing sources, synthesizing
- `structured-extraction` — parse free text into JSON or schema-shaped output
- `classification` — categorical/intent decisions
- `long-context-reasoning` — pull threads through 100k+ token contexts
- `vision` — image/screen understanding
- `creative-writing` — narrative, marketing copy, ideation
- `math-and-spatial` — quantitative reasoning, geometry, 3D visualization
- `instruction-following` — precise compliance with prompt requirements
- `tone-and-judgment` — empathy, hedging, assertiveness calibration

---

## Anthropic models

### Claude Opus 4.7

**Provider.** Anthropic.

**Best fit.**
- `code-generation`: Highest published SWE-bench score in this catalog — 87% verified `[tJB_8mfRgCo confidence:MEDIUM]`.
- `code-review` / critique: Tone is 77% assertive, 16% hedging per Code Rabbit measurement `[tJB_8mfRgCo confidence:LOW]` — useful when you want pushback, not deference.
- `agentic-execution`: Long-horizon work where the model has to push through ambiguity. Vendor validations: Hex finance evals 0.76→0.81; Harvey Big Law 90.19%; Databricks Office QA Pro 21% fewer errors `[tJB_8mfRgCo confidence:LOW (vendor-claimed)]`.

**Avoid for.**
- `web-research`: REGRESSED from 4.6 — BrowseComp 79 vs 4.6's 83 `[tJB_8mfRgCo confidence:MEDIUM]`. Route web research to 4.6 or to GPT-5.4 Pro.
- `vision`-heavy tasks: 4.6 was already weak; 4.7 hasn't been profiled as improved here.
- Tasks needing parameter control: temperature, top_p, top_k, thinking_budget all return 400 on 4.7 `[tJB_8mfRgCo confidence:MEDIUM]`. The model auto-controls adaptive thinking. If a workflow depends on those knobs, fall back to 4.6.
- Long unattended sessions on a tight budget: tokenizer tax is 1.29-1.47x more tokens than 4.6 for the same input `[tJB_8mfRgCo confidence:LOW]` — effective $/M-token is materially higher than headline price.

**Notes.**
- Effort levels above "high" only exposed in Claude Code, not API `[tJB_8mfRgCo confidence:LOW]`. The framework matters: same model, different ceiling, depending on dispatch path. See `09-framework-fitness-catalog.md#claude-code`.
- $42 burn in a single Claude Design session reported `[tJB_8mfRgCo confidence:LOW (anecdote)]`. Treat 4.7 as the model most likely to surprise on bill.

**Confidence overall.** MEDIUM. Most numbers are single-source from a single Nate B Jones video relaying third-party benchmarks. Need verification against live SWE-bench, GDPVal-A, BrowseComp leaderboards.

---

### Claude Sonnet 4.6 / Claude 4.6 family

**Provider.** Anthropic.

**Best fit.**
- `web-research`: BrowseComp 83 — better than 4.7's 79 `[tJB_8mfRgCo confidence:MEDIUM]`. Keep 4.6 in the routing table for any task that needs to crawl the open web.
- General-purpose fallback when 4.7's parameter restrictions are blocking.

**Avoid for.**
- Tasks where the assertive tone of 4.7 is needed.

**Confidence overall.** MEDIUM. Same source caveats as 4.7.

---

### Claude Sonnet 4.7

**Provider.** Anthropic.

**Best fit.**
- Cheaper variant of 4.7 — likely strong on the same coding tasks at lower cost.

**Avoid for.**
- Same constraints as Opus 4.7 (tokenizer tax, removed parameters, browse regression).

**Confidence overall.** LOW. Not separately profiled in research; inheriting Opus 4.7 caveats by family association needs verification.

---

### Claude Haiku (4.5 / 4.x)

**Best fit.**
- Cheap classification and routing decisions per CLAUDE.md's "Intelligence Over String Matching" rule.

**Confidence overall.** PROVISIONAL. Not covered in Nate B Jones research. Catalog entry to be populated from Anthropic model card + our own empirical observations from Instar's existing IntelligenceProvider usage.

---

### Claude Mythos (Pentagon-line)

**Provider.** Anthropic.

**Best fit.**
- Security-domain work: `hV5_XSEBZNg` reports zero-days found in Ghost CMS `[confidence:LOW (single-analyst)]`.
- Outcome-only specs — explicit guidance from the source: "let go of your prompt scaffolding" `[hV5_XSEBZNg confidence:LOW]`.

**Constraints.**
- Max plan required for distribution `[hV5_XSEBZNg confidence:LOW]`.
- Carved out for defense use under specific policy red lines `[0vdlwOK_Qdk confidence:LOW]`. Use cases governed by Anthropic policy, not just technical capability.

**Confidence overall.** LOW. Highly specialized model, niche fit.

---

## OpenAI models

### GPT-5.5 ("Spud")

**Provider.** OpenAI.

**Best fit.**
- `agentic-execution` involving complex one-shot specs: Dingo test 87.3 vs Claude 67.0 vs Gemini 65.0 `[9aIYhjeYxzM confidence:LOW]`.
- `code-maintenance` involving data-migration shape: Splash Brothers migration completed where peers stalled `[9aIYhjeYxzM confidence:LOW]`.
- `math-and-spatial`: Artemis 2 3D visualization handled where others failed `[9aIYhjeYxzM confidence:LOW]`.

**Operational advantage.**
- Reliability: OpenAI ~three nines vs Anthropic ~one-to-two nines over 90 days `[9aIYhjeYxzM confidence:LOW (speaker estimate, not provider SLA)]`. For long-running agent loops that retry on 5xx, this can offset apparent quality gaps elsewhere.

**Confidence overall.** LOW. Single source, single set of evals. Needs corroboration.

---

### GPT-5.4 / GPT-5.4 Pro

**Provider.** OpenAI.

**Best fit.**
- `code-generation` involving terminal-mediated work: Terminal Bench 2.0 score 75, leading Opus 4.7's 69 `[tJB_8mfRgCo confidence:MEDIUM]`.
- `web-research` at the top: BrowseComp 89 `[tJB_8mfRgCo confidence:MEDIUM]`.
- `agentic-execution` second-tier — GDPVal-A 1674, behind Opus 4.7's 1753 `[tJB_8mfRgCo confidence:MEDIUM]`.

**Confidence overall.** MEDIUM.

---

### GPT-5.3 / GPT-5.3-codex

**Provider.** OpenAI.

**Best fit.**
- `code-generation` via Codex CLI on ChatGPT subscription auth — `gpt-5.3-codex` accessible where `gpt-5.3` plain is rejected with "not supported when using Codex with a ChatGPT account" `[Phase 4 probe 2026-05-15 confidence:HIGH (direct empirical)]`.
- Default "balanced" tier in our Codex adapter's tier-to-model map.

**Confidence overall.** MEDIUM for fitness, HIGH for availability on subscription auth.

---

### GPT-5.2

**Provider.** OpenAI.

**Best fit.**
- Cheapest working model on ChatGPT-subscription auth path `[Phase 4 probe 2026-05-15 confidence:HIGH]`.
- Default "fast" tier in our Codex adapter.

**Confidence overall.** MEDIUM. Fitness signal is sparse; treat as low-cost adequate-quality option.

---

## Google models

### Gemini 3.1 Pro / Ultra

**Provider.** Google.

**Best fit.**
- `web-research` middle-tier: BrowseComp 85 — between Opus 4.7 (79) and GPT-5.4 Pro (89) `[tJB_8mfRgCo confidence:MEDIUM]`.

**Avoid for.**
- `agentic-execution`: GDPVal-A 1314 — meaningfully behind the leaders' 1753/1674 `[tJB_8mfRgCo confidence:MEDIUM]`.

**Confidence overall.** MEDIUM. Available via Google but not yet plugged into our adapter substrate — Phase 6 work.

---

## Open-source / open-weight frontier models

The Chinese open-source frontier (DeepSeek, Qwen, Kimi) shipped major releases in April 2026. Nate B Jones's transcripts (last 250 videos) have ZERO coverage of these families — his beat is the Western frontier. Entries below are sourced from official model cards, HuggingFace, third-party benchmark sites (LiveCodeBench, Codeforces, SWE-bench), and recent analyses from buildfastwithai, miraflow, the-decoder, Verdent. Each entry's confidence is MEDIUM (third-party benchmark, no first-hand empirical from Instar yet) — meaningfully better than the LOW single-analyst Nate B Jones signal, but still requires Phase 5d empirical verification before load-bearing routing decisions.

### DeepSeek V4 (V4-Pro, V4-Flash, V4-Pro-Max)

**Provider.** DeepSeek (Chinese). Released 2026-04-24. MIT license. Available via DeepSeek API, HuggingFace, OpenRouter, vLLM, Ollama.

**Architecture.** V4-Pro: 1.6T-parameter MoE with 49B active. V4-Flash: 284B MoE with 13B active. 1M-token context window. V4-Pro-Max is the "max effort" variant.

**Best fit.**
- `code-generation` at the frontier: LiveCodeBench Pass@1 of 93.5 — HIGHEST among all models in this catalog `[BenchLM 2026-04 confidence:MEDIUM]`. Codeforces rating 3206 ahead of GPT-5.4 xHigh (3168) and Gemini 3.1 Pro (3052) `[BenchLM confidence:MEDIUM]`.
- `agentic-execution` involving code: SWE-bench Verified 80.6% — trails Claude Opus 4.6 by only 0.2 points `[BenchLM confidence:MEDIUM]`. Terminal-Bench 2.0 67.9% vs Claude 65.4% `[buildfastwithai confidence:MEDIUM]`.
- Direct Claude Code / OpenCode integration: "DeepSeek-V4 is seamlessly integrated with leading AI agents like Claude Code, OpenClaw & OpenCode" `[buildfastwithai confidence:MEDIUM]`.
- Cost-sensitive workloads at frontier-adjacent quality: V4-Flash $0.14/M input + $0.28/M output, undercutting GPT-5.4 Nano, Gemini 3.1 Flash, GPT-5.4 Mini, and Claude Haiku 4.5 `[Morph confidence:MEDIUM]`.

**Avoid for.**
- Pure reasoning at the absolute frontier: HLE 37.7% trails Claude's 40.0% `[BenchLM confidence:MEDIUM]`.
- Pure math: HMMT 2026 95.2% trails Claude's 96.2% `[BenchLM confidence:MEDIUM]`.
- Mission-critical work where 3-6 month state-of-the-art lag matters: "developmental trajectory that trails state-of-the-art frontier models by approximately 3 to 6 months" `[TechCrunch 2026-04-24 confidence:MEDIUM]`.

**Operational notes.**
- 1M context is the largest in our catalog — strong for repository-scale code work.
- NIST published a CAISI evaluation `[NIST 2026-05 confidence:HIGH]` — first government-grade benchmark of a Chinese open-source frontier model. Result not summarized in my searches; worth fetching for the full picture before any production routing rule depends on V4.

**Confidence overall.** MEDIUM.

---

### Qwen 3.6 family (Qwen3.6-27B, Qwen3.6-Plus, Qwen3.6-Max-Preview, Qwen3-Coder-Next)

**Provider.** Alibaba Cloud / Qwen team. April 2026 releases. Available via HuggingFace, Ollama, Alibaba Cloud, OpenRouter, vLLM. Apache-2.0 weights for the open variants.

**Architecture variants.**
- Qwen3.6-27B: dense 27B parameter multimodal.
- Qwen3.6-Plus: 1M context preview.
- Qwen3.6-Max-Preview (April 20): the flagship; 260K context.
- Qwen3-Coder-Next (April 8): 3B active params; smallest viable agentic coder.

**Best fit.**
- `code-generation` on local hardware: Qwen3.6-27B at 27B params outperforms its own predecessor Qwen3.5-397B-A17B on every major coding benchmark — SWE-bench Verified 77.2 vs 76.2, SWE-bench Pro 53.5 vs 50.9, Terminal-Bench 2.0 59.3 vs 52.5 `[Qwen blog 2026 confidence:MEDIUM]`. Within 3.7 points of Claude Opus 4.6 on SWE-bench Verified `[buildfastwithai 2026 confidence:MEDIUM]`.
- `agentic-execution` with extreme parameter efficiency: Qwen3-Coder-Next achieves >70% on SWE-Bench Verified with the SWE-Agent scaffold using only 3B active params; matches "10-20x larger" models on SWE-Bench Pro `[Qwen blog confidence:MEDIUM]`.
- `code-generation` at the absolute frontier: Qwen3.6-Max-Preview claims #1 on six major coding benchmarks (SWE-bench Pro, SkillsBench, SciCode, others) as of April 20 release `[buildfastwithai 2026 confidence:MEDIUM]`.
- The Apache-2.0 open path that matters: Qwen3.6-27B at 27B params runs reasonably on a single high-end consumer GPU — only frontier-tier model in this catalog with that property.

**Avoid for.**
- Workflows that need verified vendor-grade reliability — Qwen's hosted API is Alibaba Cloud-based with different uptime characteristics than the Western frontier providers. Self-hosting via Ollama/vLLM is the more predictable path.

**Operational notes.**
- Terminal-Bench 2.0 at 59.3 on the 27B variant "matches Claude 4.5 Opus exactly" — the stat driving the most community excitement `[buildfastwithai confidence:MEDIUM]`.
- Available natively in Ollama under the `qwen3` namespace `[ollama.com/library/qwen3 confidence:HIGH]`.

**Confidence overall.** MEDIUM. Numbers are from Alibaba's own benchmark publishing — cross-verify before load-bearing routing.

---

### Kimi K2.6 (and K2.5)

**Provider.** Moonshot AI (Beijing). K2.6 released 2026-04-20. Modified MIT license, open-weight. Available via Moonshot API, HuggingFace, OpenRouter.

**Architecture.** 1-trillion-parameter Mixture-of-Experts, 32B active per token. 262,144 token context. Ships natively in INT4 quantization.

**Best fit.**
- `agentic-execution` at the absolute frontier: SWE-Bench Pro 58.6 — TIES or BEATS GPT-5.5 `[miraflow 2026-04 confidence:MEDIUM]`. Leads GPT-5.4 (52.1), Claude Opus 4.6 (53.0), Gemini 3.1 Pro (51.4) on the same benchmark `[Verdent confidence:MEDIUM]`.
- `web-research`: BrowseComp 83.2 `[buildfastwithai confidence:MEDIUM]` — between Claude 4.6 (83) and GPT-5.4 Pro (89).
- `tool-use` heavy work: Humanity's Last Exam WITH TOOLS 54.0 — open-source SOTA `[miraflow confidence:MEDIUM]`. Leads ALL models in that benchmark (open or closed).
- Cost-sensitive agentic loops: ~80% cheaper per million tokens than the Western frontier `[Medium / Ewan Mak 2026-04 confidence:MEDIUM]`.
- Long-context coding: 262K window covers most non-monorepo projects in a single prompt.

**Avoid for.**
- Pure competition math: AIME 2026 96.4% trails GPT-5.4's 99.2% `[buildfastwithai confidence:MEDIUM]`.
- `long-context-reasoning` requiring 1M+ tokens: trails DeepSeek V4 (1M) and Qwen3.6-Plus (1M) on context.
- GPQA-Diamond pure-reasoning ceilings: 90.5% vs GPT-5.4's 92.8% `[buildfastwithai confidence:MEDIUM]`.

**Operational notes.**
- "Open-source just beat GPT-5.5 at coding" framing from multiple analyses `[buildfastwithai title confidence:MEDIUM]` — read as marketing-tinged but with real benchmark backing.
- Leads on 5 of 8 major agentic and coding benchmarks while remaining the only open-weight model in the comparison `[Verdent confidence:MEDIUM]`.
- INT4 native quantization makes self-hosting on consumer GPU clusters meaningfully more accessible than its 1T parameter count suggests.

**Confidence overall.** MEDIUM.

---

### Gemma 4

**Provider.** Google (open-source, Apache 2.0).

**Best fit.**
- Air-gapped or licensing-strict deployments — one of several Apache-2.0 options that survive without provider lock `[85Q9htV2CBE confidence:LOW (availability noted, no fitness numbers in research)]`.

**Confidence overall.** PROVISIONAL. Need empirical numbers. Per the Chinese open-source landscape above, Qwen 3.6 likely dominates Gemma 4 on most task types at similar parameter counts — verify before routing to Gemma over Qwen.

---

### Cross-cutting: the Chinese open-source frontier story

The April 2026 release cluster (DeepSeek V4 on the 24th, Qwen3.6-Max-Preview on the 20th, Kimi K2.6 on the 20th) collectively closed the gap with the Western frontier on coding and agentic benchmarks. Three observations relevant to Instar's routing layer:

1. **The frontier is no longer Western-only.** For pure coding, DeepSeek V4-Pro-Max leads on LiveCodeBench. For agentic tool-use, Kimi K2.6 leads on HLE-with-Tools and SWE-Bench Pro. For parameter-efficient self-hosting, Qwen 3.6 dominates. The catalog's "capable" tier needs entries from all three families.

2. **The cost cliff is real.** All three are 70-80%+ cheaper than the Western frontier at comparable benchmark scores. For volume routing decisions, this changes the math meaningfully. Phase 5c cost-routing should incorporate.

3. **Self-hosting is now a serious option.** Qwen3.6-27B at 27B params + Apache-2.0 + competitive coding scores means Instar's "local-model" Phase 6 work has real candidates — not theoretical ones. The benchmark framework (Phase 5d) should profile Qwen 3.6 on Justin's M-class hardware before Phase 6 builds.

These three families are NOT covered by Nate B Jones's analysis — his Western-frontier focus has this as an explicit blind spot. The catalog records this gap honestly: future research passes should source from non-Western analysts (e.g., the AkitaOnRails LLM coding benchmark series, NIST's CAISI evaluations, the Artificial Analysis leaderboard) to keep coverage balanced.

---

## Cross-model routing heuristics

These are the routing intuitions that emerge from the per-model assessments. The selection layer (Phase 5b) implements them; the benchmark layer (Phase 5d) validates them.

1. **Coding default → Opus 4.7** when Anthropic subscription quota allows; **Sonnet 4.7** for the same task type at lower cost; **GPT-5.4** when terminal/CLI work dominates; **DeepSeek V4-Pro** when LiveCodeBench-shape problems dominate (leads at 93.5).
2. **Code at scale on a budget → Kimi K2.6** (SWE-Bench Pro leader at ~80% lower cost than the Western frontier) OR **DeepSeek V4-Flash** ($0.14/$0.28 per M tokens).
3. **Web research default → GPT-5.4 Pro** when subscription-available, **Claude 4.6** as Anthropic-path fallback (NOT 4.7), **Gemini 3.1 Pro** as third option; **Kimi K2.6** is competitive at 83.2 BrowseComp.
4. **Long-running autonomous loops → GPT-5.5 / 5.4** for reliability advantage on retries, UNLESS the task hits a capability Anthropic-only path (e.g., a tool surface Codex doesn't have).
5. **Tool-heavy agentic loops → Kimi K2.6** — HLE-with-Tools leader at 54.0, open-source SOTA; routing-policy candidate when the task description names explicit tool sequences.
6. **Classification / routing decisions → Haiku-class** (still PROVISIONAL until fitness numbers verified).
7. **Security / defense-domain work → Mythos** (with Max-plan constraint).
8. **Self-hosted / air-gapped path → Qwen3.6-27B** (27B params + Apache-2.0 + Terminal-Bench 59.3 matching Claude 4.5 Opus). **Gemma 4** demoted to last-resort until empirical numbers prove it.
9. **Long-context (>262K tokens) → DeepSeek V4 (1M) or Qwen3.6-Plus (1M)** — both lead the catalog on context window.
10. **Pure math at the frontier → GPT-5.4** (AIME 99.2%) — the only category where the Western frontier still leads the Chinese open-source frontier cleanly.

---

## Update discipline

Per Rule 3 in `05-state-detection-robustness.md`: this catalog drifts every time a provider ships a new model or retires an old one. Discipline:

- Every new model entry ships in the same PR as the routing-rule change that consumes it.
- Vendor-claimed evals are tagged `confidence:LOW (vendor-claimed)` until cross-verified.
- The benchmark framework (Phase 5d) re-runs canonical task probes against every model in the catalog on a scheduled cadence and updates last-verified timestamps.
- Quarterly audit sweep: anything `confidence:LOW (single-analyst)` for >90 days is either upgraded with corroboration or downgraded to PROVISIONAL.

---

## Research sources

- **`research/synthesis-nate-b-jones.md`** — 25 transcripts pulled 2026-05-15. Source for Anthropic and OpenAI Western-frontier entries. Confidence LOW (single-analyst).
- **Web research 2026-05-15** — official model cards (HuggingFace), vendor blogs (Qwen, DeepSeek API docs), third-party analyses (buildfastwithai, miraflow, the-decoder, Verdent, AkitaOnRails, BenchLM, Morph, llm-stats). Source for the Chinese open-source frontier entries (DeepSeek V4, Qwen 3.6, Kimi K2.6). Confidence MEDIUM (multi-source third-party but no first-hand empirical from Instar yet).
- **Phase 4 empirical probes** — direct observations from building the Codex adapter. Source for the OpenAI model-availability and CLI-behavior notes. Confidence HIGH.

Next research passes will add:
- Official Anthropic model cards (Opus 4.7, Sonnet 4.6/4.7, Haiku 4.x)
- OpenAI release notes for GPT-5.x line
- Third-party verified leaderboards (live values — re-pull SWE-bench, GDPVal-A, BrowseComp, Terminal Bench, LiveCodeBench, Codeforces)
- NIST CAISI evaluation of DeepSeek V4 Pro (referenced but not fetched yet)
- Artificial Analysis leaderboard (referenced as the canonical third-party board)
- Our own empirical probes from Phase 5d benchmarking — especially Qwen 3.6 on Justin's M-class hardware for Phase 6 self-hosting decisions

The catalog graduates from `v0.1` to `v0.2` when at least three entries have been upgraded from `LOW`/`MEDIUM` to `HIGH` confidence via empirical verification.
