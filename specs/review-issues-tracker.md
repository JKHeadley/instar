# Review Issues Tracker — Coherence Gate (formerly Response Review Pipeline)

**Generated**: 2026-03-09
**Source Reviews**: 8 internal (Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing) + 3 cross-model (GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast) + 2 synthesis documents
**Spec**: `/Users/justin/.instar/agents/echo/specs/response-review-pipeline.md`

---

## P0 — Must Fix Before Implementation

| # | Issue | Flagged By | Spec Status | Action Required |
|---|-------|-----------|-------------|-----------------|
| 1 | **Prompt injection via agent response content** — `---` delimiters are trivially breakable; adversarial content in message can manipulate reviewers | Security, Adversarial, Gemini | Not addressed | Add randomized delimiters, anti-injection preambles, structured message passing |
| 2 | **Per-channel fail-open/fail-closed** — `failOpen: true` for external channels is an exploitable kill switch | Security, Adversarial, Privacy, Scalability, GPT | Not addressed | Make fail-open configurable per channel; external channels default fail-closed with queue-and-hold |
| 3 | **Reviewers lack conversation context** — Claim Provenance and Settling Detection cannot verify claims without tool output | Architecture, Business, DX, GPT, Gemini, Grok | Acknowledged in Open Question #2 only | Pass truncated recent tool output (~500 tokens) to key reviewers |
| 4 | **Feedback trains evasion, not improvement** — Specific reviewer names + issues teach agent to bypass | Adversarial | Not addressed | Obfuscate feedback: generic categories, no reviewer names, rotate prompt variations |
| 5 | **Stop hook output contract contradiction** — Exit code 2 vs JSON stdout described inconsistently; `skipWhenHookActive` contradicts Revision Flow | Architecture, GPT | Contradictory in spec | Pick JSON stdout mechanism; clarify retry semantics with state machine |
| 6 | **No custom reviewer interface** — No way to extend pipeline without modifying instar source | DX | Not addressed | Define ReviewerSpec contract, `.instar/reviewers/` directory with auto-discovery |
| 7 | **No dry-run/test mode** — Cannot iterate on reviewer prompts without sending real messages | DX | Not addressed | Add `POST /review/test`, `observeOnly` config mode |
| 8 | **No user consent/transparency** — Every response sent to Anthropic API with no disclosure | Privacy | Not addressed | Add transparency section, consent mechanism, privacy notice |
| 9 | **No data minimization** — Full message + PII sent to all reviewers | Privacy | Not addressed | Per-reviewer content scoping, PII scrubbing before API calls |
| 10 | **Rename to "Coherence Gate"** — "Response Review Pipeline" is engineering label, not product name | Marketing | Partially (term used in spec body) | Rename throughout spec, config keys, API discussion |
| 11 | **Claude-judging-Claude family bias** — Haiku systematically favors Claude output (perplexity-based) | Adversarial | Not addressed | Add Claude-typical failure examples to prompts; document bias mitigation strategy |
| 12 | **Gate bypass for external channels** — Short malicious messages can skip full review | Security, Adversarial, Gemini | Not addressed | Force full review for external channels; fix Simple Acknowledgment Loophole |

## P1 — Should Fix Before Production

| # | Issue | Flagged By | Spec Status | Action Required |
|---|-------|-----------|-------------|-----------------|
| 13 | **Prompt caching not designed in** — 10x cheaper reads, cached tokens don't count toward rate limits | Scalability, Architecture | Not mentioned | Design for prompt caching from day one with `cache_control` |
| 14 | **Shadow-mode rollout plan** — Retiring existing hooks without parallel validation is risky | Business, Architecture, Adversarial | Not addressed | Run pipeline in shadow mode alongside existing hooks for 2-4 weeks |
| 15 | **Cost model underestimates by ~5x** — Spec ignores output tokens ($5/MTok) | Scalability | Wrong estimate in spec | Recalculate: ~$0.005/review, ~$5-6/month per agent |
| 16 | **`Promise.allSettled` instead of `Promise.all`** — Single reviewer timeout shouldn't reject all | Architecture | Spec says Promise.all | Change to Promise.allSettled |
| 17 | **Simple Acknowledgment Loophole** — Short negative statements ("I can't", "nothing found") bypass gate | Gemini | Not addressed | Update gate prompt to flag negative resolutions regardless of length |
| 18 | **Reviewer responsibility matrix / overlap resolution** — Multiple reviewers flag same issues (Claim Provenance vs URL Validity) | GPT, DX | Not addressed | Add responsibility matrix with primary concerns and overlap rules |
| 19 | **Aggregation policy for mixed block/warn verdicts** — Spec says "any flags = block" but doesn't define warn handling | DX, GPT | Undefined | Define: block always blocks, warn passes with feedback, configurable escalation |
| 20 | **Revision loop UX** — 18-second silent revision cycle degrades user experience | Gemini | Not addressed | Emit "reviewing/self-correcting" status events during review |
| 21 | **JSON schema enforcement in reviewer prompts** — Risk of malformed Haiku output crashing pipeline | Grok | Not addressed | Add strict JSON instructions, consider Anthropic tool_choice for structured output |
| 22 | **Reviewer health monitoring** — No detection of silent reviewer degradation (model updates, prompt drift) | Adversarial | Not addressed | Track per-reviewer pass rates, latency; alert on anomalies; canary messages |
| 23 | **Value summarization fidelity** — "Summarized bullet points" method undefined, risks hallucination | Grok | Not specified | Define deterministic summarizer, validate against raw source |

## P2 — Plan for Future

| # | Issue | Flagged By | Spec Status | Action Required |
|---|-------|-----------|-------------|-----------------|
| 24 | **Timing side channel via `duration_ms`** — Reveals gate decisions and fail-open events | Security | Not addressed | Remove from user-facing responses, keep in server logs |
| 25 | **Multi-user privacy boundaries** — User A's data could leak into User B's review | Privacy | Not addressed | Document per-user review isolation |
| 26 | **Non-English response handling** — All prompts are English; multilingual assessment unreliable | Adversarial | Not addressed | Document as known limitation, detect language |
| 27 | **Whitelisted domain abuse** — Fabricated URLs on whitelisted domains pass review | Adversarial | Not addressed | Pattern-level whitelisting or tool-output verification |
| 28 | **Reviewer consolidation path for scale** — 7+ reviewers create rate limit pressure at fleet scale | Gemini, Scalability | Not addressed | Document consolidation strategy (2-3 thematic calls) |
| 29 | **Migration/rollback plan** — No phased enablement or rollback triggers defined | GPT, Grok | Not addressed | Add migration section with shadow mode, phased rollout, rollback |
| 30 | **Eval dataset from appendix incidents** — No golden test set for reviewer calibration | GPT, Gemini, Grok | Not addressed | Extract test cases from Dawn incidents, define precision/recall targets |
