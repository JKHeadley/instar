# Round 3 — Security lens (verification of round-2 fixes)

Scope: verify (1) N1 orphaned-promise/crash fix in §4.5, (2) N6 ordering-contract fix in §4.4,
(3) any NEW security issue introduced by the round-2 edits. Grounded against the worktree code,
not prose.

## Verdicts on the two named fixes

### (1) N1 — orphaned-attempt crash fix (§4.5): SOUND, with one test-design caveat (R3-S1)
The crash hazard is REAL and correctly diagnosed:
- `unhandledRejection` is wired (`src/commands/server.ts:17535`) → `handleProcessLevelError`
  → fail-toward-crash on any non-allowlisted error.
- CLI providers reject with `"Codex CLI error: …"` (`CodexCliIntelligenceProvider.ts:373/437/451/458`)
  and `"Claude CLI error: …"` (`ClaudeCliIntelligenceProvider.ts:80`). **Neither substring is in
  `NON_FATAL_UNCAUGHT_PATTERNS`** (`uncaughtExceptionPolicy.ts:17-75`) → a late, un-handled
  rejection from an abandoned attempt is classified FATAL → server crash. Diagnosis confirmed.
- The prescribed fix `.catch(() => {})` on the abandoned attempt is **correct and sufficient**
  (empirically: a bare orphan fires `unhandledRejection`; the same orphan with `.catch(()=>{})`
  does not). Clear/`unref()` timer + best-effort AbortSignal cancellation are correctly scoped as
  additive (cancellation is best-effort; the orphan is bounded). NOTE: `IntelligenceOptions` has NO
  `signal` field today and no provider accepts an `AbortSignal` — so the AbortSignal half is net-new
  plumbing the build must ADD; the spec already frames it as "where supported, else swallow + accept
  the bounded orphan", so the prescription does not over-promise. Fix is complete.

### (2) N6 — snapshot-at-construction ordering contract (§4.4): SOUND
Verified against code:
- Construction site `server.ts:4687` and the only runtime mutator `server.ts:11266`
  (`config.sessions.componentFrameworks.overrides.CartographerSweep` via `??=`) are both inside the
  same `startServer` async fn (starts 2914); 4687 is straight-line BEFORE 11266 in boot order, and
  11266 is gated behind `freshnessSweep.enabled` + `injectOverride`. So capturing the operator-set
  boolean at 4687 provably precedes any vivify. The "snapshot the boolean, never re-read; loadConfig
  exposes by reference" framing is the right mutation-proofing — a live re-test after boot WOULD
  mistake the cartographer's auto-vivified block for an operator override (the original M5). Contract
  is sound and the §7 M5 regression guard (simulate a CartographerSweep-style mutation, assert the
  default still resolves) exercises exactly this.

## NEW material

### R3-S1 (test-design, LOW) — the N1 regression test must use the BARE-ORPHAN shape, not `Promise.race`
The spec's stated mechanism ("the abandoned promise's later rejection hits the unhandledRejection
policy") is only true for a **bare orphan with no rejection reaction**. The codebase's own
established timeout idiom is `Promise.race([call, setTimeout-reject])` (CoherenceReviewer.ts:147,
InputGuard.ts:320, DiscoveryEvaluator.ts:463) — and `Promise.race` internally attaches a reaction to
EVERY input, so the losing attempt's late rejection is already "handled" and does NOT crash (verified
empirically). Consequence: a §4.5 regression test built on the `Promise.race` idiom would PASS even
WITHOUT the `.catch(()=>{})` — false assurance. The §7 test must explicitly construct the scenario
where the timed-out attempt promise has NO handler attached at the time it later rejects (a flag/timer
race that fires the attempt and advances the loop without racing/`.then`-ing it). Keep the `.catch`
regardless (idiom-independent defense-in-depth + it makes the AbortSignal/cancellation path coherent),
but the test must fail-without-fix. Not a flaw in the fix — a flaw in how §7 will be VERIFIED.

### R3-S2 (correctness, MEDIUM — NEW, exposed by the round-2 §4.6/§4.4 edits) — the memoized computed-default `resolveConfig` is decoupled from CartographerSweep's live-config injection, silently disabling the sweep under the default policy
The round-2 design hardened operator-set detection by making the default-policy `resolveConfig`
return a **memoized computed config** (§4.6 line 244) instead of `() => config.sessions?.componentFrameworks`
(the current wiring at `server.ts:4693`). But CartographerSweep self-routes by **mutating the LIVE
config** at `server.ts:11268` (`overrides.CartographerSweep = routed.framework`) and then probing via
`router.for('CartographerSweep')` (`CartographerSweepEngine.ts:207`), which calls `resolveConfig()`.

Failure mode (default policy active = operator did NOT set `componentFrameworks`; `freshnessSweep.enabled`
with a `framework`; codex active):
1. Router `resolveConfig` returns the computed default — which has `categories.{sentinel,gate,reflector}`
   only, NO `categories.job`, NO `overrides.CartographerSweep` (job is EXCLUDED, §4.1).
2. Cartographer vivifies `config.sessions.componentFrameworks.overrides.CartographerSweep` on the LIVE
   object (11268). The router never reads that object → the injection is invisible.
3. `router.for('CartographerSweep')` → `resolveFramework('CartographerSweep','job', computedDefault)`
   → no override, no `categories.job`, `cfg.default` undefined → returns `defaultFramework` (claude-code).
4. `probeRouting()` sees `resolvesToDefault === true` → **refuses to author** ("off-Claude routing not
   configured"). The freshness sweep silently does nothing on every agent running the default policy.

§4.4 line 189 claims excluding `job` means "the default no longer writes the `job` slot where
CartographerSweep lives, so the two no longer contend for it" — but the contention is not over
`categories.job`; CartographerSweep writes `overrides.CartographerSweep`, and the new memoization is
exactly what makes the router blind to it. The two don't "no longer contend" — they're DECOUPLED, and
the decoupling kills the sweep's off-Claude routing.

Direction is fail-SAFE on cost (the sweep refuses rather than burning Claude — no quota/security
regression), so this is correctness/MEDIUM, not a security blocker. But it is a silent feature death
introduced by the round-2 edits and must be resolved before build. Two clean options for the spec to
name explicitly:
- (a) Make the computed-default `resolveConfig` **live-overlay** the operator's `overrides`/`categories`
  edits (read live `config.sessions?.componentFrameworks?.overrides` on top of the memoized computed
  base), so a post-boot/boot-time injection like CartographerSweep's is honored — while the operator-set
  *boolean* stays the frozen-at-4687 snapshot (N6 is unaffected; the snapshot governs WHICH config to
  install, the overlay governs the contents). This mirrors the §4.4 "block contents are live-read" clause
  that today only applies to the operator-set-at-boot path.
- (b) Have the cartographer-sweep wiring inject its override into the computed-default object the router
  actually reads (or route CartographerSweep through `freshnessSweep.framework` inside the resolver),
  rather than the live `config.sessions.componentFrameworks` the default-policy router ignores.
Either way §4.4/§4.6 must state the interaction; right now the spec asserts the contention is gone when
it has instead been converted into a silent-disable.

## No NEW security issue beyond the above
- The AbortSignal threading is best-effort, bounded, and breaker/cap-limited (no new leak/DoS surface).
- The §6.4 caller-handled relabel is grounded (parseResponse fail-open + B1..B20 allowlist + try/catch);
  no security regression — it correctly keeps output validation at the gate, not the router.
- The §8 two-halves migration is a doc change; no security surface.
- Fail-closed is preserved (§6.1) — the per-attempt timeout is fail-open per-attempt and cannot turn a
  fail-closed gating outcome into a silent pass.
