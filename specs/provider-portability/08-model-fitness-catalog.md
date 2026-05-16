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

## Open-source / local models

### Gemma 4

**Provider.** Google (open-source, Apache 2.0).

**Best fit.**
- Air-gapped or licensing-strict deployments — the only model in this catalog that survives without provider lock `[85Q9htV2CBE confidence:LOW (availability noted, no fitness numbers in research)]`.

**Confidence overall.** PROVISIONAL. Need empirical numbers.

---

## Cross-model routing heuristics

These are the routing intuitions that emerge from the per-model assessments. The selection layer (Phase 5b) implements them; the benchmark layer (Phase 5d) validates them.

1. **Coding default → Opus 4.7** when subscription quota allows; **Sonnet 4.7** for the same task type at lower cost; **GPT-5.4** when terminal/CLI work dominates.
2. **Web research default → GPT-5.4 Pro** when subscription-available, **Claude 4.6** as Anthropic-path fallback (NOT 4.7), **Gemini 3.1 Pro** as third option.
3. **Long-running autonomous loops → GPT-5.5 / 5.4** for reliability advantage on retries, UNLESS the task hits a capability Anthropic-only path (e.g., a tool surface Codex doesn't have).
4. **Classification / routing decisions → Haiku-class** (still PROVISIONAL until fitness numbers verified).
5. **Security / defense-domain work → Mythos** (with Max-plan constraint).
6. **Local-model fallback → Gemma 4** until better numbers exist.

---

## Update discipline

Per Rule 3 in `05-state-detection-robustness.md`: this catalog drifts every time a provider ships a new model or retires an old one. Discipline:

- Every new model entry ships in the same PR as the routing-rule change that consumes it.
- Vendor-claimed evals are tagged `confidence:LOW (vendor-claimed)` until cross-verified.
- The benchmark framework (Phase 5d) re-runs canonical task probes against every model in the catalog on a scheduled cadence and updates last-verified timestamps.
- Quarterly audit sweep: anything `confidence:LOW (single-analyst)` for >90 days is either upgraded with corroboration or downgraded to PROVISIONAL.

---

## Research source

`research/synthesis-nate-b-jones.md` — synthesized from 25 transcripts pulled 2026-05-15. Cited by video ID throughout this catalog.

Next research passes will add:
- Official Anthropic model cards (Opus 4.7, Sonnet 4.6/4.7, Haiku 4.x)
- OpenAI release notes for GPT-5.x line
- Third-party verified leaderboards (live values for SWE-bench, GDPVal-A, BrowseComp, Terminal Bench)
- Our own empirical probes from Phase 5d benchmarking

The catalog graduates from `v0.1` to `v0.2` when at least three entries have been upgraded from `LOW` to `MEDIUM`/`HIGH` confidence.
