# Side-Effects Review — Provider-Substrate Live Wiring (June-15 readiness PR 1)

**Version / slug:** `provider-substrate-live-wiring`
**Date:** `2026-06-05`
**Author:** `echo (Claude Opus)`
**Second-pass reviewer:** `5-agent verification panel (build Phase 3, LARGE)`

## Summary of the change

Wires the already-built provider substrate into production: registers both
Anthropic adapters with the providers registry at server boot (gated,
idempotent, lazy), plumbs a real TTL-cached SDK-credit reader into the
CostAwareRoutingPolicy (replacing the `() => null` stub), and adds an
opt-in `intelligence.subscriptionPath` mode (`off`/`auto`/`force`) that
routes the internal-intelligence funnel between `claude -p` (SDK-credit
path) and the interactive REPL pool (subscription floor) per spec 04
Rule 1. Files: `src/providers/bootRegistration.ts` (new),
`src/core/InteractivePoolIntelligenceProvider.ts` (new),
`src/core/AnthropicSubscriptionRouter.ts` (new),
`src/providers/costAwareRouting.ts` (decision extracted to shared pure fn),
`src/providers/adapters/anthropic-interactive-pool/{config,pool}.ts`
(model knob), `src/core/intelligenceProviderFactory.ts` (option),
`src/core/types.ts` (config type), `src/commands/server.ts` (boot+shutdown
wiring), `src/server/routes.ts` (GET /providers/registry).

## Decision-point inventory

- `registerAnthropicAdapters` gates (claudeForbidden, enabledFrameworks) — add — refuse Claude adapters on codex-only agents
- `decideSdkVsSubscription` (extracted) — modify (refactor, semantics identical, existing tests pass) — SDK-pot vs subscription threshold
- `AnthropicSubscriptionRouter.evaluate` mode branch — add — off/auto/force routing of internal LLM calls
- `buildIntelligenceProvider` claude-code case — modify — wraps with router ONLY when the new option is passed; otherwise byte-identical
- shutdown pool dispose — add — kills pool tmux sessions at server stop
- `GET /providers/registry` — add — read-only introspection

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

In `force` mode, a pool outage (tmux missing, spawn failure) makes internal
LLM calls fail even though `claude -p` would have worked — by design (force
mode's contract is zero `claude -p` traffic), and loudly. Fleet default is
`off`, so nobody is exposed without an explicit flip. The codex-only gate
refuses registration on codex-only agents — correct, mirrors the existing
ClaudeCliIntelligenceProvider guard. No other block/allow surface.

## 2. Under-block

**What should be rejected but passes?**

`auto` mode falls back across paths on ANY primary error, including
prompt-shaped errors (e.g. timeout from an oversized prompt) where the
retry will likely fail again — one wasted call, bounded (exactly one
fallback attempt, then a loud throw). The pool's `--dangerously-skip-
permissions` spawn means a prompt-injected judgment call could in principle
invoke tools inside the pool session; mitigated by the empty scratch
workdir and unchanged from the adapter's prototyped+parity-tested shape;
hardening is tracked in the spec (CMT-1105).

## 3. Level-of-abstraction fit

Registration lives in `src/providers/` (substrate layer), the two
IntelligenceProvider implementations in `src/core/` next to their peers,
and the mode wiring at the composition root (server.ts) — matching the
existing layering (IntelligenceRouter precedent). The threshold logic was
EXTRACTED to one shared pure function rather than duplicated across the
two routing layers.

## 4. Signal vs authority compliance

The router treats config (`mode`) as authority and credit snapshots as
signal: unknown signal degrades conservatively (subscription floor), never
blocks the call path. onRoute/onDegrade are observability taps with no
authority. No LLM judgment gates any decision here — all routing is
deterministic from config + credit state.

## 5. Interactions

- **Circuit breaker**: router sits INSIDE the breaker wrap — a rate-limit
  on the surviving path still trips the account-global breaker. Unchanged
  for mode off.
- **Per-component IntelligenceRouter**: claude-code builds inherit the same
  subscriptionPath option, so codex-default agents with claude-routed
  components stay consistent.
- **/metrics/features**: pool-served calls still attribute calls+latency;
  token columns read 0 (pool reports no per-call usage; onUsage is
  deliberately not invoked with fake zeros).
- **SessionReaper/tmux tooling**: pool sessions are named `instar-pool-*`;
  they are adapter-managed (maxIdle 30m, maxMessages 50, dispose at
  shutdown). Reaper does not manage them (they are not instar sessions in
  the session store).
- **QuotaTracker**: unaffected — file-based scheduler shedding stays as-is.

## 6. External surfaces

`GET /providers/registry` (Bearer-authed like its router peers) returns
adapter ids + capability flag names + a policy-installed boolean. No prompt
content, no credentials; integration test asserts no key-material shapes in
the payload. The usage-meter call (`/api/oauth/usage`) is the EXISTING
read-only observability exception under spec 04 Rule 2, now TTL-cached
(60s) so routing volume cannot hammer it.

## 7. Rollback cost

Mode is config-gated default-off: rollback = remove the config key (or set
`off`) + restart — no data, no state, no migration. Registration itself is
inert without the mode (lazy pool, no spawns). Worst-case orphan: pool tmux
sessions if the server dies UNgracefully mid-soak; bounded by poolSize
(default 2) and visible via `tmux ls` (`instar-pool-*`).

## Conclusion

Ship. Default-off + pinned-argv invariance test means zero fleet behavior
change at merge; the June-15 lever becomes a config flip backed by 44 new
tests across all three tiers.

## Second-pass review (if required)

Build Phase 3 runs the 5-agent verification panel (LARGE build) before
commit; findings folded back into code/spec before the convergence tag.

## Evidence pointers

- Unit: `tests/unit/providers/bootRegistration.test.ts`,
  `tests/unit/anthropic-subscription-router.test.ts`,
  `tests/unit/intelligence-provider-factory-subscription-path.test.ts`,
  `tests/unit/providers/adapters/anthropic-interactive-pool/pool-model-flag.test.ts`
- Integration: `tests/integration/providers-registry-route.test.ts`
- E2E: `tests/e2e/provider-substrate-live-wiring.test.ts`
- Spec: `docs/specs/provider-substrate-live-wiring.md` (+ `.eli16.md`)
- Live exposure measurement driving the work: /metrics/features 24h on echo
  (~1,014 real internal calls, ~26.7M tokens-in).

## CI-green follow-up (same PR)

- New side effect: a FAILED boot registration/policy install now emits a
  DegradationReporter event (`serverBoot.anthropicProviderRegistration`) in
  addition to the yellow boot log line — so a dark June-15 routing install is
  visible in the degradation feed, not just scrollback. No behavior change on
  the success path.
- Silent-fallback ratchet lowered 459 → 458 (that catch is now reporter-wired);
  two non-degradation catches carry in-brace `@silent-fallback-ok`
  justifications (raced tmux kill-session; HTTP 500 surfaced to caller).
- `/providers/registry` tracked in the feature-delivery-completeness guard
  (read-surface class, like `/session/clock`; no framework shadow — the lever
  only applies to claude-code internal traffic).
