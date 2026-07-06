# Side-Effects Review — Nature-Axis Routing, Increment A2.2 (enforcing selection)

**Spec:** docs/specs/nature-axis-routing.md (status: **converged — pending operator approval**;
`review-convergence` tag, NOT `approved:true` — the operator's step). **Tier-1** change: the enforcing
wiring for FD9's Increment A2, riding the same dev-gated dark / dryRun-defaulted ladder A2.1 shipped on.
**Parent standards:** "Structure > Willpower", "No Silent Degradation to Brittle Fallback", benchmark-
cited routing (INSTAR-Bench v3, rules R1/R2), the Maturation Path (dev-gated dark; the operator's
deliberate `dryRun:false` flip is the only activation), Migration Parity (no new config, no default flip).

**Date:** 2026-07-05
**Author:** Echo (build hand, topic 29723)
**Second-pass reviewer:** required (touches routing-of-safety-gates) — see §Second-pass.

**Files:** src/core/IntelligenceRouter.ts, tests/unit/nature-routing-resolver.test.ts,
upgrades/nature-routing-a2.2-enforcing.eli16.md, upgrades/side-effects/nature-routing-a2.2-enforcing.md,
upgrades/next/nature-routing-a2.2-enforcing.md.

## Summary of the change

`IntelligenceRouter.evaluate()`'s nature block previously OBSERVED (logged the resolved plan) and then
fell through to today's selection even with `dryRun:false`, guarded by a one-time "enforcing not yet
wired" warning. This change makes `dryRun:false` ACTUALLY enforce (spec §Resolver steps 8-9): on outcome
`route` the resolved primary `(door, model)` replaces `resolveFramework()`'s door + the caller's tier,
and the resolved `swapTail` feeds the EXISTING failure-swap loop (each tail position carrying its own
concrete model). On `no-route` it raises the ordinary non-gating heuristic error (never legacy routing);
on a critical-gate empty set it re-throws `RouterFailClosedError`; on `fall-through` (unmapped) it uses
today's routing untouched. The obsolete warning method + field are removed.

## Decision-point inventory

- `IntelligenceRouter.evaluate() — nature block` — modify — was observe-only; now, when
  `enabled && !dryRun`, applies the resolved plan.
- `IntelligenceRouter.evaluate() — framework/model selection` — modify — `framework`/`evalOptions`
  now derive from the enforced primary when a plan is enforced, else today's category routing.
- `IntelligenceRouter.evaluate() — failure-swap loop` — pass-through/extend — same loop, now driven by
  either the resolved `swapTail` (per-position concrete model) or today's `cfg.failureSwap` frameworks.
- `warnNatureEnforceNotWired()` + `warnedNatureEnforceNotWired` — remove — the no-op is now real wiring.
- `resolveRoute` / `clampToReserveOnCleanDoor` / `mergeNatureRoutingChains` / the FD4/FD4.2 validators —
  pass-through — UNCHANGED (A2.2 consumes them; it does not weaken them).

---

## 1. Over-block

The only "block" surface is the critical-gate fail-closed throw. On the real path a mapped FD6 critical
gate whose chain has NO available door throws `RouterFailClosedError` → the caller blocks/denies. This
can only fire when EVERY door in the gate's chain is unreachable (metered doors are skipped in Increment
A, so realistically all CLI doors down). That is the correct fail-closed direction for a safety gate; it
is not an over-block of legitimate traffic — a reachable door always routes. In dryRun the same throw is
swallowed (observe-only), so the enforcing throw only ever happens on the operator's deliberate flip.

---

## 2. Under-block

`no-route` (low-stakes empty set) deliberately does NOT block — it raises the ordinary non-gating error
the caller catches into its heuristic. This is spec-mandated (§573-581): a low-stakes sorter degrades to
its own heuristic, exactly as it does today when its provider is down. It is NOT a safety gate, so not
blocking is correct. An UNEXPECTED (non-`RouterFailClosedError`) resolver error also does not block — it
is recorded and falls through to today's routing (fail-safe), because the pure fold only throws the typed
error by design; a different throw is a bug and must not break routing.

---

## 3. Silent failure / silent degradation

No silent path. `no-route` calls `onHeuristicFallthrough` before throwing (never-silent tracking). Every
swap attempt emits an `onDegrade` note; a successful swap emits the served-by note; a fail-closed gate
throws a distinct typed error the caller cannot mistake for a model failure. The enforcing primary always
routes through `resolveProvider` (a real provider), never a heuristic pretending to be an answer. The
retired warning was itself the only "honest no-op" scaffolding; removing it removes a now-false statement.

---

## 4. Byte-identical-when-off (THE safety case)

When `sessions.natureRouting` is absent OR `enabled:false` (the fleet default), the nature block is
skipped entirely: `enforced` stays undefined, `enforcedNoRoute` false, and `evalOptions` remains the SAME
`options` object reference. Selection is bit-for-bit today's. In dryRun the plan is logged but `enforced`
stays undefined (only set when `!dryRun`), so selection is still unchanged. Asserted by the named test
`natureRouting UNSET ⇒ selection unchanged` (same options object) and the FD4.3 banned-chain-when-off
test, both green. A new test (`dryRun:true still OBSERVES only`) proves enforcing changes nothing in
dryRun even with a reachable alternate door.

---

## 5. Model-selection correctness (the concrete-id path)

The resolved primary's CONCRETE model id (e.g. `gpt-5.4-mini`, `claude-sonnet-4-6`) is placed on
`options.model` and rides verbatim to the provider — the CLI adapters (`resolveCliFlag` /
`resolveCliModelFlag`) return a concrete id as-is and only map the three tier tokens, so a concrete id is
honored. The claude-code reserve is already reserve-clamped by the resolver, so the caller's `capable`
(→ Opus, the banned door) is replaced by the pinned Sonnet reserve id — asserted by the enforcing test
`a JUDGE gate landing on claude-code enforces the CONCRETE reserve id`. Metered doors remain skipped
(Increment A) — asserted by `a metered primary position is SKIPPED`.

---

## 6. Blast radius

- **Scope of the real path:** only when `enabled && dryRun:false` — i.e. an operator's deliberate flip
  after the dryRun soak. Dev agents default to dryRun; the fleet is dark. No default is changed.
- **A1 / A2.1 untouched:** `clampClaudeCliSwapModel` (A1 tier clamp), `clampToReserveOnCleanDoor`,
  `resolveRoute`, the FD4/FD4.2 validators are consumed as-is, not modified. All their tests stay green.
- **The failure-swap loop:** reused verbatim, gated on `gating||deferrable` exactly as today; nature
  positions ride the same per-target timeout / total-budget / backoff / degrade machinery. A legacy
  swap (no nature plan) is byte-identical (base is `evalOptions`, which === `options` off the nature
  path; no reference-equality assertion in the swap tests regresses).
- **`cfg` nullability:** the `if (!cfg) return default` short-circuit now lives in the non-enforced
  branch; downstream `cfg?.fallback` / `cfg?.failureSwap` use optional chaining so an enforced plan with
  a null `cfg` (the common fleet shape) is safe. The enforced primary door is always reachable (the
  resolver only emits reachable CLI doors), so the `!primary` degrade path is not reached under
  enforcement.

## Explicitly DEFERRED (tracked remainder — NOT dropped)

- **FD6 critical-gate drift NOTICE + baseline** — depends on the durable `state/nature-routing-baseline.json`
  store + N=3 debounce + aggregation, which the spec classifies as an "orthogonal surface AROUND the fold"
  and whose PIN-approved baseline MUTATION is explicitly operator-only / out of this scope. The
  `onNatureRoutePlan` hook already records the resolved plan for a future drift tracker to consume.
- **R6 doc-tree refuse-to-author branch (FD5c)** — DORMANT in Increment A: no component in the shipped
  nature map carries `claudeBanned`, and R6 chains are authored off-Claude, so a claudeBanned empty set
  already resolves to `no-route` → the caller's heuristic (which for `CartographerSweepEngine` IS
  refuse-rather-than-Claude). A dedicated refuse-to-author router branch is a separate concern.
- **Increment B** — metered live routing + FD12 money/PIN go-live. Untouched; `metered.goLive` stays
  false and unreferenced by this change.
- **The durable audit log + `GET /intelligence/routing` enforced-diff surface** — the read surfaces are a
  tracked follow-up; enforcement does not require them.

## Second-pass review (Phase 5 — required: routes safety GATES)

This change makes safety-gate routing REAL, so it triggers the high-risk second pass. Focus:
(a) can the banned Opus-via-CLI route open under enforcement? — No: the resolved position is already
reserve-clamped, and the enforced model is the concrete Sonnet reserve id, asserted by the JUDGE-reserve
enforcing test. (b) can a critical gate fail OPEN under enforcement? — No: the empty-set critical gate
re-throws `RouterFailClosedError` on the real path (asserted `rejects.toThrow(RouterFailClosedError)`,
default provider NOT called), and `no-route` is reserved for non-critical low-stakes components only.
(c) is "off" still truly inert? — Yes, the byte-identical-when-off tests remain green and a new
dryRun-observes-only enforcing test proves the flip is the sole activation. **Reviewer focus verdict:
the enforcing path preserves every safety invariant the resolver already guaranteed; the only new risk
is the model-application boundary (concrete id on `options.model`), which is covered by the concrete-id
enforcing tests and the pre-existing adapter tier-or-id resolution.**
