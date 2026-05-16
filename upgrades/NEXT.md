# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

CoherenceReviewer subclasses and CoherenceGate dropped the unused `apiKey` constructor parameter — dead since the Rule 2 path-constraint lockdown removed the direct-Anthropic-API fallback. Reviewer LLM calls already route exclusively through the IntelligenceProvider; the key was being stored but never read.

CoherenceGate now requires an IntelligenceProvider. When none is wired, the response review pipeline is disabled with a warning instead of attempting a raw API fallback.

Internal-only API change: external code that constructs CoherenceGate directly must drop `apiKey` from the options bag and supply `intelligence`.

The anthropic-interactive-pool adapter now accepts an optional `llmFallback` in its config. The empty-prompt canary (Rule 3 detector for the pool's idle signal) had a tested LLM-fallback contract but no application-layer wiring — that's now plumbed end-to-end. Adapter clients can opt in by passing `buildCanaryLlmFallback(intelligence)`; omitting it preserves deterministic-only behavior.

Phase 5c shipped: `CostAwareRoutingPolicy` and `CostStateTracker` in `src/providers/costAwareRouting.ts`. The policy implements the path-constraints "Routing default" (drain SDK credit pot while above the 10% safety margin, switch to subscription floor when at or below). The tracker emits `CostStateSnapshot` objects with a `isMaterialShift` helper Phase 5b consumes to decide when to re-ask the user. Pure additive infrastructure — not yet wired into the runtime; that wiring lands with Phase 5b implementation. 23 unit tests cover every row of the decision matrix and every material-shift category.

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
