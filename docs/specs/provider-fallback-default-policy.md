# Provider-Fallback Default Policy — internal components run off Claude by default

**Status:** draft (pre-convergence)
**Author:** echo
**Commitments:** CMT-1554, CMT-1555
**Origin directive (Justin, 2026-06-15):** "All gates, sentinels, and internal
components run on Codex BY DEFAULT, with an ordered fallback chain
Codex → PI → Gemini → … → Claude Code (last resort). Only among providers
actually active in the agent. The user can configure/override per-component or
per-category."

---

## 1. Problem

Tonight's whole instability cascade had one root: Instar's internal background
LLM calls (sentinels, gates, extractors, reflectors) run on **Claude by default**.
When Claude's API wobbles (transient fetch errors, broad throttle) or an account
walls on weekly quota, those background calls slow or fail — and because the
outbound tone-gate is one of them, *message delivery itself* stalled for ~1 hour.
A single provider's bad night strangled the agent.

The fix the operator approved: get internal/background LLM load **off Claude by
default**, onto Codex, with an ordered fallback so no single provider outage can
strangle the agent again. Claude becomes the *last* resort for background work,
not the first.

## 2. What already exists (do NOT rebuild)

The **fallback ENGINE is already built and shipped** in
`src/core/IntelligenceRouter.ts` (per-component-framework-routing, B1):

- `ComponentFrameworksConfig` supports `default`, per-`categories`, per-component
  `overrides`, and **`failureSwap: IntelligenceFramework[]`** — an ordered list of
  frameworks to try when a safety-gating call's primary provider FAILS at runtime
  (rate-limit / circuit-open / error), before the caller falls closed.
- Each non-default framework gets its **OWN circuit breaker** (a Claude trip can't
  pause Codex).
- The `failureSwap` loop in `evaluate()` already **skips a target whose binary is
  missing** (`resolveProvider(target)` returns null → `continue`) and **skips a
  target whose circuit is open** (throws → caught → next), re-throwing the original
  error only if EVERY target is down (gating caller fails closed — never silent
  brittle degrade).
- Config is read **live on every call** (`resolveConfig`), so changes are hot — no
  restart, no session-start staleness.
- Routing is **scoped to `attribution.gating === true`** for the swap, keeping the
  herd tiny (non-gating calls just propagate to their existing heuristic).

**Conclusion:** we are NOT building a fallback mechanism. We are adding the
**default POLICY** that turns the engine on out-of-the-box, plus the
**active-provider-filtered primary selection** the engine does not yet do.

## 3. The actual gap

Two gaps, one of them real logic:

### 3.1 No shipped default (config gap)
`config.sessions.componentFrameworks` ships **undefined** ⇒ the router delegates
straight to Claude. Nothing routes to Codex unless an operator hand-edits config.
The directive is for this to be the **shipped default**.

### 3.2 Static primary degrades to Claude, not down the chain (logic gap — the real work)
The engine resolves the **primary** from a STATIC `default`/`categories`/`overrides`
value. If that static primary's binary is missing, the unavailable-primary branch
degrades to **`defaultFramework` (Claude)** — NOT to the next link in the chain.

So a naive `default: 'codex-cli'` gives the wrong behavior on an agent that has PI
but not Codex: it routes to **Claude**, not PI. That violates "Codex → PI → Gemini →
Claude **among active providers**."

The missing piece is **active-provider-filtered primary selection**: choose the
primary as the **first ACTIVE framework** in the preference chain, and make the
remaining active frameworks the `failureSwap` tail.

## 4. Design

Keep the engine untouched. Add a thin **policy resolver** that computes the
effective `componentFrameworks` from a preference chain + the set of active
frameworks, and wire it as the default when the operator has not set their own.

### 4.1 The preference chain (the policy)
```
INTERNAL_FRAMEWORK_PREFERENCE = ['codex-cli', 'pi-cli', 'gemini-cli', 'claude-code']
```
Applies to the **internal** component categories: `sentinel`, `gate`, `job`,
`reflector`. NOT to `other` (leave on the agent default) and NEVER to spawned
interactive sessions (those stay on `topicFrameworks` — out of scope, unchanged).

### 4.2 Active-provider filtering
Filter the preference chain to frameworks that are **active in this agent**:
- A framework is active iff its provider can be built (binary present/installed)
  AND it is not explicitly disabled by the operator.
- **DESIGN QUESTION (resolve in convergence):** what is the authoritative
  "active framework" probe at boot? Candidates:
  (a) reuse the same `buildProvider(fw) !== null` truth the router already uses
      (most honest — it's exactly what the runtime will see), computed once at boot;
  (b) a lighter `which <cli>` existence probe.
  Leaning (a): single source of truth, no second notion of "available" that can
  drift from the router's. Cost is one build per framework at boot (already cached).

Effective config (when the operator has NOT set `componentFrameworks`):
```
const active = INTERNAL_FRAMEWORK_PREFERENCE.filter(isActive);
// e.g. active = ['codex-cli','gemini-cli','claude-code'] (no PI installed)
componentFrameworks = {
  categories: { sentinel: active[0], gate: active[0], job: active[0], reflector: active[0] },
  failureSwap: active.slice(1),   // ['gemini-cli','claude-code']
  fallback: 'default',
};
```
- If `active === ['claude-code']` only (no off-Claude provider installed):
  the effective config is a **no-op** — primary = claude, empty swap — i.e.
  **byte-identical to today**. An agent with nothing but Claude is never made
  worse, never spammed with per-call degrade reports.
- `claude-code` stays the **tail** of `failureSwap` so it remains the true last
  resort (matches the directive), not absent.

### 4.3 Operator override (precedence)
If `config.sessions.componentFrameworks` is **explicitly set**, use it verbatim —
do NOT merge the default into it. The operator's config is total authority
(directive: "the user can configure/override"). A per-component `overrides` entry
or a per-category value the operator wrote always wins. Document this clearly.

### 4.4 Where the resolution happens
At the router construction site in `server.ts` (~line 4687): if
`config.sessions.componentFrameworks` is unset, pass a `resolveConfig` that returns
the **computed effective config** (memoized; active-set computed once at boot). If
it is set, pass it through unchanged (today's behavior). This keeps the live-read
semantics: a later operator edit that sets `componentFrameworks` overrides the
default on the next call.

## 5. Migration parity (REQUIRED — existing agents)

This is a behavior change to every deployed agent, so it MUST reach existing
installs, not just `init`:
- **No config-file write needed** if the default is computed at runtime from an
  unset `componentFrameworks` (preferred — zero migration risk, always reflects the
  currently-installed providers). The "migration" is purely the new code shipping.
- `migrateConfig()`: do NOT write a frozen `componentFrameworks` block into existing
  configs (that would pin a stale active-set). Leave it unset so the runtime
  resolver stays live. Add only a documented comment/no-op if needed.
- **Decision for convergence:** runtime-computed default (no persisted block) vs.
  one-time migrated block. Leaning runtime-computed — it self-heals when the
  operator later installs/removes a provider CLI.

## 6. Safety analysis

- **Fail-closed preserved:** the engine already re-throws when every swap target is
  down, so a gating caller still fails closed (never silent brittle heuristic). The
  default policy only changes WHICH providers it tries first.
- **No herd:** swap is gating-scoped + per-framework-breakered (unchanged).
- **Claude-only agents unaffected:** §4.2 no-op guarantee.
- **The tone-gate (the thing that broke tonight):** is it `attribution.gating`?
  **VERIFY in build** — if the outbound tone-gate is not flagged gating, the swap
  won't fire for it and tonight's exact failure recurs. If it isn't flagged, flag
  it (it gates message delivery — it is safety-gating by definition). This is the
  single most important wiring check in the whole change.
- **Observability:** every swap/degrade already routes through `onDegrade` →
  `DegradationReporter` and the per-feature LLM metrics (`/metrics/features` shows
  `frameworks`/`models` actually serving each component). The operator can SEE that
  sentinels now run on Codex.

## 7. Test plan (all three tiers — non-negotiable)

- **Unit** (`tests/unit/`):
  - `resolveInternalFrameworkDefault`: chain `[codex,pi,gemini,claude]` × various
    active-sets → correct `{categories, failureSwap}`; claude-only → no-op; codex
    missing → primary=pi (not claude); empty active → no-op.
  - operator-set `componentFrameworks` passed through unchanged (override wins).
  - router `evaluate()` with the computed default: primary down → swaps down the
    chain in order; all down → re-throws (fail-closed). (Engine tests exist; add
    the default-policy-resolved-config cases.)
- **Integration** (`tests/integration/`): `GET /intelligence/routing` reflects the
  computed default (sentinel/gate → first active off-Claude framework, `available`
  true) on an agent with codex; reflects no-op on a claude-only agent.
- **E2E** (`tests/e2e/`): production init path → the router is constructed with the
  default policy live; a gating component resolves off Claude when codex is active;
  feature is ALIVE (not 503).
- **Wiring-integrity:** the tone-gate is `attribution.gating` and routes through the
  router (the regression guard for tonight's incident).

## 8. Agent-awareness (CLAUDE.md template)

Update `generateClaudeMd()`: the "Per-Component Framework Routing" section gains the
new DEFAULT behavior ("internal components run off Claude by default via the
active-filtered chain Codex→PI→Gemini→Claude; override via
`sessions.componentFrameworks`"), and the proactive trigger ("user hits Claude rate
limits / 'why are my sentinels on Codex?'" → explain the default + how to override).

## 9. Rollout

- Ships **enabled by default** (this is the whole point — a dark default would not
  fix the problem). BUT the no-op guarantee (§4.2) means it is inert on agents
  with no off-Claude provider, so the blast radius is only agents that HAVE codex/
  pi/gemini installed — i.e. agents that can benefit.
- Rollback lever: operator sets `componentFrameworks: {}` (explicit empty) ⇒
  everything back on the agent default framework. Document this.
- Dogfood on echo (codex active) first; verify `/intelligence/routing` +
  `/metrics/features` show sentinels on codex before relying on it.

## 10. Open questions (for convergence)

1. Active-provider probe: router `buildProvider` truth (a) vs. `which` (b)? (§4.2)
2. Runtime-computed default vs. one-time migrated block? (§5)
3. Is the outbound tone-gate flagged `attribution.gating`? (§6 — the load-bearing
   regression check)
4. Should `job` category be in the internal set, or only `sentinel`+`gate`+
   `reflector`? (Jobs can be heavy; running them on codex by default may be desired
   or may surprise — decide.)
5. Per-framework model-size preservation: a `fast` check must stay `fast` (Haiku on
   Claude / small model on Codex). Confirm the factory already preserves size
   across the swap (it should — `model` size is orthogonal to framework).
