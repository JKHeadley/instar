# Subscription vs API Access — Comparison Report (LLM Pathway project, topic 29723)

**Date:** 2026-07-01 · **Author:** Echo · **Status:** COMPLETE (6/6 research threads integrated, all cited).

## North star
Find the optimal **(access-path × model)** pairing for each instar use case, where the dominant lever is **cost**. Central hypothesis: does a **subscription subsidize model access below pay-per-token API rates**, AND is it **legally usable as an automated agent backend**? A subsidy we can't legally tap does not count. Real-life **rate-limit ceilings** and **latency per path** must be measured live (this report scopes that benchmark).

---

## The one-paragraph answer
Subscriptions are subsidized in exactly **two** places — **Anthropic (Claude Code on Max, ~15–20× vs API)** and **OpenAI (Codex-on-subscription, breakeven ~8–10 sessions/mo)** — and **both are ToS-fenced against automated/agent backends** (Anthropic banned + technically enforces it since 2026-04-05; OpenAI tolerates personal use only, steers automation to API keys, and forbids account pooling). **Everyone else is metered at ~list price with no subsidy:** GitHub Copilot's flat-rate subsidy **collapsed on 2026-06-01** (now token-billed at API rates), and aggregators/cloud (OpenRouter, AWS Bedrock, Azure) are pass-through or +markup. The only way to go materially *below* frontier API price is to drop to **open-weight models on fast-inference hosts (Groq/DeepInfra, ~$0.02–0.05/1M)** — which don't host the proprietary frontier models. So: the subsidy is real but interactive-only; a compliant always-on agent runs on **metered APIs**, tiered by model, with open-weight fast hosts for the cheap high-frequency work.

---

## Master comparison matrix

| Platform / route | Subscription option | Metered price (key models, $/1M in/out) | **Subsidy verdict** | Programmatic + ToS for an always-on agent | Notes |
|---|---|---|---|---|---|
| **Anthropic** | Pro $20 / Max $100 / Max $200 (Claude Code bundled) | Opus 4.8 $5/$25 · Sonnet 5 $3/$15 (intro $2/$10) · Haiku 4.5 $1/$5 · Fable 5 $10/$50 | **YES — big (~15–20×)** via Claude Code on Max | **❌ Banned for agents** (enforced 2026-04-05); Agent SDK requires API key; sub OAuth expires ~8–12h. Compliant = **metered API** | API default = no training on your data; caching −90% cache-read, Batch −50% |
| **OpenAI** | Plus $20 / Pro $100 / Pro $200 (Codex bundled) | GPT-5.6 Luna $1/$6 · GPT-5.5 $5/$30 · GPT-5.4-mini $0.75/$4.50 · GPT-5.4-nano $0.20/$1.25 | **YES — real, but Codex-surface only**; undocumented endpoint | **⚠️ Grey** — `codex exec` works on sub OAuth (personal use tolerated), but OpenAI steers automation to API keys; **pooling prohibited**; hard 5h+weekly caps | Codex sub = de-facto subsidy for coding-shaped tasks; not a general chat API |
| **Google Gemini** | AI Plus $4.99 / Pro $19.99 / Ultra $99.99–199.99; Code Assist (IDE) | Dev API/Vertex: Gemini 3.5 Flash $1.50/$9 · 3.1 Flash-Lite $0.25/$1.50 · 2.5 Flash $0.30/$2.50 · 2.5 Flash-Lite $0.10/$0.40 | **NO** — sub = Gemini app + Antigravity + Jules on opaque "compute-used" quota; **no API entitlement, no per-token discount** | Consumer OAuth **removed from gemini CLI 2026-06-18** → Antigravity CLI (sub-tied, human-in-loop, **no embed interface**, proxy use ToS-risky + **bans reported**). Compliant programmatic = **paid API key or Vertex** | Free tier trains on your data + low limits — unfit for agents. Flash-Lite = cheap workhorse; Vertex = no-train, enterprise |
| **GitHub Copilot** | Free / Pro $10 / Pro+ $39 / Business $19 / Ent $39 | Token-billed at ~API list price (1 credit = $0.01); included credits ≈ your fee | **NO (collapsed 2026-06-01)** — was flat-rate, now metered at list price | **❌ Proxy use (pi→Copilot) = likely ToS violation + suspension risk.** Sanctioned = official Copilot CLI (interactive) or Azure | Only residual subsidy = free unlimited code *completions* (IDE only). Flagships gated to Pro+/Ent |
| **Microsoft Azure** | (none — metered) | Azure Foundry: GPT-5 $1.25/$10 · GPT-5.5 $5/$30 · Claude Opus 4.8 hosted at Anthropic rates | **NO** — pure metered, list price | **✅ Fully sanctioned** (IAM/keys, SLA, no-train). PTUs cut ≤70% at high sustained volume (~$2,448/mo floor) | Claude on Foundry needs Enterprise/MCA-E + manual quota enablement (starts at 0) |
| **AWS Bedrock** | (none — metered) | ≈ Anthropic list: Opus $5/$25 · Sonnet $3/$15 · Haiku $1/$5 (+10% cross-region) | **NO** — metered at parity | **✅ Cleanest ToS** (IAM/KMS, no-train, HIPAA/FedRAMP). Provisioned Throughput = reserved capacity | Hosts Claude/Llama/Mistral/Cohere/Titan — **not** GPT or Gemini |
| **OpenRouter** | (none — PAYG credits) | Provider list price + ~5–6% top-up fee (or BYOK: 5% surcharge after 1M free/mo) | **NO** — never cheaper than direct | **✅ Built for it** (OpenAI-compatible, zero-log default). Failover across providers is the killer feature | ~300–500 models, one key; extra hop ~20–50ms; single point of failure |
| **Fast-inference hosts** (Groq, DeepInfra, Together, Fireworks) | (none — PAYG) | **Open-weight only**: Groq Llama-8B $0.05/$0.08 @ 500–1000 tok/s · DeepInfra Llama-8B $0.02/$0.05 | **NO subsidy, but absolute cheapest + fastest** | **✅ Sanctioned API** | **No proprietary frontier models** (Claude/GPT/Gemini). Ideal for high-freq classification if open-weight quality suffices |

---

## What this means for instar (the compliance angle we must face)
instar today runs internal work on **subscription-backed CLIs** (Claude Code sessions, `codex exec`, `pi`). The research says:
- **Claude Code sessions** are the *sanctioned exception* — running the actual Claude Code CLI interactively/for-your-own-use is permitted. The risk zone is **headless `-p` / Agent-SDK calls billed to a consumer subscription**, and **account pooling** across many subscription homes (which instar's subscription-pool does) — that is exactly what Anthropic's 2026-04-05 enforcement and OpenAI's anti-pooling policy target.
- **Codex-on-subscription** for internal sentinels is a cost win but rides an undocumented, capped, personal-use-only endpoint — fragile + grey for a 24/7 fleet.
- **Copilot-via-pi** (the route we were about to explore) is now weak on **both** axes: no subsidy since June + real suspension risk. Recommend **experiment-only or drop**.

**Implication:** the cost-optimal *and* compliant posture is likely a **hybrid** — keep sanctioned interactive Claude Code where it applies; move high-frequency internal classification to **metered APIs tiered by model** (Haiku / GPT-5.4-mini / Gemini Flash-Lite) or **open-weight fast hosts (Groq/DeepInfra)** where quality allows; keep OpenRouter as a failover lane. The live benchmark decides the exact picks.

---

## Proposed live-benchmark scope (what this report unlocks)
Measure each candidate **path × model** on the same battery, with **rate-limit ceiling** and **latency-under-load** as first-class metrics (per Justin):
- **Latency:** p50/p95/p99 at concurrency 1, and under sustained concurrency (find the knee).
- **Rate-limit ceiling:** sustained requests/min before throttling/429 (the real subscription/API limit, learned live).
- **Cost:** measured $/call + fixed input-token overhead per path.
- **Quality parity:** on real sentinel/gate/extractor-shaped prompts.

**Candidate matrix to bench:**
- Cheap/fast frontier: Claude Haiku 4.5 (API), GPT-5.4-mini/nano (API), Gemini 3.1 Flash-Lite (API), GPT-5.6 Luna (when GA).
- Open-weight cheap/fast: a Llama/Qwen/DeepSeek class model on **Groq** and **DeepInfra**.
- Current internal routes (baseline): codex `exec`, pi (openai-codex), our Claude pool.
- Failover lane: OpenRouter (one representative model).
- Experiment-only (ToS-flagged): pi→Copilot Gemini (one run, clearly labeled).

## Compliance deep-dive — the sweet spot (added 2026-07-01, verified against primary/secondary sources)

**The load-bearing asymmetry:** Anthropic and OpenAI treat third-party subscription use *oppositely*.
- **Anthropic ACTIVELY BLOCKS** third-party agentic tools from subscription OAuth (enforced 2026-04-04; OpenClaw, OpenCode had tokens blocked; extending to all third-party harnesses). Rationale: third-party harnesses bypass Claude Code's prompt-cache optimizations = "outsized infra strain." **The first-party Claude Code CLI is the explicit exemption.**
  - ✅ **ALLOWED on a Claude subscription:** running the real Claude Code CLI — interactively AND headless (`claude -p`), scripts, cron, GitHub Actions, orchestrating/spawning Claude Code sessions locally. This is Anthropic's own documented use.
  - ❌ **PROHIBITED:** extracting the OAuth token to drive a third-party/reimplemented harness (the OpenClaw pattern); transferring subscription credentials between machines (SSH-forward / copy the creds file); pooling one subscription across a team without seats.
  - ⚠️ **Grey:** account-pooling to dodge rate limits. Holding multiple Max accounts is *not* itself a violation; using them as one pooled quota bucket to circumvent limits is what gets flagged.
  - 🕒 **In flux:** Anthropic PROPOSED (June 15 2026) moving Agent SDK + headless `claude -p` + GitHub Actions onto a separate API-priced credit pool, then **PAUSED** it. So headless-on-subscription is fine *now* but may be repriced later.
  - **instar's posture:** we drive the genuine Claude Code binary (sanctioned) and already re-mint logins per machine (no token transfer — compliant). The one edge to watch is the **subscription-pool** rotating across accounts to beat rate limits.
- **OpenAI TOLERATES** third-party subscription use. OpenClaw is an **independent** open-source project (Peter Steinberger et al.), **not built by OpenAI — but OpenAI sponsors it** and its Codex auth (Codex app-server) is embeddable. **No official OpenAI statement explicitly *permits* third-party subscription OAuth was found** (blog/marketing claims overstate this); OpenAI still recommends API keys for automation and prohibits account-pooling. But OpenAI has **not blocked** the pattern the way Anthropic has — so Codex-via-pi on your own subscription is materially *lower-risk than the Claude equivalent*, though not officially blessed.

**Note on pi-in-OpenClaw:** some OpenClaw marketing docs claim pi-SDK embedding; the GitHub README does not confirm it (OpenClaw has its own harness + a Codex harness). Not load-bearing — instar uses pi directly regardless.

## Two-tier product recommendation (Justin's framing, validated)
- **Solo / small team (e.g. Justin):** **ride the subsidies safely.** Claude → *only* via real Claude Code CLI. OpenAI/GPT → via pi/Codex on your *own* ChatGPT subscription (personal use). **Guardrails:** no account-pooling as a quota bucket, no cross-machine token transfer. This captures the two big subsidies at low (not zero) risk.
- **Enterprise:** **zero-ToS-risk only.** Metered first-party APIs (Anthropic API, OpenAI API, Gemini API/Vertex) or cloud (Bedrock/Azure) — no subscription OAuth, no pooling. Add **open-weight fast hosts (Groq/DeepInfra)** for cheap high-frequency classification. instar should expose a "compliance mode: enterprise" that hard-disables every subscription-OAuth path.

**Sources (compliance dive):** Anthropic-blocks-OpenClaw (dev.to/mcrolly), autonomee.ai Claude Code ToS, OpenClaw GitHub + docs, theagentgym/LumaDock Codex-OpenClaw tutorials, techtimes/digitalapplied June-15 pause coverage.

## Open decisions for Justin
1. **Compliance appetite:** do we treat the Anthropic/OpenAI subscription-automation ToS lines as hard constraints (→ move internal load to metered/open-weight) or accept the grey zone for now?
2. **Set up sanctioned metered keys** to benchmark the compliant paths (Anthropic API, OpenAI API, Gemini paid/Vertex, a Groq/DeepInfra key)?
3. **Copilot:** experiment-only or drop entirely given no-subsidy + ToS risk?

*(Sources: 6 cited research threads, 2026-07-01. Full citations in the per-thread outputs.)*
