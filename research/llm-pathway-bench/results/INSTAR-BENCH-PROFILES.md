# INSTAR-Bench v1 — Model Profiles & Routing Table

**Run:** 2026-07-01 · 26 model-routes × 23 tasks × 3 samples = 1,794 calls · **total cost $2.91** ($2.64 OpenRouter + $0.27 Groq free-tier), every call through the budget funnel.
**Judge:** Echo running `claude-fable-5`, in-session, blind (model identity stripped + shuffled).
**Data:** `results/instar-bench/r8-final/` (summary.json, judge-scores.json, combined.json, raw merged from r8/r8b/r8c/r8d/r8e).

---

## The headline

**The routing axis is TASK NATURE, not token count.** For *simple, high-volume, bounded* decisions (classify a message, emit a JSON verdict, apply a format rule), speed + terseness + cost dominate, and **the frontier chat models (Opus 4.8, GPT-5.4/5.4-mini, Sonnet-5) plus Gemini 3.1 Flash-Lite** win decisively. For those tasks, a reasoning model's extra "thinking" is pure overhead — it clips or throttles exactly when you need a fast one-line answer.

**But that is NOT a blanket verdict against reasoning models** (operator correction, 2026-07-01, and it's right). Where a decision requires **nuanced judgment under ambiguity**, or is **high-stakes/critical** (a coherence call that could block real work, a security/safety gate, an irreversible-action classification), the extra reasoning is a *feature worth paying for* — being right matters more than being fast or cheap. The token cost is the wrong thing to optimize there.

**Benchmark limitation this exposes:** v1's judged tasks are mostly *objective* (a clear planted bug, a known ordering mistake) — they reward getting a definite answer concisely and therefore *under-measure* the nuanced/critical cases where reasoning depth changes the answer. So v1's low scores for reasoning models mean "overkill for the simple bounded tasks I tested," NOT "worse at hard judgment." That's a v2 gap: add genuinely ambiguous, high-stakes judgment tasks where the *right* answer is contested — and let reasoning models spend the tokens.

## Two scored axes
- **Deterministic (17 tasks)**: sentinel/gate/extractor — scored mechanically vs known-correct answers (0/1 + a format-chatter penalty). Measures "can it produce the exact structured verdict."
- **Judged (6 tasks)**: agent debug/plan/standards + background digest/classify/code-summary — I scored blind, 1-10, on a per-task rubric. Reported as **quality-when-delivered** and **completion %** (how often it produced usable output within a bounded budget) so the truncation artifact doesn't distort the quality ranking.

---

## Leaderboard (curated 15 — the models worth routing to)

| Model | Tier | Det | Judge qual | Completion | p50 latency | median out-tok | rel. cost | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Claude Opus 4.8** | large | 1.00 | 9.8 | 100% | 2.2s | 13 | high | Quality ceiling; terse. The hardest agent work. |
| **GPT-5.4** | mid | 1.00 | 9.8 | 100% | **1.2s** | 11 | med | **Best top-tier value** — near-Opus quality, 2× faster, ¼ cost. |
| **GPT-5.4-mini** | small | 1.00 | 9.7 | 100% | **1.2s** | 11 | **low** | **The workhorse** — near-top quality at small-tier price/speed. |
| **Claude Sonnet-5** | mid | 1.00 | 9.3 | 100% | 3.1s | 13 | med | Solid all-rounder; terse. |
| **Qwen3.7-Max** | large | 1.00 | 9.3 | 100% | 10.3s | 462 | high | Capable but **too slow/verbose** for interactive/bounded work. |
| **Gemini 3.1 Flash-Lite** | small | 1.00 | 8.8 | 100% | **1.18s** | 6 | **cheapest** | **Sentinel/gate champion** — fastest, cheapest, perfect structured output. |
| **GPT-5.5** | large | 1.00 | 9.8 | 83% | 2.3s | 42 | highest | Top quality but pricier + budget-hungry; reserve for the hardest. |
| **DeepSeek V4 Pro** | large | 0.98 | 9.2 | 83% | 3.9s | 100 | very low | Strong quality at rock-bottom cost; slightly budget-hungry. |
| **Claude Haiku 4.5** | small | 0.99 | 7.3 | 100% | 1.5s | 13 | low | Great for classification; weaker on deep judgment/summary. |
| **Llama-4-Scout** (OR/Groq) | small | 0.93 | 6.1 | 100% | 1.0s | 8 | ~free | Fast open-weight; mid quality. Door-parity confirmed (OR 6.2 ≈ Groq 6.0). |
| GLM-5.2 | large | 0.92 | 10.0* | **17%** | 3.9s | 195 | low | *Excellent WHEN it fits — but clips 83% of bounded tasks. Not for gates. |
| Kimi K2.6 | large | 0.97 | 9.5* | **33%** | 4.3s | 184 | low | Same trap — high quality, low completion. |
| Gemini 3.1 Pro | large | 0.97 | 3.3 | 100% | 5.0s | 317 | highest | Tops public leaderboards; **weak on our bounded tasks** (reasons past the budget). |
| Gemini 3.5 Flash | mid | 1.00 | 4.0 | 100% | 3.0s | 330 | high | Perfect at short structured output; weak at open-ended bounded judgment. |

\* quality-when-delivered over a small sample — unreliable because completion is low.

---

## The INSTAR routing table (job → model → door)

Policy: **subscription-first** (Claude via Claude Code, GPT via codex) per the spend-safety standard; the metered funnel is the enterprise/redundancy lane; Groq is a free open-weight speed door (rate-limited).

| instar job | primary | efficient default | door | avoid |
|---|---|---|---|---|
| **Sentinels** (message classify, emergency-stop, commitment) | Gemini 3.1 Flash-Lite | GPT-5.4-mini / Haiku / **gpt-oss-20b (free via Groq)** | metered (Gemini) or subscription (Haiku via CC) or **free (Groq, paced)** | reasoning models (clip verdicts) |
| **Gates** (tone, coherence, external-op, self-stop) | GPT-5.4-mini | Gemini Flash-Lite | subscription (codex) / metered | GLM, Kimi, Gemini-3.x-Pro |
| **Extractors** (strict JSON, intent, relationship) | GPT-5.4-mini | Gemini Flash-Lite / Haiku | subscription / metered | verbose reasoners (wrap/truncate JSON) |
| **Agent** (interactive debug, planning, standards) | Opus 4.8 / GPT-5.4 | GPT-5.4-mini | subscription (CC / codex) | small open-weight |
| **Background** (digests, batch classify, code-summary) | GPT-5.4-mini | Gemini Flash-Lite / DeepSeek V4 Pro | metered (volume → cost matters) | Gemini-3.x-Pro (cost + budget) |
| **Nuanced / critical judgment** (ambiguous coherence call, safety gate, irreversible-action classification, anything where being RIGHT beats being fast/cheap) | **a reasoning model earns its tokens here** — Opus 4.8 (extended thinking) / GPT-5.5 / GLM-5.2 / Kimi (with adequate output budget) | Opus 4.8 | subscription / metered | forcing a tight token budget that clips the reasoning |
| **Deep unbounded reasoning** (rare) | GLM-5.2 / Kimi / Gemini-Pro | — | metered | using them where output is bounded AND the task is simple |

**Takeaway (nuanced, per operator):** route by task NATURE. *Simple + high-volume + bounded* → **GPT-5.4-mini / Gemini 3.1 Flash-Lite** (fast, terse, cheap, perfect structured output). *Hard interactive agent work* → **Opus 4.8 / GPT-5.4**. *Nuanced or critical judgment* → let a **reasoning model spend the tokens** — that's where the extra thinking is worth it, and where a tight budget is the wrong economy. The only real anti-pattern is routing a *simple* bounded verdict to a reasoning model (overkill + clipping), OR starving a *critical* judgment of the reasoning budget it needs.

---

## Deep-research cross-check

| Our finding | Public standing | Agreement |
|---|---|---|
| Opus 4.8 + GPT-5.4/5.5 top the quality tier | Lead agentic/SWE benchmarks | ✅ confirms |
| Gemini 3.1 Flash-Lite: fast + capable at small tier | Positioned as the cheap/fast tier | ✅ confirms |
| GPT-5.4-mini ≈ top quality at small price | Under-discussed publicly | 🔵 our finding (strong value) |
| Gemini 3.x Pro **weak on our bounded tasks** | Ranks high on LMArena/reasoning | ⚠️ divergence — **explained**: public benches reward max-reasoning with unbounded output; instar rewards bounded, terse, format-obedient output. Different objective, not a contradiction. |
| Groq door-parity (same model, ~same quality, faster) | Groq markets speed, not quality | ✅ confirms (speed door for open-weight) |

**The divergence is the value of a personal benchmark:** a model can top the leaderboards and still be wrong for instar, because our jobs are bounded and structured, not open-ended reasoning showcases.

---

## Methodology honesty (two artifacts caught mid-run)

1. **Truncation-as-failure.** First pass scored reasoning models ~0 — raw outputs showed the *correct* answer clipped mid-JSON. Reasoning models spend output budget "thinking" before answering. Fixed with a `--maxtok-floor`; verified Gemini-3.5-Flash 0.00→1.00, GLM-5-turbo 0.00→0.95. **Kept as a first-class finding**: bounded-output tasks expose this, leaderboards hide it.
2. **Groq free-tier 429s.** 287 Groq failures were all HTTP 429 (rate-limit), not model failure — re-run serially with pacing. **Correction after the paced re-run:** with the RPM limit respected, Groq's gpt-oss models are strong + fast for structured work — `gpt-oss-20b` det **1.00** @ 842ms, `gpt-oss-120b` det **0.98** @ 770ms, both **free**. A genuinely useful free lane for high-volume bounded tasks (sentinels/gates/extractors). Only Qwen-on-Groq stays weak (`qwen3-32b` 0.49, `qwen36-27b` 0.06) — genuine reasoning-burn, not throttling.

Both were caught by checking raw outputs before trusting a bad-looking number. Judge zeros on long-output tasks (agent-plan needs ~400 tokens *after* reasoning) are still partly this artifact — hence the separate **completion %** axis rather than folding them into the quality score.

## What v1 does NOT yet cover (v2 candidates)
- **Subscription-door latency parity** (Claude CLI / codex / pi / gemini-CLI vs metered) — Phase-1 + R7 have this separately; not yet folded in here.
- **Redundant-door depth**: pi via multiple subscriptions, GPT-5.5 ×3 doors — designed, not run.
- **Judge self-consistency probes** and multi-sample judged scoring (v1 scored 1 representative sample/cell to stay right-sized).
