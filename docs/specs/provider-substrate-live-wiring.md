---
title: Provider-Substrate Live Wiring — June-15 Interactive-Only Readiness (PR 1)
status: built
created: 2026-06-05
owner: echo
parent-spec: specs/provider-portability/04-anthropic-path-constraints.md
parent-principle: "Framework-Agnostic — and Framework-Optimizing"
eli16-overview: provider-substrate-live-wiring.eli16.md
review-convergence: "2026-06-05T21:40:00Z"
approved: true
approved-by: "Justin (topic 9984, 2026-06-05 — directive to make SURE Instar runs purely on Claude interactive-session-only mode by June 15; implements his 2026-05-15-locked spec 04 Rule 1 + routing default)"
approved-date: "2026-06-05"
---

# Provider-Substrate Live Wiring (June-15 readiness, PR 1)

**Driving authority:** `specs/provider-portability/04-anthropic-path-constraints.md`
(Rule 1 + the routing default, locked + approved by Justin 2026-05-15) and
Justin's directive 2026-06-05 (topic 9984): *"I want to make SURE that Instar
can run purely on the Claude 'interactive session only' mode"* before the
2026-06-15 Agent SDK credit change. Tracked as **CMT-1105**.

## Problem

The provider-portability substrate (both Anthropic adapters, the parity
suite, the cost-aware routing policy) shipped on main 2026-05-18 — but the
production wiring never landed. The boot code installed the routing policy
with a literal `readSdkCredit: () => null` stub and registered **zero
adapters** ("adapter-registration at startup is tracked as a separate
cycle"). Meanwhile the live internal-LLM funnel (`buildIntelligenceProvider`
→ `ClaudeCliIntelligenceProvider`) hardcodes `claude -p` — measured ~1,000
real internal calls / ~27M input tokens per 24h on echo alone. Post-June-15
that traffic bills the $200/month Agent SDK pot, and when the pot drains
those calls FAIL; nothing reroutes them. Rule 1 ("every code path must be
able to fall back to the subscription path") was designed but not
operational.

## What this PR ships

1. **`src/providers/bootRegistration.ts`** — `registerAnthropicAdapters()`:
   - Gated: process-level `claudeForbidden` + `enabledFrameworks` (codex-only
     agents register nothing; unset defaults to `['claude-code']`, the
     historical reading).
   - Idempotent: re-entry reports `alreadyRegistered`, never double-registers.
   - Lazy: construction/registration spawns NOTHING (the pool spawns tmux
     REPLs on first use). Boot time unaffected.
   - `buildReadSdkCredit()`: TTL-cached (60s) reader of the headless
     adapter's UsageMeterProvider → `agentSdkCredit ?? null`. Errors → null
     (unknown state), never a throw into a routing decision.
2. **Server boot wiring** (`src/commands/server.ts`): registration runs at
   the Phase-5 policy-install site; `CostAwareRoutingPolicy` now receives the
   real credit reader instead of the null stub; the interactive-pool adapter
   is disposed on shutdown (kills its tmux sessions; lazy no-op when never
   spawned).
3. **`intelligence.subscriptionPath` config** (`mode: 'off' | 'auto' | 'force'`,
   default **off** = absent):
   - `off`: byte-for-byte today's behavior. The factory unit test pins the
     exact `claude -p` argv so drift is a test failure.
   - `auto`: per-call decision via the shared pure function
     `decideSdkVsSubscription` (extracted from `CostAwareRoutingPolicy` so
     the two routing layers cannot drift): credit unknown/at-margin →
     subscription pool; healthy → drain the SDK pot first (the locked
     routing default). One cross-path fallback on primary failure, reported
     through DegradationReporter.
   - `force`: subscription pool ONLY, zero `claude -p` traffic, loud
     failures, deliberately no SDK fallback — the soak / June-15 emergency
     lever.
4. **`InteractivePoolIntelligenceProvider`** (`src/core/`) — the
   IntelligenceProvider face of the pool's OneShotCompletion. Honest about
   pool limits: per-call `model` is advisory (one model per pool, set at
   spawn); `onUsage` is never invoked (the REPL reports no per-call tokens;
   zeros would corrupt the ledger — absent is honest).
5. **`AnthropicSubscriptionRouter`** (`src/core/`) — the mode logic above,
   sitting INSIDE the circuit-breaker wrap and BELOW the per-component
   IntelligenceRouter (framework routing decides claude-vs-codex first; this
   decides WHICH Claude path). The per-component router's claude-code builds
   inherit the same option, so a component routed to Claude under a codex
   default still honors the decision.
6. **Pool `model` knob** (`InteractivePoolConfig.model` /
   `INTERACTIVE_POOL_MODEL`) — `--model` at session spawn. The intelligence
   pool defaults to `haiku` so high-volume judgment calls don't draw the
   subscription's large-model quota.
7. **`GET /providers/registry`** — real-registry introspection (adapter ids +
   capability flag names + policy-installed flag; no prompt content, no
   credentials). The "is it actually alive" surface.
8. **Pool scratch workdir** — intelligence-pool sessions run in
   `<stateDir>/intelligence-pool/` (created at boot): context decontamination
   (no project CLAUDE.md / MCP servers leak into judgment prompts; parity
   with `--setting-sources user` on the `-p` path) and local blast-radius
   limiting.
9. **Agent Awareness + Migration Parity** — the CLAUDE.md template
   (`generateClaudeMd`) gains an "Anthropic Subscription-Path Routing"
   capability block (the registry route + the mode lever + proactive
   triggers), and `migrateClaudeMd()` backfills existing agents
   (content-sniffed on `/providers/registry`).

## Pool lifecycle hardening (from the 5-reviewer verification round)

The review made the pool production-grade, not just reachable:
- **poolSize validation** — zero/negative/NaN refused loudly at construction
  (boot-time debuggability instead of every allocate silently waiting out
  its timeout).
- **Idle retirement implemented** — `maxIdleMinutes` was dead config: no
  code ever read it, so an idle agent held warm REPLs (and their stale
  context) forever. A 60s sweep now retires ready sessions past the idle
  cutoff WITHOUT respawn; `allocate()` grows the pool back on demand
  (waiter enqueued before the spawn kick, so a fast spawn can't miss it).
- **Orphan recovery** — a crashed process (SIGKILL/OOM) never runs
  dispose(), so its REPLs survived and accumulated across restarts.
  `start()` now kills stale sessions matching the pool's own prefix.
  Prefixes are AGENT-SCOPED (`instar-pool-<projectName>` from the server
  wiring) so one agent's recovery can never reap another agent's live pool.
- **Concurrent-registration single-flight** — `registerAnthropicAdapters`
  had a get-then-register TOCTOU; concurrent boots now share one in-flight
  registration per registry instance.

## Decision boundaries (each tested on both sides)

| Boundary | Side A | Side B |
|---|---|---|
| claudeForbidden gate | skipped, nothing registered | registered |
| enabledFrameworks | codex-only → skip | claude-code/unset → register |
| idempotency | first call registers | second call reports already |
| mode | off → plain provider, pinned argv | auto/force → router wrap |
| credit state (auto) | null/at-margin → pool | healthy → `claude -p` |
| primary failure (auto) | fallback + degrade report | both fail → loud throw |
| force mode | pool serves | pool failure → loud throw, NO sdk fallback |

## Safety / STRIDE notes

- **DoS**: pool size is bounded (default 2) with a 60s allocate timeout —
  a sentinel storm queues and times out loudly rather than spawning
  unboundedly.
- **Cost tampering**: the force switch selects only between the two ALLOWED
  paths; the raw-API ban (Rule 2) is untouched and still lint-enforced.
- **Elevation**: pool sessions keep the adapter's proven spawn shape
  (`--dangerously-skip-permissions`, prototype + parity-tested readiness
  detection). Mitigation: the scratch workdir above. Hardening the pool
  spawn to a no-skip-permissions shape needs its own readiness-detection
  validation and is owned by CMT-1105's remaining arc <!-- tracked: CMT-1105 -->.
- **Info disclosure**: `/providers/registry` returns names only; integration
  test asserts no key material shapes in the payload.
- **Repudiation**: every routing decision passes the `onRoute` tap
  (transition-only logging at the server) and degrades pass
  DegradationReporter — June-15 incidents are debuggable.

## Explicitly NOT in this PR (remaining arc, owned by CMT-1105)

- Headless job/A2A spawn rerouting to interactive sessions
  <!-- tracked: CMT-1105 -->.
- The 24h forced-subscription soak on echo (config flip + observation), and
  the fleet `auto`-mode default decision that depends on its results
  <!-- tracked: CMT-1105 -->.
- Pool permission-hardening and per-call model selection (model-keyed
  sub-pools) <!-- tracked: CMT-1105 -->.
- The legacy direct `new ClaudeCliIntelligenceProvider` fallback callsites
  (server.ts relationship/summarizer fallbacks, reflect.ts) — they keep
  today's path; routing them through the funnel is part of the same arc
  <!-- tracked: CMT-1105 -->.

## Rollout

- Fleet default: `off` — no behavior change anywhere until a config flip.
  This deliberately deviates from the developmentAgent dark-feature gate
  (auto-on for echo): re-routing the entire internal-LLM funnel is
  high-blast-radius, so echo's flip to `auto`/`force` is the deliberate,
  watched soak step of the arc rather than a merge side effect
  <!-- tracked: CMT-1105 -->.
- No config migration needed: absence = off = today's behavior (the same
  pattern as `intelligence.circuitBreaker` defaults).
- Restart applies: config is read at boot, consistent with the documented
  "Applying config & hook changes to running sessions" semantics.

## Verification map (truths → tests)

- T1 alive: `tests/e2e/provider-substrate-live-wiring.test.ts` (route 200 +
  both ids) and `tests/integration/providers-registry-route.test.ts`.
- T2 real credit reader: `tests/unit/providers/bootRegistration.test.ts`
  (snapshot mapping, null-on-error, TTL caching).
- T3 pool serves forced calls: e2e force-mode test +
  `tests/unit/intelligence-provider-factory-subscription-path.test.ts`.
- T4 default invariance: factory test pins the exact `claude -p` argv.
- T5 codex-only untouched: bootRegistration unit gate tests + e2e Phase 4.
- T6 loud failures: router unit tests (force-mode throw, both-paths-fail).
- T7 lazy boot: bootRegistration no-spawn unit test + e2e no-tmux/claude
  assertion.
