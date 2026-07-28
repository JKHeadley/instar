---
title: "Per-component framework routing — run different Instar components on different agentic frameworks (Codex sentinel-offload)"
date: 2026-06-03
author: echo
parent-principle: "Structure beats Willpower — routing is a structural config decision resolved at the single LLM funnel, not something any of 38 call sites must remember"
review-convergence: internal-adversarial-plus-integration-2026-06-03
review-iterations: 1
review-completed-at: 2026-06-03
approved: true
approved-by: Justin
approved-via: "Telegram topic 18423 (2026-06-03) — blanket preapproval for the Resource Limitation Mitigation workstream, plus explicit approval of this task ('That sounds good') and confirmation it goes through spec-convergence (Tier 2). Design converged via adversarial + integration review (1 round) which corrected the breaker-isolation and resolution-point design; see Convergence Report below."
eli16-overview: per-component-framework-routing.eli16.md
---

# Per-component framework routing

## The principle

An Instar agent should be able to run **different internal LLM-driven components on
different agentic frameworks** — e.g. Echo's user-facing conversation on Claude Code,
but ALL of Echo's sentinels and gates on Codex. The motivating pain: Echo keeps hitting
**Claude rate limits**, and a large share of Claude LLM calls are NOT the conversation —
they are the many small judgment calls made by sentinels/gates (PresenceProxy,
PromiseBeacon, MessageSentinel, CoherenceReviewer, MessagingToneGate, the reflectors,
etc.). Moving that chatter onto Codex frees Claude quota directly. This is the
**mitigation** half of the Resource-Limitation workstream.

## What already exists (grounded audit 2026-06-03 — CORRECTED by convergence)

- `IntelligenceProvider` interface — one `evaluate(prompt, opts)` (`src/core/types.ts:650`).
- Three complete providers: `ClaudeCliIntelligenceProvider`, `CodexCliIntelligenceProvider`,
  `GeminiCliIntelligenceProvider`. Codex spawns `codex exec --model …` in a clean scratch dir.
- Factory `buildIntelligenceProvider({ framework })` (`src/core/intelligenceProviderFactory.ts:67`)
  — returns `null` (never throws) on a missing binary; boot wraps it in try/catch
  (`src/commands/server.ts:2959-2973`).
- **Framework-aware model-SIZE tiers exist**: `fast | balanced | capable` → concrete model
  per framework (Claude haiku/sonnet/opus; Codex gpt-5.2/gpt-5.4-mini/gpt-5.5; Gemini
  flash/flash/pro). A `fast` call resolves per-framework; the caller passes SIZE, the
  provider maps it. No call-site change for size.

### Two facts convergence corrected (the original draft was wrong about both)
1. **The circuit breaker is an ACCOUNT-GLOBAL SINGLETON, not per-provider.**
   `CircuitBreakingIntelligenceProvider` defaults its breaker to `getLlmCircuitBreaker()`
   — a process-wide singleton (`LlmCircuitBreaker.ts:442-448`; the class comment literally
   says "account-global … a single shared breaker pauses every LLM-backed feature at once").
   So TODAY a Claude rate-limit trip pauses Codex too. Per-framework isolation is **net-new
   work**, the bulk of this PR — NOT a freebie. (The constructor DOES accept a breaker arg,
   so it's achievable: build one `LlmCircuitBreaker` per framework and inject it.)
2. **The `LlmQueue` is NOT on the provider funnel.** It wraps closures at a few specific
   consumers only (PresenceProxy, PromiseBeacon, CorrectionCapture); most sentinel
   `.evaluate()` calls bypass it entirely, and there are several independent queue instances,
   not one. So "per-framework spend cap on the queue" would cap almost none of the sentinel
   traffic this PR targets. The queue-keying idea is **struck** (see D3).
3. **`attribution.component` is a CALL-TIME literal**, passed inside each component's own
   `evaluate(prompt, { attribution: { component: 'X' } })`. Only ~44 of ~102 call sites set
   it today, and ~half the LLM callers (RelationshipManager via `config.relationships.intelligence`,
   ContextualEvaluator positionally, inline server closures) never receive the
   `sharedIntelligence` constructor injection at all. So routing CANNOT be decided by
   "inject the right provider at construction" — the name doesn't exist at construction time.

## The gap
Framework is **global**: one `_sharedIntelligence` provider built at boot
(`src/commands/server.ts:~2958`), shared by every component, behind one global breaker.

## Design (CORRECTED — resolve at the funnel, per call, against live config)

### D1. Granularity — category-first, per-component override (unchanged)
A new optional config block, default ABSENT → identical to today:
```jsonc
"sessions": {
  "componentFrameworks": {
    "default": "claude-code",
    "categories": { "sentinel": "codex-cli", "gate": "codex-cli" },
    "overrides": { "CoherenceReviewer": "claude-code" },
    "fallback": "default"               // or "none"
  }
}
```
Categories: closed set `sentinel | gate | job | reflector | other`. Resolution order:
`overrides[component] → categories[category] → default`. Keys validated at load (D6).

### D2. RoutingIntelligenceProvider — resolve at the FUNNEL, per call (REWRITTEN)
The single chokepoint every `.evaluate()` already passes through is
`CircuitBreakingIntelligenceProvider.evaluate()`, which already reads
`options.attribution.component`. We introduce a `RoutingIntelligenceProvider` that sits at
that funnel and, **on each call**, reads `attribution.component` + a new optional
`attribution.category` field, resolves the framework via D1 against **live config**, and
dispatches to that framework's pre-built inner provider. Benefits (why this beats the
original construction-time model): (a) one chokepoint, not 18+ hand-threaded edits —
*Structure > Willpower*; (b) automatically covers ALL callers including the config-path and
inline-closure ones; (c) **live config resolution = hot changes** (no session-start-only
staleness trap — a config edit takes effect on the next call, no restart); (d) only needs an
additive `attribution.category?` on `IntelligenceOptions` (component names already flow).
When `componentFrameworks` is absent, the router returns the single existing provider for
every call → **zero behavior change unconfigured**.
- **Attribution coverage gap (B1 deliverable):** a call with no `attribution.component`
  resolves to `default` — so for the sentinels B1 wires to Codex, B1 MUST ensure those call
  sites carry `attribution.component` + `category`. B1 audits + tags the sentinel call sites
  it claims to move; `/intelligence/routing` reports BOTH the configured map AND a coverage
  list (which known components are/aren't tagged) so an untagged-and-thus-still-on-Claude
  sentinel is visible, not silent.

### D3. Per-framework circuit breakers (REWRITTEN — this is the real isolation, and the bulk of the work)
The router owns a `framework → { provider, breaker }` map. Each framework's provider is
wrapped with its **own distinct `new LlmCircuitBreaker()`** (NOT the global singleton), so a
Claude trip leaves the Codex breaker closed and vice-versa — the actual point of the feature.
This requires threading a `breaker` through provider construction (bypassing the
singleton-defaulting `wrapIntelligenceWithCircuitBreaker`/`buildIntelligenceProvider` path
for the router's providers). Downstream `getLlmCircuitBreaker()`/`llmCircuitAvailable()`
consumers (status/health routes, mentor tick) keep using the global breaker for the DEFAULT
framework; the new per-framework breakers are additionally surfaced via
`GET /intelligence/routing` so `/health` isn't blind to a tripped Codex breaker.
- **Spend cap: struck from B1.** The LlmQueue is not on the funnel (corrected fact #2), so
  queue-keying caps the wrong thing. Per-framework SPEND accounting, if wanted, belongs in
  the funnel (where `onUsage` token counts already land) and is deferred to B2. The
  per-framework BREAKER is the rate-limit isolation mechanism that matters for B1.

### D4. Fallback must be circuit-aware (REWRITTEN — avoid the thundering herd)
Naive "degrade every failed Codex call to Claude" creates a synchronized burst onto Claude
the moment Codex limits — strictly worse than the steady baseline. So:
- Distinguish **binary-missing / not-authed** (route fallback to `default` — it's a config/
  install problem, low volume) from **framework rate-limited** (Codex breaker open): in the
  rate-limited case, PREFER the component's own heuristic (sentinels already swallow
  `LlmCircuitOpenError` and fall back to heuristic — `CircuitBreakingIntelligenceProvider`
  docstring) rather than herding onto Claude.
- Pre-flight: wire the existing `/codex/usage` reader (`codexRateLimitReader.ts`) so the
  router can decline to push NEW sentinel volume to Codex when its secondary window is
  near-exhausted (degrade-to-heuristic, report).
- Every degrade emits a `DegradationReporter` event (no silent fallback — ties to Task 1's
  re-armed gate). `fallback: "none"` opts into strict erroring. A routing/config choice
  NEVER hard-fails a sentinel.

### D5. Model size stays orthogonal (unchanged)
Components pass `options.model: 'fast'|'balanced'|…` (SIZE); the chosen framework's provider
maps size→concrete model via the EXISTING tier tables. "A Haiku sentinel on Codex" = size
`fast` + framework `codex-cli` → gpt-5.2, zero call-site change. (`fast`→Codex gpt-5.2,
`balanced`→gpt-5.4-mini; retune in the tier table if `light`→`mini` preferred.)

### D6. Config schema + migration parity + agent-awareness (CORRECTED)
- Add `componentFrameworks` to the `SessionManagerConfig` **TYPE ONLY**. **Do NOT add it to
  `ConfigDefaults`** — `applyDefaults` deep-merges and would inject it into every existing
  config, breaking the "absent → identical to today" promise. Absent-by-default ⇒ no
  migrateConfig entry needed (existence is the guard).
- Validate at load: `categories` keys ∈ the closed category set; `overrides` keys validated
  against the known component-name registry (unknown override key ⇒ loud WARN — a typo'd
  override is a silent misroute); any framework value ∉ `enabledFrameworks` ⇒ fail-fast error.
- **CapabilityIndex:** the new `/intelligence` route prefix MUST get a `CapabilityIndex`
  entry (or an `INTERNAL_PREFIXES` allowlist entry) — an unclassified top-level prefix breaks
  CI exactly as it did on #727. Operator/observability read surface → `INTERNAL_PREFIXES` is
  the closest analogue. Run `instar dev:preflight` in the PR checklist.
- **Boot isolation (cascade-503):** build each framework's provider in its OWN try/catch; a
  missing/unauthed codex binary disables only the codex route + triggers D4, never the
  bootstrap. Non-goal: the router never throws into AgentServer bootstrap.
- Agent-awareness: CLAUDE.md template note ("route sentinels to Codex to spare Claude quota")
  + `GET /intelligence/routing`.
- **Boundary disclaimer:** `componentFrameworks` routes INTERNAL component LLM calls only;
  spawned interactive Telegram-topic sessions remain governed by `topicFrameworks` /
  `resolveTopicFramework`. State this in the spec and the read surface.

## Surfaces
- `GET /intelligence/routing` — read-only: the resolved framework per known component, the
  per-framework breaker states, and the attribution-coverage list. (Internal read surface.)
- Internal: a `RoutingIntelligenceProvider` at the `CircuitBreakingIntelligenceProvider`
  funnel; per-framework provider+breaker map; additive `attribution.category?`.
- Config: `sessions.componentFrameworks` (D1).

## Signal vs authority
**Reference:** docs/signal-vs-authority.md. Providers are SIGNAL; they hold no block/allow
authority. The router only changes WHICH model answers — no new gating surface. The one
safety point (D4): a routing/config choice degrades-and-reports, never hard-fails a sentinel.

## Phasing
- **B1 (this PR):** `RoutingIntelligenceProvider` at the funnel + `componentFrameworks` config
  (type-only) + per-framework distinct breakers + circuit-aware fallback + tag the SENTINEL
  call sites (the user's core ask) + `GET /intelligence/routing` + CapabilityIndex entry +
  3-tier tests + agent-awareness.
- **B2 (follow-up):** extend to gates/reflectors/jobs + per-framework SPEND accounting in the
  funnel + `/codex/usage` preflight polish + a dashboard routing view.

## Test plan (all three tiers — non-negotiable)
- **Unit:** funnel resolves override→category→default per call; **per-framework breaker
  isolation — a tripped Claude breaker leaves the Codex breaker closed** (the key test);
  unconfigured ⇒ returns the single existing provider (zero-change proof); size passthrough
  unchanged; circuit-aware fallback (binary-missing → route to default + DegradationReporter;
  rate-limited → heuristic, NOT herd); unknown category/override key → load-time WARN/error.
- **Integration:** `GET /intelligence/routing` returns the resolved map + coverage + breaker
  states (200) / disabled-shape when off; a config `categories.sentinel=codex-cli` is reflected.
- **E2E:** boot a real AgentServer with `componentFrameworks.categories.sentinel=codex-cli`;
  assert a tagged sentinel call dispatches to the codex-backed provider and the route is alive
  (200, not 503); a missing-codex-binary boot disables only the codex route, server still up.
- **Wiring-integrity:** the router is injected (not null); a `sentinel`-tagged call resolves a
  DIFFERENT inner provider instance than a `default` call when configured.

## Rollback
Pure additive + opt-in. Remove `componentFrameworks` (or revert) → every call routes to the
single shared provider, exactly as today. No persistent state, no data migration.

## Convergence Report (1 round, internal adversarial + integration, 2026-06-03)
Two parallel reviewers (adversarial/security + integration/lessons), both grounded in source.
Material corrections folded in:
- **Breaker is a global singleton, not per-provider** (both reviewers, blocker) → D3 rewritten
  to build distinct per-framework breakers; flagged as the bulk of the work.
- **LlmQueue not on the funnel** (both, blocker) → D3 strikes queue-keying; spend deferred to B2.
- **attribution.component is call-time + ~half callers bypass `sharedIntelligence`** (integration,
  blocker) → D2 rewritten from construction-time injection to funnel-level per-call resolution.
- **Fallback thundering-herd onto Claude under Codex outage** (adversarial, serious) → D4
  rewritten circuit-aware (heuristic-first when rate-limited; /codex/usage preflight).
- **Stale routing under long-lived server** (adversarial, serious) → per-call live-config
  resolution makes config changes hot (no restart, no stale read surface).
- **CapabilityIndex omission would break CI like #727** (integration, serious) → added as a D6
  deliverable.
- **ConfigDefaults deep-merge trap** (integration) → type-only config, no ConfigDefaults default.
- **Key-typo silent misroute** (adversarial) → validate category/override keys at load.
- **Cascade-503** (integration) → per-framework try/catch on provider build.
Residual open item (acceptable, deferred): per-framework SPEND caps (B2). The B1 isolation
mechanism is the per-framework breaker, which the reviewers agree is the right place.
