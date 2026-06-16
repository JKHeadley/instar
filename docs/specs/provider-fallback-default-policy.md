---
title: "Provider-Fallback Default Policy — internal components run off Claude by default"
slug: "provider-fallback-default-policy"
author: "echo"
parent-principle: "No Silent Degradation to Brittle Fallback"
review-convergence: "2026-06-16T02:13:48.963Z"
review-iterations: 4
review-completed-at: "2026-06-16T02:13:48.963Z"
review-report: "docs/specs/reports/provider-fallback-default-policy-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 1
approved: true
approved-note: "Justin full-preapproval for this autonomous run (2026-06-15: 'don't stop and wait for anything; get this done yourself') — same basis as the merged P1/P2/P4 specs."
---

# Provider-Fallback Default Policy — internal components run off Claude by default

**Status:** CONVERGED (4 review rounds; all 6 internal lenses + codex/gemini external + conformance gate)
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
  pause Codex; once a target's breaker is open, `resolveProvider` short-circuits so
  a broadly-rate-limited framework is skipped FAST, not retried slowly).
- The `failureSwap` loop in `evaluate()` (verified at `IntelligenceRouter.ts:193`)
  already **skips a target whose binary is missing** (`resolveProvider(target)`
  returns null → `continue`) and **skips a target whose circuit is open** (throws →
  caught → next), re-throwing the original error only if EVERY target is down
  (gating caller fails closed — never silent brittle degrade).
- Config is read **live on every call** (`resolveConfig`), so changes are hot — no
  restart, no session-start staleness.
- Routing is **scoped to `attribution.gating === true`** for the swap, keeping the
  herd tiny (non-gating calls just propagate the error to their existing heuristic
  — `evaluate()` line 196 re-throws for non-gating, so they never herd onto a
  fallback provider).

**One engine LIMITATION this spec must reckon with (round-1 finding M1):** the
swap loop `await`s each provider's `evaluate()` with **no router-level per-attempt
timeout and no total swap budget**. A slow-but-not-erroring provider is therefore
waited on in full before the swap fires, and a longer chain can stack those waits
in series. The original problem (a slow Claude stalling the tone-gate) could be
*relocated*, not fixed, if the chain is unbounded. §4.5 closes this — it is the
single most important change beyond the default policy.

**Conclusion:** we are NOT building a fallback mechanism. We are adding (1) the
**default POLICY** that turns the engine on out-of-the-box, (2) the
**active-provider-filtered primary selection** the engine does not yet do, and
(3) a **bounded per-attempt swap timeout** so the longer default chain cannot
re-create the very stall it exists to prevent.

## 3. The actual gap

### 3.1 No shipped default (config gap)
`config.sessions.componentFrameworks` ships **undefined** ⇒ the router delegates
straight to Claude. Nothing routes to Codex unless an operator hand-edits config.
The directive is for this to be the **shipped default**.

### 3.2 Static primary degrades to Claude, not down the chain (logic gap — the real work)
The engine resolves the **primary** from a STATIC `default`/`categories`/`overrides`
value. If that static primary's binary is missing, the unavailable-primary branch
degrades to **`defaultFramework` (Claude)** — NOT to the next link in the chain
(`evaluate()` lines 167-182). So a naive `default: 'codex-cli'` gives the wrong
behavior on an agent that has PI but not Codex: it routes to **Claude**, not PI.
That violates "Codex → PI → Gemini → Claude **among active providers**." The
missing piece is **active-provider-filtered primary selection**: choose the primary
as the **first ACTIVE framework** in the preference chain, and make the remaining
active frameworks the `failureSwap` tail.

### 3.3 Unbounded swap latency under the longer chain (engine gap — round-1 M1)
See §2. The longer default chain makes a per-attempt timeout non-optional.

## 4. Design

Keep the engine's routing/breaker logic untouched. Add (a) a thin **policy
resolver** that computes the effective `componentFrameworks` from a preference
chain + the active-framework set, wired as the default when the operator has not
configured their own; and (b) a **minimal, bounded per-attempt timeout** in the
swap loop (§4.5).

### 4.1 The preference chain (the policy)
A single **named, documented constant** (resolves round-1 M10 / the
Framework-Agnostic conformance finding — see §6.5):
```
INTERNAL_FRAMEWORK_PREFERENCE = ['codex-cli', 'pi-cli', 'gemini-cli', 'claude-code']
```
Applies to the **internal, lightweight, high-frequency** categories: `sentinel`,
`gate`, `reflector`. It does **NOT** apply to `job`, `other`, or spawned
interactive sessions:
- **`job` is EXCLUDED** (resolves round-1 M3 / Q4). Routing the `job` category
  off-Claude by default would silently FLIP cost-bearing background jobs — most
  importantly the Cartographer freshness sweep (`CartographerSweep`, a `job`) —
  from "refuse to author" into "author on Codex by default" as a *side-effect of
  this policy*, not an operator decision. A cost-bearing background feature must be
  armed by the operator, never auto-armed by an unrelated default. Jobs stay on the
  agent default framework; an operator who wants jobs off Claude sets
  `categories.job` explicitly.
- **`other`** is left on the agent default (unchanged).
- **Spawned interactive sessions** stay on `topicFrameworks` — out of scope, unchanged.

### 4.2 Active-provider filtering — probe = the router's own truth (resolves Q1)
Filter the preference chain to frameworks **active in this agent**. The authoritative
probe is **`buildProvider(fw) !== null`** — the exact truth the router itself uses
at call time (`providerFor`/`resolveProvider`), computed once at boot. Chosen over a
lighter `which <cli>` probe because:
- It is a **single source of truth** — a second notion of "available" (a bare
  `which`) can drift from what the router actually resolves, and would falsely pass
  a framework whose CLI exists but whose provider can't be built (e.g. `pi-cli`'s
  two-precondition reality: installed AND configured). `buildProvider` captures that.
- Cost is one build per framework at boot (already cached in `this.cache`).

```
const active = INTERNAL_FRAMEWORK_PREFERENCE.filter(fw => isActive(fw));
// e.g. active = ['codex-cli','gemini-cli','claude-code'] (no PI installed/configured)
componentFrameworks = {
  categories: { sentinel: active[0], gate: active[0], reflector: active[0] },
  failureSwap: active.slice(1),   // ['gemini-cli','claude-code']
  fallback: 'default',
};
```
- If `active === ['claude-code']` only (no off-Claude provider): the effective
  config is a **no-op** — primary = claude, empty swap — **byte-identical to today**.
  An agent with nothing but Claude is never made worse, never spammed with per-call
  degrade reports.
- `claude-code` stays the **tail** of `failureSwap` so it remains the true last
  resort (matches the directive), never absent.
- **`pi-cli` is included-if-active and harmless-if-not (resolves round-1 M6):** if PI
  is not wired in the provider factory, `buildProvider('pi-cli')` returns null and the
  active-filter drops it. PI participates only when it genuinely builds. (Validation of
  the chain constant against the known framework enum is a build-time check; an unknown
  framework name fails the unit test, never ships.)

### 4.3 Active-set freshness — HONEST semantics (resolves round-1 M4)
The active-set is computed once at boot. Be precise about what self-heals and what does not:
- **PRIMARY selection is boot-computed.** Installing a *higher-preference* CLI after
  boot (e.g. adding Codex on a Gemini-only agent) does **not** re-pick the primary
  until the next server restart. This is acceptable: installing a provider CLI is a
  rare, deliberate operator act, and a restart to adopt it is reasonable. Documented,
  not silent.
- **The failureSwap TAIL self-heals live.** `resolveProvider(target)` is evaluated
  per call inside the swap loop, so a target whose binary was *removed* after boot is
  skipped live (null → continue). The chain never tries a now-missing provider.

This replaces the earlier blanket "self-heals when the operator installs/removes a
provider CLI" claim, which over-promised for the install direction.

### 4.4 Operator override (precedence) + robust operator-set detection (resolves M5)
If `config.sessions.componentFrameworks` is **explicitly set by the operator**, use it
verbatim — do NOT merge the default into it (directive: "the user can
configure/override"). The detection of "operator-set" is **load-bearing and must not
be foolable**:
- **Snapshot the operator-set boolean ONCE at the router-construction site** (`server.ts:4687`),
  which provably runs **before** the only runtime mutator of this object (`CartographerSweep`'s
  auto-vivify at `server.ts:11266`). The contract is an **ordering one** (round-2 N6): capture
  whether the operator set `componentFrameworks` from the in-memory config value AT CONSTRUCTION
  TIME and never re-read it later — `loadConfig` exposes the value by reference (no separate "raw"
  object), so a snapshot-then-freeze of the boolean at 4687 is what makes it mutation-proof. If
  the resolver instead tested the live object after boot, it would mistake `CartographerSweep`'s
  auto-vivified block for an operator override and silently disable the default policy (round-1 M5).
- **Boot decides default-vs-operator; block contents are live (round-2 N8).** The choice of WHICH
  `resolveConfig` to install (computed-default vs operator's own) is made once at boot from that
  snapshot. Consequence, documented honestly: an operator who **ADDS** a `componentFrameworks`
  block *after* boot needs a server restart for it to take effect (consistent with §4.3's
  boot-computed primary). An operator whose block was already set at boot gets **live-read** edits
  to that block's contents (the engine reads `resolveConfig` live). This is the same restart-to-adopt
  semantics as the active-set; it is stated, not silent.
- Excluding `job` (§4.1) also shrinks this surface: the default no longer writes the
  `job` slot where `CartographerSweep` lives, so the two no longer contend for it.

### 4.5 Bounded per-attempt swap timeout (resolves round-1 M1 — the crux)
The longer default chain makes an unbounded swap loop dangerous (§2). Add a **minimal,
bounded per-attempt timeout** to the swap loop only.

**The per-attempt cap is the universal ceiling (round-2 N2 — corrected basis).** Each swap
attempt (`tp.evaluate()`) races a per-attempt timeout (default **5s** literal, config:
`intelligence.swapAttemptTimeoutMs` — *not* a pre-existing `gateTimeoutMs`, which does not
exist). A provider that is *slow but not erroring* is abandoned at the cap and treated as a
failure → the loop advances to the next target. **Total swap latency = `cap × (1 + activeTail.length)`** —
this cap, applied INSIDE the loop, is the sole guarantee, holding for **all** gating callers
(round-2 grounding: of the 7 gating callers, only InputGuard has its own budget; MessageSentinel
and ExternalOperationGate have none and depend entirely on this cap; the tone-gate's outer route
ceiling is **20s** `OUTBOUND_GATE_REVIEW_BUDGET_MS`, not 5s — the earlier "5s caller budget"
claim was wrong and is removed).
- **The cap must DOMINATE the provider's inner `rateLimitWaitMs` (round-2 N2, load-bearing).**
  `CircuitBreakingIntelligenceProvider.acquireOrWait` honors a `rateLimitWaitMs` (illustratively
  large — on the order of a minute-plus, not a code constant to pin) passed through `options`;
  because the 5s cap RACES the whole `tp.evaluate()` (including that internal wait), it abandons a
  rate-limit-waiting attempt at 5s instead of letting links stack those long waits and blow the 20s
  route budget — i.e. the cap is what actually prevents re-creating
  tonight's stall. Stated explicitly so the build does not "fix" it away.

**Orphaned-attempt safety (round-3 R3-2 — corrected, simpler, reuses shipped primitives).**
Round-2 over-prescribed an `.catch()`/`unref()`/`AbortSignal` mechanism on a mis-grounded crash
premise; round-3 grounding against the live code corrects it:
- **Use `Promise.race([tp.evaluate(), timeoutPromise])` (the codebase's shipped pattern, InputGuard
  precedent).** `Promise.race` attaches a settlement handler to EACH input, so the abandoned
  attempt's later **rejection is already handled** by the race and does NOT become an
  `unhandledRejection` — there is **no crash hazard** with this form (Node-confirmed). A late
  *resolve* is likewise ignored (the loop already advanced). So the elaborate manual `.catch()`/
  `unref()` is unnecessary; the only rule is **use `Promise.race`, never a detached/awaited handle**.
- **Subprocess kill = the providers' EXISTING `timeoutMs → SIGTERM` (no new engine API).** All four
  CLI providers already `execFile` with a `timeoutMs` that SIGTERMs the child on expiry. The swap
  loop passes a tight per-attempt `timeoutMs` (= `swapAttemptTimeoutMs`) into `tp.evaluate()`'s
  options so the provider self-terminates its subprocess at the cap — the cap and the subprocess
  kill are the SAME bound. There is **no `AbortSignal` on `IntelligenceOptions`** (it has no
  receiver) — that round-2 language is dropped.
- **Observability (round-3 R3-4 + conformance "Observability" finding):** a timed-out swap attempt
  emits a distinct `onDegrade({ reason: 'swap-attempt-timeout: <target>' })` so the cap firing is
  visible in `DegradationReporter` + `/metrics/features` — the operator can SEE a slow provider
  being abandoned and tune `swapAttemptTimeoutMs`.
- **Regression test** (§7): a swap target that resolves/rejects AFTER the cap fired must not crash
  (Promise.race form) and must not be used; assert the per-attempt `timeoutMs` is passed through.

**`buildProvider` probe contract (round-2 N5/N7).** The §4.2 active-probe reuses the router's own
`providerFor` cache (`this.cache`) so a framework is built **at most once** at boot, never
double-built for the probe. `buildProvider` is contractually **idempotent, non-networking, and
non-spawning beyond minimal CLI-existence detection**, safe to call once per framework at boot;
if a future provider needs heavier construction, a dedicated `canBuildProvider`/`probeProvider`
predicate is added rather than abusing `buildProvider`.

This is the ONE engine touch in this change. It is justified: the engine's no-timeout swap was
safe with a 1-link tail but is not with a 3–4-link default chain. The timeout is fail-open (a
timed-out attempt is just a failed attempt → next target → Claude tail → fail-closed if all
exhausted), so it never weakens the fail-closed guarantee.

### 4.6 Where the resolution happens — live-read, layered (round-3 R3-1)
At the router construction site in `server.ts` (~line 4687), install a `resolveConfig` that
**reads the live config on every call** (never a frozen object). **Memoize only the active-framework
SET** (the boot-computed `INTERNAL_FRAMEWORK_PREFERENCE ∩ active` list — §4.2), NOT the resulting
config. Per call:
- If the **boot snapshot** says the operator set `componentFrameworks` (§4.4): return the live
  `config.sessions.componentFrameworks` unchanged (today's behavior; live edits to its contents
  flow through).
- Else: return the **computed default layered UNDER any live in-memory `componentFrameworks`** —
  i.e. start from the computed `{categories(sentinel/gate/reflector), failureSwap}` and let a live
  override that another feature injected at runtime WIN for its slot.

**Why layered, not frozen (round-3 R3-2 / R3-S2 — a real cross-feature regression otherwise):**
`CartographerSweep` injects its own routing at runtime by mutating
`config.sessions.componentFrameworks` (an in-memory component/category override, `server.ts:~11268`).
A *frozen* memoized computed-default would ignore that mutation and **silently make the freshness
sweep refuse-to-author on every agent running the default policy.** Reading live + layering the
computed default UNDER the live override preserves CartographerSweep's injection (and any other
runtime override) while still defaulting unset slots off Claude. The boot-snapshot only decides
default-vs-operator (§4.4); it never freezes the object the engine reads.

**Documented foot-gun (round-4 A6):** because `resolveConfig` reads live and `sessions` is a
`PATCH /config`-writable key, a Bearer-authed runtime `PATCH /config {sessions:{componentFrameworks}}`
DOES change gating routing live (it is honored by the layer). This is an authenticated,
operator-scoped capability, and every resulting path still fail-opens (a bad route → swap → Claude
tail → heuristic), so it is a foot-gun to be aware of, not a safety hole — noted for completeness,
not a blocker.

## 5. Migration parity (REQUIRED — existing agents)

This is a behavior change to every deployed agent, so it MUST reach existing installs,
not just `init`:
- **Runtime-computed, no persisted block (resolves Q2).** The default is computed at
  runtime from an unset `componentFrameworks`. `migrateConfig()` writes **no** frozen
  `componentFrameworks` block (a frozen block would pin a stale active-set and break the
  §4.3 tail-self-heal). The "migration" is purely the new code shipping.
- **`intelligence.swapAttemptTimeoutMs` is INLINE-defaulted, no migration (round-3 R3-3b).**
  The new config key (§4.5, default 5s) is read with an inline fallback (`?? 5000`); it gets
  **no `ConfigDefaults`/`migrateConfig` entry** — absent ⇒ the 5s default applies, present ⇒
  the operator's value wins. This matches the `codexExecJson` precedent (a behavior key kept out
  of the persisted defaults so absence is the dark/default state).
- **Agent-awareness migration (resolves round-1 integration finding):** the CLAUDE.md
  template change (§8) must land on EXISTING agents via `migrateClaudeMd()` with a
  content-sniff guard, not only on `init`. A capability the agent doesn't know about it
  has, it effectively doesn't have.
- **Multi-machine posture (resolves round-1 integration finding):** the active-set is
  **machine-local BY DESIGN** — each machine probes its OWN installed CLIs. Because the
  default is runtime-computed per machine (never a replicated/persisted block), machine A's
  installed-providers can never be pinned onto machine B. This is the correct posture and
  is stated explicitly. `/intelligence/routing` reflects the local machine's resolved
  routing.

## 6. Safety analysis

### 6.1 Fail-closed preserved
The engine re-throws when every swap target is down, so a gating caller still fails
closed (never silent brittle heuristic). The default policy only changes WHICH providers
it tries first; §4.5's timeout is fail-open per-attempt and cannot turn a fail-closed
outcome into a silent pass.

### 6.2 Herd analysis (resolves round-1 M2 / codex SERIOUS #2)
Codex's prior-spec concern — naive Codex→Claude fallback under rate-limit creates a
synchronized herd onto Claude — is bounded here, by construction:
- **Swap is gating-only.** The population that can fall to the Claude tail is the small
  set of safety-gating callers, not all background LLM traffic. Non-gating calls re-throw
  to their own heuristic (line 196) and never herd.
- **Per-framework breaker damps the herd.** Once Codex's breaker opens under broad
  rate-limit, gating calls skip Codex FAST (no repeated slow attempts) and try the next
  ACTIVE off-Claude link (PI/Gemini) before the Claude tail.
- **Falling to Claude is the CORRECT last resort for a *gating* call.** A safety gate
  must not degrade to a dumb heuristic; using Claude when every off-Claude provider is
  down is exactly the directive's "Claude = last resort," and is preferable to fail-closed
  for a delivery-path gate. The herd is small, breaker-damped, and intentional.

### 6.3 The tone-gate (the thing that broke tonight) — GROUNDED ✅
`src/core/MessagingToneGate.ts:269` calls `.evaluate()` with
`attribution: { component: 'MessagingToneGate', gating: true }`. So the outbound tone-gate
already participates in the failure-swap chain — this default policy, once shipped, would
have prevented tonight's delivery strangle (the tone-gate would have swapped off a slow
Claude onto Codex — and with §4.5, abandoned the slow primary at the cap). Confirmed
`gating:true` across the safety machinery: MessageSentinel:562, ExternalOperationGate:513,
InputGuard:327, IntentLlmJudge (IntentTestHarness:251), RelationshipAnomalyScorer:392,
LlmIntentClassifier:134.

### 6.4 Malformed/low-quality provider output — CALLER-HANDLED (round-2 N3; resolves the "No Deferrals" conformance flag)
A provider that is reachable but returns malformed/low-quality output (not an error) is not
trapped by the circuit breaker. Round-2 grounding confirms this is **already handled by the
gating CALLERS, not punted downstream**: `MessagingToneGate.review()` runs `parseResponse()` which
**fail-opens** on malformed JSON / non-boolean output AND validates the returned rule against
the `VALID_RULES` (B1..B20) allowlist (an invented/invalid rule → fail-open, `invalidRule:true`),
inside an outer try/catch fail-open; `MessageSentinel` fail-opens in its own try/catch. So a
garbage answer from any provider — Claude included — is parsed, validated, and safely fail-opened
**at the gate**, exactly per *Signal vs. Authority* (output validation is the gate's job, not the
router's). This spec does **not** change that property; it only changes *which* provider can serve
a weak answer. The single true residual is a **well-formed but semantically-wrong** verdict — a
pre-existing property of ANY LLM gate, provider-independent, not introduced here. This is therefore
**not a postponement of this feature's in-scope work** (the "No Deferrals" standard governs that); it
is correctly out-of-scope engine/caller work, documented rather than silently inherited.
<!-- tracked: a future "swap-target output sanity" hardening for the semantically-wrong residual
is a separate, lower-priority item; recorded here for No-Deferrals hygiene, not owed by this spec. -->

### 6.5 Framework-Agnostic conformance finding — resolves IN FAVOR
The Standards-Conformance gate flagged the fixed Codex-first/Claude-last chain as
possibly privileging one framework ("Framework-Agnostic — and Framework-Optimizing").
Resolution: this is **framework-OPTIMIZING, not framework-privileging** — (a) it is an
**operator-DIRECTED** default (Justin's explicit directive), (b) **fully overridable**
per-component/per-category (§4.4), (c) applied through a **single uniform mechanism** with
no framework-specific code path, and (d) a **no-op on Claude-only agents** (§4.2). The
order lives in ONE named documented constant (`INTERNAL_FRAMEWORK_PREFERENCE`, §4.1) so it
is inspectable and changeable in one place. A chosen, documented, overridable default is
not a lock-in.

### 6.6 Observability
Every swap/degrade routes through `onDegrade` → `DegradationReporter` and the per-feature
LLM metrics (`/metrics/features` shows `frameworks`/`models` actually serving each
component). The operator can SEE that sentinels now run on Codex, and that a swap occurred.

## 7. Test plan (all three tiers — non-negotiable)

- **Unit** (`tests/unit/`):
  - `resolveInternalFrameworkDefault`: chain `[codex,pi,gemini,claude]` × various active-sets
    → correct `{categories(sentinel/gate/reflector only), failureSwap}`; claude-only → no-op;
    codex missing → primary=pi (not claude); empty active → no-op; **`job` is NOT in the
    computed `categories`** (M3 regression guard).
  - operator-set `componentFrameworks` passed through unchanged (override wins), AND the
    boot-snapshot detection is **NOT fooled by an in-memory auto-vivify** of
    `componentFrameworks` after boot (M5 regression guard — simulate a CartographerSweep-style
    mutation and assert the default still resolves).
  - router `evaluate()` with the computed default: primary down → swaps down the chain in
    order; all down → re-throws (fail-closed).
  - **§4.5 per-attempt timeout:** a swap target that is SLOW (never errors) is abandoned at
    the cap and the loop advances; total swap time ≤ cap × active-tail length (M1 regression
    guard — the core "doesn't re-create the stall" test). The cap also abandons an attempt that
    is internally waiting on `rateLimitWaitMs` (the cap dominates the 120s wait — round-2 N2).
  - **§4.5 orphaned-attempt safety (round-2 N1 — crash regression guard):** a swap target whose
    promise REJECTS *after* the cap fired must NOT produce an unhandled rejection / crash, and a
    target that RESOLVES after the cap must NOT be used. Assert the abandoned attempt is
    `.catch`-swallowed and the timer is cleared; where the provider supports `AbortSignal`, assert
    the timed-out attempt is cancelled.
  - **`{}` rollback:** `componentFrameworks: {}` → all categories resolve to the agent default,
    empty swap (M7 — confirm the documented rollback lever).
  - **Model-size preservation (Q5):** a `fast`-tier call routed through a swap target keeps its
    `fast` tier (tier is per-call in `IntelligenceOptions`, orthogonal to framework) — assert it
    is not silently upgraded.
- **Integration** (`tests/integration/`): `GET /intelligence/routing` reflects the computed
  default (sentinel/gate/reflector → first active off-Claude framework, `available` true; `job`
  → agent default) on an agent with codex; reflects no-op on a claude-only agent.
- **E2E** (`tests/e2e/`): production init path → the router is constructed with the default
  policy live; a gating component resolves off Claude when codex is active; feature is ALIVE
  (not 503).
- **Wiring-integrity:** the tone-gate is `attribution.gating` and routes through the router
  (the regression guard for tonight's incident); **the gating CALLER fails closed** when all
  providers (primary + every swap target) are down — assert at the CALLER, not just the router
  (round-1 M11).

## 8. Agent-awareness (CLAUDE.md template)

**Two halves, because `migrateClaudeMd` only APPENDS and never edits a section in place
(round-2 N4 — the naive version would no-op AND leave wrong text).**

- **`generateClaudeMd()` (new agents):** EDIT the existing "Per-Component Framework Routing"
  section's now-false sentences — the shipped template says routing is "opt-in" and that a
  rate-limited component "falls back to its heuristic (no herd)". After this ships, for
  sentinel/gate/reflector routing is **default-ON** and a *gating* call **swaps down the active
  chain** rather than degrading to heuristic. Rewrite those two sentences so a fresh install is
  not internally contradictory, and add the default behavior + the `{}` rollback + a concrete
  example (N9): "with no `componentFrameworks` set, sentinels/gates/reflectors auto-route to the
  first active off-Claude CLI (Codex→PI→Gemini→Claude); set `sessions.componentFrameworks` to
  override; set it to `{}` to force everything back to the default framework."
- **`migrateClaudeMd()` (existing agents):** content-sniff on a **NEW unique marker** — use the
  literal **`run off Claude by default`**, **NOT** the existing `## Per-Component Framework Routing`
  heading (already on every deployed agent ⇒ silent no-op, stale "opt-in / heuristic" text left in
  place). **Do NOT use a marker containing the bare token `pi-cli`** (round-3 R3-3a — it collides
  with the existing pi-cli migration guard at `PostUpdateMigrator.ts:5525`). APPEND a short
  corrective subsection stating the new default-ON behavior, the gating-call swap (superseding the
  old heuristic line), the override, and the `{}` rollback. (Append-with-new-marker is the only
  path `migrateClaudeMd` can execute; an in-place sentence edit is `generateClaudeMd`-only.)
- **Proactive trigger** (both): "user hits Claude rate limits / 'why are my sentinels on Codex?'"
  → explain the default + how to override + the `{}` rollback.

## 9. Rollout

- Ships **enabled by default** (this is the whole point — a dark default would not fix the
  problem). The no-op guarantee (§4.2) means it is inert on agents with no off-Claude provider,
  so the blast radius is only agents that HAVE codex/pi/gemini installed — i.e. agents that can
  benefit.
- **Rollback lever (grounded, M7):** operator sets `componentFrameworks: {}` (explicit empty)
  ⇒ every category resolves to the agent default framework, empty swap — back to today's
  behavior. The unit test in §7 pins this.
- Dogfood on echo (codex active) first; verify `/intelligence/routing` + `/metrics/features`
  show sentinels/gates/reflectors on codex (and `job` still on the default) before relying on it.

## Frontloaded Decisions

All round-1 "open questions" are **engineering choices (type-B)** the building agent resolves
in-spec — the Decision-Completeness review found **zero genuine user-decisions** (no taste,
money, identity, irreversible, or published-interface call). Resolved here so the build never
stops to ask:

1. **Active-provider probe (Q1) → `buildProvider(fw) !== null`** (the router's own truth),
   computed once at boot. Rejected: a bare `which` probe (would falsely pass an installed-but-
   unconfigured CLI like PI). (§4.2)
2. **Default representation (Q2) → runtime-computed, no persisted config block.** Self-heals the
   swap tail live, never pins a stale active-set, keeps the operator-override path unambiguous.
   (§4.3, §5)
3. **`job` category (Q4) → EXCLUDED from the default** (only sentinel/gate/reflector). Contested
   then resolved conservative: routing `job` off-Claude by default would auto-arm cost-bearing
   background jobs (CartographerSweep) as a side-effect. An operator who wants it sets
   `categories.job` explicitly. (§4.1) — *contested-then-cleared.*
4. **Model-size preservation (Q5) → confirm-only, no change.** The model tier travels per-call
   in `IntelligenceOptions` and flows unchanged through every swap target; orthogonal to
   framework by construction. Pinned by a unit test (§7). (§4.2)

Counts: frontloaded-decisions = 4 · cheap-to-change-after tags = 0 · contested-then-cleared = 1.

## Open questions

*(none)*
