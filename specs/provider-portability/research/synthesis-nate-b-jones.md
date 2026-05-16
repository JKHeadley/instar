# Research Synthesis — Nate B Jones, March-May 2026

**Source:** 25 transcripts pulled 2026-05-15 from Nate B Jones's YouTube channel (last ~3 months). All raw files under `transcripts/<video-id>.txt`; map in `transcripts/video-list.txt`. Roughly 265,000 words of clean text.

**Method:** Subagent read all 25 transcripts end-to-end and extracted concrete model/framework claims with video-ID citations and short quoted excerpts.

**Treat as one analyst's signal.** Nate B Jones is a respected AI strategy commentator but his numbers are his own measurements (or repeated from third-party leaderboards), not vendor-published facts. Section 4 of this document explicitly enumerates the claims that need verification before being load-bearing in routing decisions. The fitness catalogs (`08-model-fitness-catalog.md`, `09-framework-fitness-catalog.md`) cite this synthesis with confidence markers per claim.

**Transcript-quality caveat.** Auto-captions have predictable mishearings: "Open Claw" = Open Code; "Co-Work" / "cocode" = Anthropic's desktop computer-use agent; "Conway" = leaked Anthropic enterprise product; "Claude Mythos" = the Pentagon-line Anthropic model; "Spud" = code-name for GPT-5.5; "Atlas/Chronicle" used for both OpenAI and Anthropic browser agents in different transcripts. The synthesis below uses the normalized names.

---

## 1. MODELS

### 1.1 Claude Opus 4.7

**Position.** Strongest single model evaluated on coding + long-horizon work; meaningful regressions on browse, vision, token economy, and parameter control.

| Dimension | Signal | Source |
|---|---|---|
| SWE-bench Verified | 87% (up from 80% on 4.6) | `tJB_8mfRgCo` |
| CursorBench | 70 (up from 58 on 4.6) | `tJB_8mfRgCo` |
| MCP Atlas | 77 (up from 75 on 4.6) | `tJB_8mfRgCo` |
| Terminal Bench 2.0 | 69 — second to GPT-5.4's 75 | `tJB_8mfRgCo` |
| GDPVal-A | 1753 — #1 | `tJB_8mfRgCo` |
| BrowseComp | 79 — REGRESSED from 4.6's 83 | `tJB_8mfRgCo` |
| Tokenizer tax | 1.29-1.47x more tokens than 4.6 for the same input | `tJB_8mfRgCo` (incl. Simon Willison's 1.46x on his own system prompt) |
| Control parameter removal | temperature, top_p, top_k, thinking_budget all return 400 | `tJB_8mfRgCo` |
| Effort levels | extra-high / max only exposed inside Claude Code | `tJB_8mfRgCo` |
| Tone | Code Rabbit measured 77% assertive, only 16% hedging | `tJB_8mfRgCo` |
| Cost at agent scale | "I burned $42 in a single Claude Design session" | `tJB_8mfRgCo` |

**Field validations (vendor-claimed).**
- Hex: "the strongest model they've ever evaluated… 0.76 to 0.81 on finance evals" `tJB_8mfRgCo`
- Harvey: "90.19% on Big Law bench" `tJB_8mfRgCo`
- Databricks: "21% fewer errors on Office QA Pro" `tJB_8mfRgCo`

**Fitness shape.** Best default for: coding, multi-step agent execution, code review/critique, finance/legal-style reasoning. Avoid for: open-web research at length, vision-heavy tasks where 4.6 was already weak, any path that needs temperature/budget control, long unattended sessions on a tight budget.

### 1.2 Claude Sonnet / Claude 4.6 family

- **4.6 is still the better browse model.** `tJB_8mfRgCo`: "4.7 regressed from 4.6 on BrowseComp" — keep 4.6 in the routing table for web-research jobs.
- Sonnet 4.7 not separately profiled; same tokenizer-tax and parameter-removal caveats apply.

### 1.3 Claude Mythos (Pentagon-line, "Capybara lineage")

- **Trained on GB300.** `hV5_XSEBZNg`: "Claude Mythos was trained on GB300 hardware". First Anthropic model in this lineage at that scale.
- **Demonstrated real security work.** `hV5_XSEBZNg`: "Mythos found zero-days in Ghost".
- **Distribution constraint.** `hV5_XSEBZNg`: "will require Max plan".
- **Outcome-only prompting.** `hV5_XSEBZNg`: "let go of your prompt scaffolding"; "outcome-only specs work better".
- **Red-line context.** `0vdlwOK_Qdk`: "Anthropic Pentagon Mythos red lines" — carved out for defense use under specific policy constraints.

### 1.4 GPT-5.5 ("Spud")

- **Dingo test winner.** `9aIYhjeYxzM`: "GPT-5.5 87.3, Claude 67.0, Gemini 65.0, [4th] 49.8".
- **Splash Brothers data migration win.** `9aIYhjeYxzM`: 5.5 completed where peers stalled.
- **Artemis 2 3D visualization.** `9aIYhjeYxzM`: spatial reasoning task GPT-5.5 handled where others failed.
- **Reliability advantage.** `9aIYhjeYxzM`: "OpenAI is closer to three nines… Anthropic is one to two nines on a 90-day window". For agent loops that retry on 5xx, OpenAI uptime materially reduces wasted retries.

### 1.5 GPT-5.4 / GPT-5.4 Pro

- **Terminal Bench 2.0 lead.** `tJB_8mfRgCo`: "GPT-5.4 75 vs Opus 4.7 69".
- **BrowseComp ceiling.** `tJB_8mfRgCo`: "GPT-5.4 Pro 89".
- **GDPVal-A #2.** `tJB_8mfRgCo`: 1674.

### 1.6 GPT-5.3 / GPT-5.2

- Not separately profiled with numbers, but referenced as available tiers. Our own Codex-CLI probing 2026-05-15 confirms `gpt-5.2` and `gpt-5.3-codex` are accessible on ChatGPT-Plus auth where `gpt-5.2-codex` and `gpt-5.3` are not (see `specs/provider-portability/acceptance/phase-4.json` lastResult notes).

### 1.7 Gemini 3.1 Pro / Ultra

- **Browse competitive.** `tJB_8mfRgCo`: 85 on BrowseComp.
- **GDPVal-A trailing.** `tJB_8mfRgCo`: 1314 vs 1753/1674 leaders.

### 1.8 Gemma 4 (open-source)

- **Apache-2.0.** `85Q9htV2CBE`: the only model in this set that survives in air-gapped or licensing-strict deployment without provider lock.

### 1.9 Cross-model observations

- **Model fit is task-shape, not vendor-rank.** `9aIYhjeYxzM` (Dingo/Splash/Artemis spread), `tJB_8mfRgCo` (Opus wins coding, 5.4 wins browse, Gemini wins neither) — every transcript that runs side-by-side benchmarks ends up routing different jobs to different vendors.
- **Reliability matters for autonomous loops.** `9aIYhjeYxzM`: "three nines vs one nine"; in long-running agent runs, retries on the lower-availability provider eat the apparent quality lead.

---

## 2. FRAMEWORKS

### 2.1 Claude Code

- **Only surface that exposes Opus 4.7's full effort range.** `tJB_8mfRgCo`: "effort levels above high are only exposed in Claude Code".
- **Plan-mode + ultra-review recommended for 4.7.** `tJB_8mfRgCo`.
- **Token-spend hazard.** `5ztI_dbj6ek`: plugin context tax — 50k tokens of plugin context loaded before the first message is described as common. Paired with `tJB_8mfRgCo`'s $42-burn anecdote.

### 2.2 Codex CLI (OpenAI)

- **April 16 revamp shipped real capability.** `2d9ZmA-4QzU`: "background computer use, mid-70s on OSWorld, parallel agents, in-app browser, image gen, 90+ plugins".
- **Subscription path bundled.** `85Q9htV2CBE`: "OpenAI Codex bundles subscription"; "Anthropic blocks subscription routing 10-50x cost".
- **Sky-team computer-use lineage.** `2d9ZmA-4QzU`: Weinstein, Kramer ex-Workflow/Shortcuts; Beverett ex-Apple WebKit/Safari/Privacy; "computer use beats Claude reliably" on their benchmarks.

### 2.3 Anthropic Agent SDK

**Research gap.** Transcripts emphasize Claude Code / Claude-for-Chrome / Co-Work over the raw SDK. No fitness data on the SDK directly.

### 2.4 Claude for Chrome

- **Real autonomous-on-rails behavior.** `QT7W_uHjqWE`: "Carl Valoti… Claude negotiated its way to a $100 credit"; Eric Schwartz "organized roughly 900 loose documents in Google Drive".
- **Schedulable recorded workflows.** `QT7W_uHjqWE`: record-and-replay, save as shortcut, schedule daily/weekly/monthly.
- **Built-in knowledge of Gmail / Drive / Calendar.** `QT7W_uHjqWE`.
- **Group-tab permission model.** `QT7W_uHjqWE`: "can't see anything outside that group tab".
- **Data-scale ceiling.** `QT7W_uHjqWE`: "expand that watch list beyond a few people, coverage gets spotty"; break into subtasks.
- **Plan tier gates model intelligence.** `QT7W_uHjqWE`: "simpler your plan, the dumber the model"; max/team plan for complex tasks.
- **Speed caveat.** `QT7W_uHjqWE`: "not fast… longer than it would take a human".

### 2.5 Conway (leaked Anthropic enterprise)

- **CNW.zip extension format.** `ro5jpbi5uYc`: Google-Play-Services pattern on top of open MCP.
- **Sidebar + search/chat + system + webhook triggers.** `ro5jpbi5uYc`.
- **Strategic positioning.** `ro5jpbi5uYc`: "intelligence-portability lock-in" — explicitly designed to make portability harder once installed. Material implication for v1.0.0's portability claims.

### 2.6 Goose AutoAgent

- **Meta-agent / task-agent split with explicit "model empathy."** `xnG8h3UnNFI`. Most explicit framework-level recognition that different sub-tasks suit different models — adjacent to what Instar's selection layer needs to do.

### 2.7 Claude Design

- **Eight use cases.** `KlPxWaY91rE`. SVG-first, JSX components, Canva-integrated, no Figma export.
- **Max-tier required.** `KlPxWaY91rE`.

### 2.8 Dispatch

- **Server-side /loop primitive + QR-paired parallel co-work.** `3e7gmNPr5Vo`.

### 2.9 Atlas / Chronicle (OpenAI browser) and Chronicle (Anthropic / Receipt)

- Different products with confusingly-similar names in the transcripts. Anthropic's Chronicle bid for Windows desktop control (Receipt acquisition) is separate from OpenAI's browser-side Atlas / Chronicle launch April 20 (geo-restricted ex EU/UK/CH). `2d9ZmA-4QzU`, `hV5_XSEBZNg`.

### 2.10 Other agents mentioned (not deeply profiled)

`b7IS4C9QALc` profiles the agent landscape on three axes — where it runs, who orchestrates, interface contract — touching OpenClaw, Perplexity, Manas, Nemo Claw, Lovable. `KlPxWaY91rE`: Stitch (Google) as Claude Design competitor. `kVPVmz0qJvY`: OpenClaw flagged as the marquee third-party general-purpose agent — "$320,000 value SaaS replacement suite" — but tempered with "open claw is unsafe… people reason… moving really fast and skipping all of these foundations".

### 2.11 Cursor and Aider

**Research gaps.** Cursor mentioned only as the benchmark name "CursorBench"; Aider not mentioned at all.

### 2.12 Stack-literacy view

`7HP1jFJ9W1c` names six durable layers: compute/sandbox (E2B/Daytona/Modal/Browserbase), identity (AgentMail), memory (Mem0), tools (Composio), provisioning (Stripe Projects), orchestration (open). Framework fitness depends on which of these layers the framework provides vs. delegates.

---

## 3. CROSS-CUTTING THEMES

### 3.1 The two architectural bets — MCP-cooperation vs. computer-use

- **Anthropic's bet = MCP-cooperation.** `4KAF72BTyCE`: "MCP is effectively the USBC connector for AI"; `ro5jpbi5uYc`: Conway extension format layered on MCP.
- **OpenAI's bet = computer-use.** `2d9ZmA-4QzU`: "mid-70s on OSWorld"; "OpenAI's 'computer work' framing".
- **They are not mutually exclusive in practice.** `3e7gmNPr5Vo`: "computer-use breaks MCP coverage gaps" — agents in production end up using both, and the routing layer needs to know which surface fits which task.

### 3.2 Tooling friction caps model speed-up at ~2-3x

`XlfumXPPrLY`: "infinite-speed model only yields 2-3x gain due to tool friction" — Jeff Dean GTC quote. Implication: choosing the right *framework* matters at least as much as choosing the right *model*.

### 3.3 The Karpathy loop is the durable agentic primitive

`xnG8h3UnNFI` + `dxq7WtWxi44`: "edit→run→measure→keep/revert with single editable surface + single metric + fixed time budget". Specific examples: Skypilot 910 experiments under $300; Tobi Lutke 19% perf gain; "700 experiments overnight, 11% speedup". Frameworks that express this loop natively are favored over single-shot callers.

### 3.4 Memory is the new moat

`4KAF72BTyCE`: "memory has replaced models as the moat of 2026"; "every single platform makes it easy to get context in and relatively hard to get context out". Four context layers — domain encoding / workflow calibration / behavioral relationship / artifact-and-rationale.

### 3.5 The 97.5% failure rate

`awV2kJzh8zk`: "97.5% Upwork failure rate"; "SWE-CI 75% maintenance failure — 75% break previous features during maintenance". The state of the art is far below human-equivalent on multi-turn maintained codebases. Eval-driven development is positioned as the durable human role.

### 3.6 Process vs. skill — production-grade pattern

`kVPVmz0qJvY`: "do not mistake a skill or a tool call for a process"; "make the in-between glue deterministic". A framework's value is proportional to how cleanly it lets you express deterministic rails around stochastic model calls.

### 3.7 Compute economics shape model fitness

`0vdlwOK_Qdk`: "Sora killed at $15M/day inference cost vs. $2.1M lifetime revenue"; `tJB_8mfRgCo` + `0vdlwOK_Qdk`: Anthropic 10GW in 30 days, $800B valuation, $30B ARR April, 8 of Fortune 10; "12 states with data center moratoriums". Provider-mix decisions are exposed to capacity politics, not just price/quality.

---

## 4. CLAIMS WORTH VERIFYING

Every numeric above comes from one analyst's measurement or anecdote. Before any routing rule depends on a number, re-verify the live value.

- Tokenizer 1.29-1.47x. `tJB_8mfRgCo`.
- GDPVal-A leaderboard (1753 / 1674 / 1314). `tJB_8mfRgCo`.
- BrowseComp 89 / 85 / 79. `tJB_8mfRgCo`.
- Terminal Bench 2.0 (75 / 69). `tJB_8mfRgCo`.
- SWE-bench Verified 87% / 80%. `tJB_8mfRgCo`.
- Reliability "three nines vs. one nine." `9aIYhjeYxzM` — speaker estimate, not provider SLA.
- Effort levels exclusive to Claude Code. `tJB_8mfRgCo`.
- temperature / top_p / top_k / thinking_budget all 400. `tJB_8mfRgCo`.
- Mythos zero-days in Ghost. `hV5_XSEBZNg`.
- OSWorld mid-70s for Codex. `2d9ZmA-4QzU`.
- Harvey 90.19%, Hex 0.76→0.81, Databricks 21% fewer errors. `tJB_8mfRgCo`.
- 97.5% Upwork failure rate. `awV2kJzh8zk`.
- OpenAI 35% / Anthropic 30% enterprise share. `0vdlwOK_Qdk`.
- Sora $15M/day vs $2.1M lifetime revenue. `0vdlwOK_Qdk` — single-source, do not cite externally without verification.

---

## 5. RESEARCH GAPS — explicit follow-ups

- **Anthropic Agent SDK** undercovered. Need direct fitness data on the SDK distinct from Claude Code / Claude-for-Chrome / Co-Work.
- **Aider** — zero coverage.
- **Cursor as a framework** (not as benchmark name) — no fitness coverage.
- **Local-model fitness.** Gemma 4 named as Apache-2.0 only. Critical gap for the local-models path.
- **Claude Haiku-class** — not covered. CLAUDE.md "Intelligence Over String Matching" depends on Haiku economics; need fitness numbers.
- **Multi-model routing in production.** Goose is the only explicit meta-agent/task-agent example. No end-to-end routing harness measurements.
- **Cost-per-resolved-task instead of cost-per-token.** $42-burn anecdote is the only data point; need structured measurement.
- **Eval harnesses themselves.** No transcript names the eval-framework stack to standardize on. Layer-4 fitness cannot be operationalized without one.
- **Long-horizon (>1 hour) agent reliability.** Pavle Hurin 48-hour test (`3e7gmNPr5Vo`) is the only example for Anthropic; no comparable data for non-Anthropic providers.
- **Memory-server portability spec.** `4KAF72BTyCE` proposes the personal-context-server-via-MCP pattern but doesn't name a portable schema.
- **Conway impact on portability.** Not shipped publicly yet; re-evaluate when it ships.
- **Chinese open-source frontier — explicit blind spot.** Nate B Jones's last 250 videos have ZERO coverage of DeepSeek (V3/V4), Qwen (3.x), or Kimi (K2.x). His beat is the Western frontier (OpenAI / Anthropic / Google). Per Justin's 2026-05-15 directive, the model fitness catalog now sources these families from official model cards, HuggingFace, third-party benchmark sites, and recent analyses (buildfastwithai, miraflow, the-decoder, Verdent, AkitaOnRails, BenchLM, NIST CAISI). Future research passes should pull from non-Western analysts to keep coverage balanced (suggested feeds: AkitaOnRails LLM benchmark series, Artificial Analysis, NIST evaluations, Hugging Face model card revisions).

---

## How this synthesis is used

The fitness catalogs (`08-model-fitness-catalog.md` and `09-framework-fitness-catalog.md`) cite this document with per-claim confidence markers. Anything from a single Nate B Jones transcript is `confidence: low (single-analyst)` until corroborated by an authoritative source. Anything from a third-party benchmark Nate cites is `confidence: medium (third-party benchmark, transcript-relayed)` until verified against the original.

The benchmarking framework (Phase 5d) will replace the lowest-confidence entries with empirical numbers over time. Until then, the catalogs document the current best signal we have.
