# INSTAR LLM Routing Registry (living document)

**Purpose.** Be *extremely intentional* about which provider + model every LLM task in Instar defaults to. Every codepath that hands a decision or generation to an LLM is enumerated here with its **task nature** and its **intended default**. If a callsite isn't here, it isn't governed — add it.

**Freshness guard (2026-07-03):** the per-provider "capable/latest/frontier" model pins are now protected against silent rot by `scripts/lint-model-registry-freshness.mjs` + `scripts/model-registry-freshness.manifest.json` (the human-edit frontier allowlist + `lastReviewedAt`). Two teeth — a staleness window and a per-door allowlist-membership drift check. Ships in `enforcement: "report"` (non-gating, VISIBLE in the CI lint log); flip to `"strict"` when the operator wants the guard to gate CI. When you swap a model id, update the manifest allowlist + `lastReviewedAt` in the same change. As of 2026-07-03 the `flaggedStale` block is EMPTY — both prior pending pins are resolved: gemini `capable` swapped `gemini-2.5-pro` → `gemini-3.1-pro-preview`; codex `capable` stays `gpt-5.5` (GA flagship — `gpt-5.6-sol` is preview-only/gov-gated, NOT pinned).

**Status:** v2, 2026-07-02 (Echo) — now maintained IN-REPO (first canonical shipment); benchmark-derived defaults below supersede the v1 taxonomy recommendations. **Runtime source of truth:** `GET /intelligence/routing` (registered components) + `.instar/config.json → sessions.componentFrameworks` / `frameworkDefaultModels` / `topicFrameworks` / `models.tierEscalation`. This doc is the *human-readable intentional-defaults layer*. Callsite inventory verified against `src/` (branch `echo/serve-main`) AND the deployed dist for the load-bearing claims. **Keep it current:** add a row when you add an LLM callsite; update the row + note why when you change a default.

---

## ⭐ Headline findings (verified against deployed code)

1. **[FIXED — PR #1319, merged 2026-07-02] Thirteen LLM components ran on Claude by default.** The Provider-Fallback Default Policy only moves components whose `attribution.component` name is in the `COMPONENT_CATEGORY` map (`src/core/componentCategories.ts`) as sentinel/gate/reflector, OR that pass an explicit `attribution.category`. Anything else resolves to `'other'` → **the agent default framework (Claude) at its tier.** On canonical the full set was 13 (this doc's original 9 plus `TelegramAdapter`, `Usher`, `TopicIntentExtractor`, `a2a-checkin`; `MentorStageBForensics` is `mentor-stage-b` at the callsite). Corrected framing: they were NOT silently unknown — they were the pinned `WIRING_EXCLUSIONS` backlog in `tests/unit/llm-attribution-ratchet.test.ts`, deliberately deferred pending a routing decision, and that ratchet already fails CI on any NEW unregistered callsite (the drift guard exists and is live). PR #1319 registered all 13 (`InputClassifier`/`SessionSummarySentinel`/`TelegramAdapter`→sentinel, `ResumeValidator`→gate, the other 9→reflector) and trimmed the exception list to the 5 explicit-category components. Per-row ⚠/❌ markers below predate the fix — read them as "fixed in #1319."
2. **Bounded sentinels/gates route to gpt-5.5 (a large model) — overkill for nature-A tasks.** Echo routes sentinels/gates/reflectors → **pi-cli → `openai-codex/gpt-5.5`**. INSTAR-Bench shows a simple bounded verdict (classify a message, boolean gate) is equal-accuracy on a small fast model (GPT-5.4-mini / Gemini 3.1 Flash-Lite) — faster and cheaper. gpt-5.5-via-codex is also SLOW (~18.5s observed). **But keep the nature-B critical gates on a reasoning model** (see taxonomy).
3. **Hardcoded-model / router-bypass callsites** exist (dispatch=haiku, mentor=opus, setup-wizard=gpt-5.3-codex/gemini-flash, credential-probe=haiku, crossModelReviewer=codex+gemini). These are NOT re-routable via config — listed in "Risk items."
4. **Model-ID caveat:** `src/core/models.ts` now shows `claude-opus-4-8 / sonnet-4-6 / haiku-4-5`, reconciled with `ModelTierEscalation` (`claude-opus-4-8` default + escalated `claude-fable-5`) — the prior `opus-4-6`↔`opus-4-8` drift is resolved. Treat concrete IDs as verify-against-deployed.

---

## Task-nature taxonomy (route by NATURE, not token count — operator directive 2026-07-01)

| Nature | Description | Needs | Route to | Bench basis |
|---|---|---|---|---|
| **A. Simple bounded verdict** | classify a message, boolean gate, strict-JSON extract — one right answer, terse | speed, terseness, format-obedience, low cost (volume) | GPT-5.4-mini / Gemini 3.1 Flash-Lite / Haiku 4.5 / (free: gpt-oss-20b via Groq, paced) | ~1.2s, det 1.00; reasoning models CLIP here |
| **B. Nuanced / critical judgment** | ambiguous coherence call, safety gate, irreversible-action class, completion-stop judge — being RIGHT beats fast/cheap | reasoning depth + adequate output budget | Opus 4.8 / GPT-5.5 / a reasoning model WITH budget | v1 under-measures this — v2 gap |
| **C. Hard interactive agent work** | debugging, planning, multi-step reasoning in a session | top capability + reasonable speed | Opus 4.8 / GPT-5.4 | 9.8 judged, terse, full delivery |
| **D. High-volume background** | digests, batch classify, summaries, doc-tree | quality + low cost (volume) | GPT-5.4-mini / Gemini Flash-Lite / DeepSeek V4 Pro | high quality, low cost |
| **E. Deep unbounded reasoning** | rare, no output-budget pressure | maximum reasoning | GLM-5.2 / Kimi / Gemini-Pro | high quality WHEN unbounded |

**Anti-patterns:** routing a *simple bounded verdict* (A) to a reasoning model (overkill + self-clipping); starving a *critical judgment* (B) of reasoning budget (false economy).

**Proposal:** the registry categorizes by coarse category (sentinel/gate/reflector/job) which MIXES nature-A and nature-B within a category. Add a per-component `nature` tag so routing can be A→fast-small, B→reasoning, D→cheap-background — the intentional layer this doc argues for.

---

## Benchmark-derived routing defaults (INSTAR-Bench v2, 2026-07-02)

Basis: the v2 critical set — 3,030+ scored calls, 11 critical gates/sentinels ×
108 limit-seeking cases (5 stress axes), every failure forensically judged
(run stamps `crit-cli`, `crit-metered`); wave-2 full-registry coverage (stamp
`wave2`, 18 task batteries over the remaining components); and 6 prompt A/Bs
with ratchet semantics. Artifacts live in the benching agent's research tree
(`research/llm-pathway-bench/instar-bench-v2/`), digest in
`results/instar-bench-v2/CRITICAL-SET-DIGEST.md`. OpenRouter small-model slots
are INTERIM pending the vendor-balance remainder run.

### Hard rules (each cites its run)

1. **NEVER route bounded gate/sentinel work through opus×claude-code-CLI.**
   Opus 0.940 via API vs 0.713 via the claude-code door on identical prompts
   (verdict-first-then-contradict). Replicated on wave-2 tasks. Sonnet/haiku on
   the same door are unaffected (0.991 / 0.870). [crit-cli, crit-metered, wave2]
2. **MessageSentinel specifically must never route via opus×claude-code** —
   even the incumbent prompt misses canonical emergency-stops ~1/3 there.
   [ab-sentinel-classify arbitration]
3. **NEVER route bounded contract work to qwen-tier** (0.116 / 0.028 — chronic
   reason-burn self-clipping). [crit-metered]
4. **NEVER route bounded-budget gates to reasoning-heavy tiers** — gemini-3.1-pro
   burned 5× production's token budget on thinking and clipped its own JSON.
   [crit-metered tone-gate bad-json cluster]
5. **gpt-oss-20b: no evidence-judging or adversarial-facing gates** (fell for a
   judge-directed injection; fabricated evidence wording; over-refuses into
   unusable output). [crit-metered forensics]
6. **llama-4-scout: not for gate verdicts** (systematic over-conservatism +
   contract-breaking prose). **llama-3.3-70b: not for strict-JSON array
   emission.** [crit-metered forensics]
7. **SessionActivitySentinel (digests) must not run on haiku unguarded** —
   haiku reproduced a live credential verbatim into a digest (blind-judged
   score 3/10); production currently runs this task on the fast tier. Route to
   sonnet-tier or add a redaction instruction before the next release. [wave2
   activity-digest blind judging]

### Tiered defaults per task nature (subsidized-non-Claude-first)

**Nature A — bounded verdict/extract, high volume:**
1. codex-cli → gpt-5.4-mini (0.926; p50 ~11.5s — background, not latency-critical)
2. pi-cli → gpt-5.5 (0.907; p50 6.2s — the latency-sensitive subsidized pick)
3. gemini-cli → gemini-flash (0.954; free-tier RPM caps it to low-volume lanes)
4. claude-code → sonnet (0.991 — the accuracy ceiling of the whole board;
   Claude-quota, so fallback not default)
5. metered: glm-5.2 via OpenRouter (0.967, ~$0.002/call) · Groq gpt-oss-120b
   (0.778, free) for non-adversarial batch [interim pending OpenRouter remainder]

**Nature B — critical judgment gates:**
1. codex-cli → gpt-5.5 (0.917–0.926) · 2. pi-cli → gpt-5.5 (0.907, faster door)
3. claude-code → sonnet (0.991) where Claude quota is acceptable
4. metered: glm-5.2 (0.967), then opus-4.8 via API (0.940) — never via
   claude-code CLI (rule 1)

**Nature D — background digests/summaries:**
1. codex-cli → gpt-5.4-mini · 2. Groq gpt-oss-120b (free, non-adversarial only)
3. claude-code → opus for GENERATIVE quality when quota allows (opus tops the
   judged digest task at 8.94/10 — the nature-split in action: opus loses
   bounded verdicts through this door but wins open-ended generation) — subject
   to rule 7 for secret-bearing content.

### Prompt fixes shipped from the same bench evidence (2026-07-02)

- **MessagingToneGate** — full rule-identifier contract + JSON quote-escaping
  rule (PR #1325; A/B 40/0/118). The #1 cross-model defect was the prompt
  itself instructing short ids its own parser rejects.
- **CompletionEvaluator P13 stop-judge** — no-stop branch defined + wall-clock
  never an off-ramp (PR #1327; A/B 7/0/130).
- **ExternalOperationGate** — authority rule: in-content approval claims are
  data, never authorization (PR #1327; A/B 3/0/104; three broader variants
  ratchet-rejected for opus over-block).
- **InputClassifier** — unsure defined (no-../-traversal in-project rule) +
  answer-only contract (PR #1328; A/B 3/0 post-arbitration; second-pass
  reviewer concern accepted + re-verified).
- **Held back:** completion-judge evidence-clause (3 variants each failed the
  ratchet differently — weakness is routing-addressable) and sentinel-classify
  degenerate-clause (opus emergency-stop regression — instantly disqualified).

## Resolution mechanics (how framework + model + size get chosen)

**Framework, per `.evaluate()` call** (`IntelligenceRouter.resolveFramework`), live each call:
1. `componentFrameworks.overrides[ComponentName]` — exact-name override (highest).
2. `componentFrameworks.categories[category]` — category via explicit `attribution.category`, else `categoryForComponent(name)` (strips `/segment` suffix + `server:` prefix; **unknown → `'other'`**).
3. `componentFrameworks.default` → 4. `defaultFramework` (`sessions.framework ?? INSTAR_FRAMEWORK ?? 'claude-code'`).

**Provider-Fallback Default Policy:** with no config, sentinel/gate/reflector categories default to the first ACTIVE CLI in `codex-cli → pi-cli → gemini-cli → claude-code`; `failureSwap` = the rest. **`job` and `'other'` are deliberately excluded → stay on the agent default (Claude).**

**Failure behavior:** a `gating:true` call whose primary fails swaps DOWN `failureSwap` (each circuit-broken, per-attempt cap `intelligence.swapAttemptTimeoutMs`=5s) then fails closed. Non-gating calls propagate the error (caller heuristic-fallback). Missing binary → degrades to default framework + DegradationReporter.

**Size → model:** abstract tier (`fast`/`balanced`/`capable`; default `fast` for Claude, `balanced` for the headless adapter) maps per framework:

| tier | claude-code | codex-cli | gemini-cli | pi-cli |
|---|---|---|---|---|
| fast | claude-haiku-4-5 | gpt-5.4-mini | gemini-2.5-flash | configured `provider/id` |
| balanced | claude-sonnet-4-6 | gpt-5.4-mini | gemini-2.5-flash | configured `provider/id` |
| capable | claude-opus-4-8 | gpt-5.5 | gemini-3.1-pro-preview | configured `provider/id` |

**Two overlays on the Claude path:** `AnthropicSubscriptionRouter` (SDK-credit `claude -p` vs subscription interactive-pool; `intelligence.subscriptionPath.mode`, currently `off`) sits inside the per-framework breaker; the account-global breaker + usage metering (`CircuitBreakingIntelligenceProvider`) wraps all. **Tier escalation** (`models.tierEscalation`) applies to spawned SESSIONS, not `.evaluate()` calls.

**Echo's current live config:** sentinels/gates/reflectors → **pi-cli (→gpt-5.5)**; jobs → **codex-cli**; overrides `MessagingToneGate→pi-cli`, `Usher→codex-cli`, `TopicIntentExtractor→codex-cli`; `failureSwap:[pi-cli, claude-code]`; claude-code sessions default model → **claude-fable-5**; `tierEscalation` enabled (heavy-work skills → fable-5); `subscriptionPath` off.

---

## Callsite inventory

Legend: **OC(tier)** = off-Claude via `codex-cli→pi-cli→gemini-cli→claude-code` (routing categories sentinel/gate/reflector). **AD(tier)** = agent default framework (Claude) at tier (routing categories job/other). ⚠ = silently on Claude (see headline #1). Model per tier: see the size→model table above.

### Sentinels (router-backed)
| Component | file:line | Decision | Nature | Route | Intentional? |
|---|---|---|---|---|---|
| MessageSentinel | src/core/MessageSentinel.ts:559 | classify inbound (emergency/pause/redirect/normal) | A | OC(default)·gating | ⚠ overkill: gpt-5.5 for a 1-word verdict |
| CommitmentSentinel | src/monitoring/CommitmentSentinel.ts:326 | extract commitments | A | OC(fast) | ⚠ small model fits |
| CompletionEvaluator (goal-met, P13) | src/core/CompletionEvaluator.ts:124/211 | is autonomous goal met? / blocker honesty | **B** (gates a stop) | OC(fast) | ✅ nature-B — keep reasoning |
| InputGuard / InputDetector | src/core/InputGuard.ts:321 | prompt-injection / stuck-session | **B** safety | OC(fast) | ✅ |
| TemporalCoherenceChecker | src/core/TemporalCoherenceChecker.ts:182 | time-claim contradiction | A | OC(fast) | ⚠ small fits |
| TopicIntentArcCheck | src/core/TopicIntentArcCheck.ts:262 | intent drift | A/B | OC(fast) | ~ |
| ProjectDriftChecker | src/core/ProjectDriftChecker.ts:351 | project/topic drift | B | OC(balanced) | ✅ |
| PresenceProxy | src/monitoring/PresenceProxy.ts:1809 | standby status / tier message | A | OC(fast/balanced) | ⚠ |
| PromiseBeacon | (sentinel) | follow-through heartbeat wording | A | OC(fast) | ⚠ |
| SessionActivitySentinel ×3 | src/monitoring/SessionActivitySentinel.ts:300/552/659 | session digest/synthesis | D | OC(fast) | ⚠ cheap fits |
| SessionWatchdog | src/monitoring/SessionWatchdog.ts:718 | is a destructive Ctrl-C legit? | B | OC(default) | ✅ |
| StallTriageNurse | src/monitoring/StallTriageNurse.ts:609 | diagnose stalled session | B | OC(balanced) | ✅ |
| ResumeQueueDrainer | src/commands/server.ts:7310 | resume sanity (observe-only) | A | OC(fast) | ⚠ |
| InteractivePoolCanaryJudge | src/providers/adapters/anthropic-interactive-pool/index.ts:200 | pool idle? | A | OC(fast) | ⚠ |
| PromptGate | src/monitoring/PromptGate.ts:656 | unanswered permission prompt? | A | OC(fast) | ⚠ |
| SlackAdapter (alert-suppress) | src/messaging/slack/SlackAdapter.ts:844 | suppress a stall alert? | A | OC(default, maxTok 5) | ⚠ |
| **InputClassifier** ⚠ | src/monitoring/InputClassifier.ts:246 | auto-approve vs relay | A | **AD(fast) → Claude** | ❌ not in map — silently on Claude |

### Gates (router-backed)
| Component | file:line | Decision | Nature | Route | Intentional? |
|---|---|---|---|---|---|
| MessagingToneGate | src/core/MessagingToneGate.ts:264 | outbound tone/leak/self-stop | A/B·gating | OC(fast) (override→pi) | ⚠ high-volume + fails closed; accuracy matters, but a fast small model likely fits |
| CoherenceGate / CoherenceReviewer | src/core/CoherenceReviewer.ts:295 | action coherent for project? | **B** (blocks work) | OC(fast) | ✅ keep reasoning |
| ExternalOperationGate | src/core/ExternalOperationGate.ts:510 | external-op mutability class | **B** safety | OC(default)·gating | ✅ |
| LLMSanitizer | src/security/LLMSanitizer.ts:110 | prompt-injection sanitize | **B** safety | OC(fast) | ✅ |
| UnjustifiedStopGate | src/core/UnjustifiedStopGate.ts:416 | is a self-stop justified? | B | OC(fast) | ✅ |
| WarrantsReplyGate | src/threadline/WarrantsReplyGate.ts:295 | does A2A msg need a reply? | A | OC(fast) | ⚠ small fits |
| MoveIntentClassifier | src/core/MoveIntentClassifier.ts:303 | is inbound a "move/pin this on <nickname>" command vs discussion? | A·gating (fail-open) | OC(fast) | ✅ nature-A strict-JSON enum verdict; fail-open never hijacks, so a small fast model fits (replaces a keyword verb-list — the 2026-07-03 hijack) |
| HubIntentClassifier | src/threadline/HubIntentClassifier.ts:classifyHubIntent | is a hub message an "open this"/"tie this to <topic>" bind command vs discussion? | A·gating (fail-open) | OC(fast) | ✅ nature-A strict-JSON enum verdict; fail-open never swallows, so a small fast model fits (replaces the anchored regexes that ate the message before the agent saw it) |
| TaskClassifier / OverrideDetector / AutoApprover / IntegrationGate / PromptGate | src/providers/uxConfirm/* | classification / approval verdicts | A | OC(fast) | ⚠ mostly nature A |
| DiscoveryEvaluator | src/core/DiscoveryEvaluator.ts:467 | surface a feature discovery? | A | OC(fast) | ⚠ |
| IntentLlmJudge / LlmIntentClassifier / AmbientContributionGate | src/core/IntentTestHarness.ts:246; src/permissions/* | intent-vs-org / permission intent / speak? | B·gating (explicit category) | OC(fast) | ✅ explicit-category, correct |
| RelationshipAnomalyScorer | src/permissions/RelationshipAnomalyScorer.ts:387 | voice match vs principal | A·gating (explicit) | OC(fast) | ✅ |
| **ResumeValidator** ⚠ | src/core/ResumeValidator.ts:211 | resume UUID matches topic? | A | **AD(fast) → Claude** | ❌ not in map |

### Reflectors / extractors (router-backed)
| Component | file:line | Decision | Nature | Route | Intentional? |
|---|---|---|---|---|---|
| TopicSummarizer | src/memory/TopicSummarizer.ts:163 | topic summary + PURPOSE | D | OC(fast) | ⚠ cheap fits |
| RelationshipManager ×2 | src/core/RelationshipManager.ts:328/381 | person match / dedup | D | OC(fast) | ⚠ |
| StandardsConformanceReviewer ×2 | src/core/reviewers/standards-conformance.ts:206/256 | spec-vs-standards / fit | B | OC(capable) | ✅ |
| JobReflector | src/core/JobReflector.ts:207 | reflect on job outcome | B/D | OC(capable) | ✅ |
| ContextualEvaluator ×3 | src/core/ContextualEvaluator.ts:121/354/414 | accept/reject a dispatch | A/B | OC(fast) | ~ |
| TreeTriage ×2 | src/knowledge/TreeTriage.ts:373/435 | score node/layer relevance | A | OC(fast) | ⚠ |
| **Usher** | src/core/Usher.ts:96 | route a turn to topics | A | **codex-cli (override)** | ✅ overridden off-Claude in Echo (would be ⚠ by default) |
| **TopicIntentExtractor** | src/core/TopicIntentExtractor.ts:284 | extract topic intent | A | **codex-cli (override)** | ✅ overridden (default would be ⚠) |
| **PreCompactionFlush** ⚠ | src/core/PreCompactionFlush.ts:162 | extract durable facts pre-compaction | D | **AD(default) → Claude** | ❌ not in map |
| **SessionSummarySentinel** ⚠ | src/messaging/SessionSummarySentinel.ts:181 | summarize tmux → task/phase | D | **AD(fast) → Claude** | ❌ not in map |
| **openConversationBrief** ⚠ | src/threadline/openConversationBrief.ts:265 | A2A conversation brief | D | **AD(fast) → Claude** | ❌ not in map |
| **TreeSynthesis** ⚠ | src/knowledge/TreeSynthesis.ts:63 | synthesize fragments → answer | D | **AD(fast) → Claude** | ❌ not in map |
| **LLMConflictResolver** ⚠ | src/core/LLMConflictResolver.ts:204 | resolve divergent multi-machine state | B | **AD → Claude** | ❌ not in map |
| **MentorStageBForensics** ⚠ | src/scheduler/MentorStageBForensics.ts:141 | classify mentor signals → findings | B | **AD(capable) → Claude** | ❌ not in map |
| **server:correction-learning** ⚠ | src/commands/server.ts:11380 | distill corrections → preference | D | **AD(fast) → Claude** | ❌ strips to unmapped name |
| **SelfKnowledgeTree** ⚠ | src/knowledge/SelfKnowledgeTree.ts | synthesize self-knowledge tree nodes | D | **AD → Claude** | ❌ not in map (bench pending wave-3) |

### Jobs (router-backed, cost-bearing)
| Component | file:line | Decision | Route | Note |
|---|---|---|---|---|
| CartographerSweepEngine | src/core/CartographerSweepEngine.ts:670 | author stale doc-tree summary | codex-cli (job) | `probeRouting()` REFUSES Claude — off-Claude REQUIRED so it never spends Anthropic quota |
| StandardsCoverageEnrichment | (dark) | optional conformance enrichment | job | inert unless dark flag on |
| PipeSessionSpawner ×2 | src/threadline/PipeSessionSpawner.ts:158/229 | pipe-spawn intent / history summary | AD (job→Claude) | job category stays on Claude by design |

### Session/model selection (which model a SPAWNED session runs)
Resolution order (verified): (1) `/local-model` binding (codex) → (2) topic-profile explicit model pin → (3) topic-profile tier pin → (4) `topicProfiles.defaults[topic].model` → (5) `sessions.frameworkDefaultModels[fw]` → (6) **CLI account default** (no `--model`). Framework: topic-profile pin → `topicFrameworks[topic]` → `_defaultFramework`. Overlays: **tier escalation** (`models.tierEscalation`, ultra=`claude-fable-5`, heavy-work skills) + **subscription-path billing** (`intelligence.subscriptionPath.mode`). Key files: `src/commands/server.ts:589/4497/868`, `src/core/TopicProfileResolver.ts:109`, `src/core/frameworkSessionLaunch.ts:39/215/555/578/642/669`, `src/core/ModelTierEscalation.ts:110/218`, `src/core/EscalationGovernor.ts:137`, `src/core/ModelSwapService.ts:189`.

---

## Risk items — hardcoded model / router bypass (NOT config-re-routable)

| # | Callsite | file:line | Model | Note |
|---|---|---|---|---|
| 1 | crossModelReviewer (codex) | src/core/crossModelReviewer.ts:432 | gpt-5.5 (codex-cli) | intentional 2nd-opinion; not re-routable |
| 2 | crossModelReviewer (gemini) | src/core/crossModelReviewer.ts:507 | gemini-2.5-pro | intentional; not re-routable |
| 3 | DispatchExecutor.runAgentic | src/core/DispatchExecutor.ts:572 | **hardcoded haiku** | agentic dispatch step |
| 4 | MentorAutonomousGuardian | src/scheduler/MentorAutonomousGuardian.ts:100 | **hardcoded opus** | full-tool mentor loop |
| 5 | setup-wizard codex-driver | src/commands/setup-wizard/codex-driver.ts:192 | **hardcoded gpt-5.3-codex** | wizard copy |
| 6 | setup-wizard gemini-driver | src/commands/setup-wizard/gemini-driver.ts:194 | **hardcoded gemini-2.5-flash** | wizard copy |
| 7 | anthropic-headless credential probe | src/providers/adapters/anthropic-headless/control/authCredentialInjection.ts:67 | **hardcoded claude-haiku-4-5** | direct api.anthropic.com validation ping |
| 8 | Claude tier→id source of truth | src/core/models.ts | claude-opus-4-8/sonnet-4-6/haiku-4-5 | changing Claude models = edit this file, not config |
| 9 | metered-funnel | research/llm-pathway-bench/metered-funnel.mjs:181 | openrouter/openai/groq/deepinfra/anthropic | budget-gated; bench-only |
| 10 | `instar reflect` / `instar route` CLIs | src/commands/reflect.ts:361; route.ts:80 | direct buildIntelligenceProvider | CLI, not server |

---

## Provider CLI implementations (the sanctioned `.evaluate()` bodies)
`ClaudeCliIntelligenceProvider` (src/core/ClaudeCliIntelligenceProvider.ts:65, `claude -p --model … --max-turns 1`) · `CodexCliIntelligenceProvider` (src/core/CodexCliIntelligenceProvider.ts:425, `codex exec --json … --model`, unset tier → gpt-5.4-mini; kill-switch `INSTAR_CODEX_EXEC_JSON=0`) · `GeminiCliIntelligenceProvider` (:101, unset → gemini-2.5-flash) · `PiCliIntelligenceProvider` (:91, configured `provider/id`, Anthropic patterns refused) · `InteractivePoolIntelligenceProvider` (pool model fixed at spawn, default haiku) · `anthropic-headless` oneShot (balanced default; may inject `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`).

## Non-judgment LLM HTTP (completeness)
Whisper transcription — Telegram (src/messaging/TelegramAdapter.ts:3010), WhatsApp (src/messaging/backends/BaileysBackend.ts:429): `whisper-large-v3` (groq) / `whisper-1` (openai). Audio→text, not judgment. Quota/identity polls hit `api.anthropic.com/api/oauth/*` (non-generative).

---

## Priority actions
1. ~~**Categorize the uncategorized components**~~ **DONE — PR #1319 (merged 2026-07-02):** all 13 registered; the pre-existing wiring ratchet (`llm-attribution-ratchet.test.ts`) is the fail-closed drift guard (no new test needed).
2. **Split routing by task nature**, not coarse category — nature-A verdicts → fast small model; nature-B critical → reasoning model; nature-D background → cheap. Add a per-component `nature` tag. **NEW routing axis (operator directive 2026-07-01):** among floor-clearing models, prefer a **subsidized non-Claude subscription** door (Claude subs rate-limit hard), with a tiered benchmark-derived fallback chain per task. Design in `research/llm-pathway-bench/INSTAR-BENCH-V2-SPEC.md` §5; operator-reviewed before shipping (touches critical-gate model selection).
3. **Review the hardcoded-model risk items** — decide which should become config-driven (esp. #3 dispatch-haiku, #4 mentor-opus). Open question #2 in the v2 spec (bench as-is vs migrate onto the router first).
4. **v2 benchmark:** comprehensive coverage of every registry row, limit-seeking cases, per-failure prompt-fault forensics + A/B loop, run periodically. Spec drafted: `research/llm-pathway-bench/INSTAR-BENCH-V2-SPEC.md` (awaiting operator answers on its 3 open questions).
5. **Keep this doc current** — a `.evaluate()` callsite added without a row here is an ungoverned default. The wiring ratchet covers map registration; the v2 spec §6 adds a benchmark-coverage ratchet + a registry-doc freshness check.
