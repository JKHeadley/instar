# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

Tier 2.B (StallTriageNurse framework awareness) landed: the stall-detection sentinel's heuristic pre-filter no longer hardcodes Claude Code's tool-call regex and spinner glyphs. New `src/monitoring/frameworkActivitySignals.ts` exposes per-framework activity signatures (`toolCallOrSpinner`, `escapeToInterrupt`, `runningIndicator`, plus a prompt-signatures line injected into the LLM system prompt). The nurse reads `config.framework` from `StallTriageConfig` (defaulting to claude-code for backwards-compat), and `server.ts` threads the resolved `INSTAR_FRAMEWORK` value into the construction site. Previously the shell-prompt restart heuristic would false-fire on a healthy Codex pane (no Claude tokens → "framework wrapper has exited"); now it correctly recognizes Codex tool tokens. 22 new tests (16 signal-module + 6 framework-aware heuristics).

CoherenceReviewer subclasses and CoherenceGate dropped the unused `apiKey` constructor parameter — dead since the Rule 2 path-constraint lockdown removed the direct-Anthropic-API fallback. Reviewer LLM calls already route exclusively through the IntelligenceProvider; the key was being stored but never read.

CoherenceGate now requires an IntelligenceProvider. When none is wired, the response review pipeline is disabled with a warning instead of attempting a raw API fallback.

Internal-only API change: external code that constructs CoherenceGate directly must drop `apiKey` from the options bag and supply `intelligence`.

The anthropic-interactive-pool adapter now accepts an optional `llmFallback` in its config. The empty-prompt canary (Rule 3 detector for the pool's idle signal) had a tested LLM-fallback contract but no application-layer wiring — that's now plumbed end-to-end. Adapter clients can opt in by passing `buildCanaryLlmFallback(intelligence)`; omitting it preserves deterministic-only behavior.

Phase 5c shipped: `CostAwareRoutingPolicy` and `CostStateTracker` in `src/providers/costAwareRouting.ts`. The policy implements the path-constraints "Routing default" (drain SDK credit pot while above the 10% safety margin, switch to subscription floor when at or below). The tracker emits `CostStateSnapshot` objects with a `isMaterialShift` helper Phase 5b consumes to decide when to re-ask the user. Pure additive infrastructure — not yet wired into the runtime; that wiring lands with Phase 5b implementation. 23 unit tests cover every row of the decision matrix and every material-shift category.

Phase 5b.1 shipped: `PreferenceStore` (sqlite-backed cache of framework+model picks keyed by user × task pattern) and `TriggerGate` (pure-function decision logic implementing Phase 5b's three-trigger rule with priority ordering). Both live under `src/providers/uxConfirm/`. The remaining Phase 5b components — TaskClassifier, TelegramConfirmer, OverrideDetector, and the FrameworkModelRouter composition root — land in subsequent slices.

Phase 5b.2 shipped: `TaskClassifier` and `OverrideDetector` — both fast-tier IntelligenceProvider classifiers under `src/providers/uxConfirm/`. The classifier maps a task prompt to a stable kebab-case slug (the cache key for preferences). The detector spots routing overrides in free-text messages ("use Gemini for this one") via LLM, not regex, per the "intelligence over string matching" rule. Both fail-safe on errors — unclassified slug or no-override outcome — so the UX never silently auto-uses a wrong pick. 33 new unit tests pass (13 classifier + 20 detector, including the 8 phrasing variants the spec required).

Phase 5b.3 shipped: `TelegramConfirmer` — the blocking suggest-and-confirm round-trip. Sends the structured prompt via a thin `ConfirmationTransport` interface (testable without real Telegram), blocks on next reply with timeout, parses replies through four deterministic shorthand paths (`ok|c|👍|no|once|/route reset`) before falling through to the LLM-backed `OverrideDetector` for free-text. Returns a discriminated `ConfirmationResult` (`confirmed | overridden | reset | default-no-reply`). 30 new tests; cumulative uxConfirm coverage now 86 tests.

Phase 5b.4 shipped: `FrameworkModelRouter` — the composition root that ties every Phase 5b component into the full flow. Returns a structured `RouteResult` with eight distinct `source` values covering every outcome (cached-silent, confirmed, confirmed-one-shot, overridden-this-task, overridden-this-pattern, reset-defaulted, auto-defaulted-no-topic, auto-defaulted-no-reply, auto-defaulted-unclassified). Cache writes are scoped strictly to user-confirmed paths. The `CatalogProvider` interface abstracts over Phase 5a artifacts so the router doesn't read markdown directly. 13 router tests; cumulative uxConfirm coverage 99 tests.

Phase 5b.5.c shipped: `instar route <task...>` CLI subcommand — a thin composition root that wires every Phase 5b component (TaskClassifier, OverrideDetector, PreferenceStore, StaticCatalogProvider, CostStateTracker, TelegramConfirmer, FrameworkModelRouter) and runs a single classification. Forces `telegramTopicId: null` so the CLI path is deterministic (no-topic → catalog default). Lets Justin exercise the end-to-end Phase 5b flow against his real IntelligenceProvider (Claude or Codex per `INSTAR_FRAMEWORK`) without standing up the full HTTP/Telegram wiring. AgentServer integration deferred — that wiring touches the massive injected-dependencies constructor and is tracked separately.

Phase 5b.5.b shipped: `TelegramConfirmationTransport` — bridges the push-based `MessagingAdapter.onMessage` contract to the pull-based `ConfirmationTransport.awaitReply` contract Phase 5b.3 requires. Per-topic waiter queue with timeout; supersession (new awaitReply on same topic resolves prior with null); drop-on-no-waiter for stale replies; shutdown resolves all pending. Composable via `MinimalMessagingAdapter` + caller-supplied `topicFromInbound` / `outboundForTopic` — same class drives Slack/iMessage/etc. when those land. 9 new tests against a fake adapter; cumulative uxConfirm coverage 124 tests.

Phase 5b.5.a shipped: `StaticCatalogProvider` — hand-curated CatalogProvider implementation. 20 task-pattern defaults derived from the Phase 5a catalogs (code-generation/refactor/debug → Opus 4.7; web-research → Sonnet 4.6; summarize/draft/shell → Haiku 4.5; etc.) plus per-(framework, model) confidence baselines and a `CATALOG_VERSION` string that drives Phase 5b's re-ask trigger. Hand-curated rather than markdown-parsed: deliberate updates when the catalog moves, not silent drift from regex breakage. 16 new tests; cumulative uxConfirm coverage 115 tests.

Tier 0 release blocker fixed: stripped a hardcoded developer-specific path (`/Users/justin/.asdf/installs/nodejs/22.18.0/bin/codex`) from the Codex adapter default config. Replaced with a new framework-agnostic `detectFrameworkBinary(name)` helper that searches install locations, npm-global, nvm-managed, and PATH for any of eight known framework binaries (claude, codex, gemini, aider, goose, cursor-cli, opencode, plandex). Includes a source-level regression test that fails if any future commit re-introduces the asdf hardcode.

Tier 1.B (multi-provider credentials) landed: new `ProviderCredentialKind` + `ProviderCredential` types, new `SessionManagerConfig.credentials: { [providerId]: ... }` field with legacy `anthropicApiKey` / `anthropicBaseUrl` automatically migrated at load time. New helpers `getProviderCredential(config, providerId)` and `buildProviderEnvFlags(providerId, cred)` give code paths a clean way to ask "do I have a credential for X" and "what env vars do I inject when spawning a subprocess for provider X." SessionManager spawn paths are unchanged in this slice — they still read the legacy field; migration to the helper is a follow-up. 14 tests cover migration, kind detection, baseUrl propagation, lookup fallback, and env-flag building for anthropic/openai/google + unknown-provider safe-no-op.

Tier 1.C (Codex intelligence provider) landed: new `CodexCliIntelligenceProvider` sibling of `ClaudeCliIntelligenceProvider`. Routes evaluate() calls through `codex exec` with tier→model mapping reused from the Codex adapter. Plus a `buildIntelligenceProvider({ framework })` factory that picks the right implementation at startup, and a `frameworkFromEnv()` parser for the new `INSTAR_FRAMEWORK` env var (accepts `claude-code` / `claude` / `codex-cli` / `codex` case-insensitive). Until now `ClaudeCliIntelligenceProvider` was the ONLY implementation, so every reviewer/sentinel/canary ran `claude -p` exclusively — "supports Codex" was a promise we couldn't keep. 10 tests cover framework selection, binary detection fallback, env-var parsing.

Tier 1.D (identity-file rendering) landed: AGENT.md is now the canonical source of truth for an agent's identity. New `IdentityRenderer` module reads `.instar/AGENT.md` and writes framework-specific shadow files (CLAUDE.md for Claude Code, AGENTS.md for Codex, GEMINI.md for Gemini) with an auto-generation banner warning against hand-editing. ProjectMapper lookup priority flipped to AGENT.md first, CLAUDE.md fallback (existing installs keep working). Migration path: `bootstrapAgentMdFromShadow` reads legacy CLAUDE.md content, strips banner, writes canonical AGENT.md. 16 tests cover render, banner content, framework subset, source fallback, throw-on-missing, framework detection, and migration bootstrap.

Tier 2.A (framework-aware boot prerequisite) landed: `Config.load()` no longer throws "Claude CLI not found" unconditionally. New pure helpers `resolveConfiguredFramework()` (picks active framework from config / INSTAR_FRAMEWORK env / default claude-code) and `checkFrameworkPrerequisite()` (validates the configured framework's binary is installed) decouple boot logic from Claude. Codex-cli installs now boot cleanly with only the codex binary present. Error messages are framework-specific with the right install command. New `sessions.framework` config field + `INSTAR_FRAMEWORK` env var (accepts claude-code/claude/codex-cli/codex). 11 tests cover every framework × binary-presence combination.

## What to Tell Your User

<!-- Write talking points the agent should relay to their user. -->
<!-- This should be warm, conversational, user-facing — not a changelog. -->
<!-- Focus on what THEY can now do, not internal plumbing. -->
<!--                                                                    -->
<!-- PROHIBITED in this section (will fail validation):                 -->
<!--   camelCase config keys: silentReject, maxRetries, telegramNotify -->
<!--   Inline code backtick references like silentReject: false        -->
<!--   Fenced code blocks                                              -->
<!--   Instructions to edit files or run commands                      -->
<!--                                                                    -->
<!-- CORRECT style: "I can turn that on for you" not "set X to false"  -->
<!-- The agent relays this to their user — keep it human.              -->

- **[Feature name]**: "[Brief, friendly description of what this means for the user]"

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| [Capability] | [Endpoint, command, or "automatic"] |

## Evidence

<!-- REQUIRED if this release claims to fix a bug. -->
<!-- Unit tests passing is NOT evidence. Provide ONE of: -->
<!--   (a) Reproduction steps + observed before/after on a live system. -->
<!--       Include log excerpts, observed command output, or behavior -->
<!--       description. Make it specific enough that a future reader can -->
<!--       re-run it and see the same thing. -->
<!--   (b) "Not reproducible in dev — [concrete reason]" if the failure -->
<!--       mode truly can't be exercised locally (race conditions, -->
<!--       event-driven paths requiring external signals, etc). -->
<!--                                                                 -->
<!-- If this release doesn't claim a bug fix (pure feature / refactor), -->
<!-- leave this section blank or delete it — it's only enforced when -->
<!-- "What Changed" describes a fix. -->

[Describe reproduction + verified fix, OR "Not reproducible in dev — [concrete reason]"]
