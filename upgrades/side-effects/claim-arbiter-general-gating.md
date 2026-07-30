# Side-effects review — gate the `general` envelope on the pre-call resolved framework

**Change:** `ClaimClauseArbiter` asks for the `general` claim-extraction envelope only when the
component's resolved framework is `claude-code` — the sole framework whose `general` result the
call site can admit.
**Files:** `src/monitoring/ClaimClauseArbiter.ts`, `src/monitoring/CompletionClaimVerifier.ts`,
`tests/unit/claim-arbiter-general-gating.test.ts`
**Tracked:** CMT-1118. Escalates ACT-1466 (filed 2026-07-28 as a coverage gap) with its cost consequence.
**Tier declared:** 1 — small (2 source files, ~45 net LOC), no new capability, no migration, no
irreversibility, no safety-invariant change. Risk floor unchanged.

## Phase 1 — Principle check (signal vs authority)

**Does this change touch a decision point that gates information flow, blocks actions, filters
messages, or constrains agent behaviour?** No — and the distinction matters.

The admission rule is untouched. `const general = resolvedModel?.framework === 'claude-code' ?
parsedGeneral : null` is byte-identical before and after. What changes is only what we **ask the
model to generate**, not what the system **accepts**. No authority is added, moved, or widened;
if anything the change removes generation work whose product was already unreachable.

`CompletionClaimVerifier` is observe-only by construction (per the constitution: claim
verification "never blocks, rewrites, delays, sends, corrects, or authorizes an action"), so
there is no blocking authority anywhere on this path for brittle logic to attach to.

**Verdict: compliant.** This is a cost reduction inside a signal producer.

## Phase 4 — The eight questions

### 1. Over-block — what legitimate inputs does this reject that it shouldn't?

The failure mode is suppressing `general` on an install where it **would** have been admitted.
Every uncertain path is biased against that. `includeGeneral` starts `true` and only a
positively-resolved, non-empty, non-`claude-code` string flips it:

- no `resolveFramework` injected → full prompt (this is also the default for every existing
  caller that constructs the arbiter directly, e.g. tests and `opts.arbiter` overrides)
- resolver returns `undefined` / `''` / a non-string → full prompt
- resolver throws → caught, full prompt
- provider is not a router (no `for()` method) → resolver is `undefined` → full prompt

So over-blocking requires the router to positively and correctly report a non-Claude framework —
which is precisely the case where the result could not have been admitted anyway. **No issue
identified.**

### 2. Under-block — what failure modes does this still miss?

Two, both known and both leaving today's behaviour intact rather than degrading it:

- **Mid-call failure-swap.** The framework is resolved before the call; a runtime swap can land
  the request on a different framework than predicted. Claude-predicted → codex-actual keeps
  today's waste (no regression). Codex-predicted → Claude-actual sends the lean prompt to Claude,
  so `general` is simply absent — and the call site already tolerates absence:
  `envelopeIncludesGeneral = Object.hasOwn(modelRoot, 'general')` only fails when `general` is
  *present but unparseable*. Verified by reading that branch, not assumed.
- **The 83%→lower error-rate improvement is a prediction, not a measurement.** The latency and
  token ratios are measured; the production error rate moving is not yet observed. Recorded here
  rather than claimed. Closing evidence is owed on CMT-1118 <!-- tracked: CMT-1118 -->.

### 3. Level-of-abstraction fit

The gate belongs at the prompt-construction site because that is where the cost is incurred and
where the admission rule's twin already lives — the two are now adjacent and reference each other,
so they cannot drift apart unnoticed. Pushing it lower (into the provider) would make the provider
aware of one component's schema; pushing it higher (into routing config) would make an operator
maintain a duplicate of a rule the code already enforces. **Right layer.**

A smarter gate does not already exist for this: nothing else inspects what this component asks for.

### 4. Signal vs authority compliance

Compliant — see Phase 1. No brittle logic acquires blocking authority; the one existing authority
(the `claude-code` admission check) is unchanged.

### 5. Interactions — shadowing, double-fire, races

- **Prompt-id attribution.** The two prompt shapes have materially different latency and output
  size. Recording both under one id would blend them in per-prompt quality/latency attribution and
  make the decision-quality meter quietly wrong about whichever install it looked at. A distinct
  `CLAIM_ARBITER_PROMPT_ID_LEGACY_ONLY` prevents that. This is the interaction most likely to have
  been missed.
- **Component-name drift.** The resolver must ask about the *same* component the call attributes
  to. If they diverged, the gate would consult the wrong routing entry and mis-gate silently, with
  nothing visibly wrong. Both now read the shared `CLAIM_ARBITER_COMPONENT` constant, making the
  drift structurally impossible rather than merely unlikely.
- **No shadowing or double-fire:** nothing else builds this prompt; the arbiter has one call site.

### 6. External surfaces

No API, route, config key, or user-visible surface changes. The only externally-observable deltas
are (a) a smaller prompt on non-Claude installs and (b) a second `promptId` value appearing in
provenance records. Nothing another agent, user, or system consumes by name is removed or renamed.

### 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and correctly so.** The decision is derived per-call from that machine's
own resolved routing (`sessions.componentFrameworks`), which is legitimately per-machine — a pool
can genuinely run Claude on one machine and codex on another, and each machine should ask for
exactly what its own door can deliver. Nothing durable is written, so there is no state to
replicate, strand on topic transfer, or merge on read. No user-facing notice, so no one-voice
gating needed. No generated URLs.

### 8. Rollback cost

Near-zero, and available three ways without a release: stop injecting `resolveFramework` at the
construction site (one line), or route the component to `claude-code` via
`sessions.componentFrameworks`, or revert the commit. No data migration, no agent-state repair,
no schema change. Nothing persists that a rollback would leave inconsistent, except historical
provenance rows carrying the legacy-only prompt id — which remain accurate for the calls they
describe.

## Phase 4.5 — No-deferrals

No orphan deferrals. The one outstanding item (confirming the production error rate actually
falls) is tracked on CMT-1118 <!-- tracked: CMT-1118 --> and is evidence-gathering on shipped
behaviour, not deferred work.

## Phase 5 — Second-pass review: NOT REQUIRED, with reasoning

Checked against the skill's own high-risk list. This change touches **none** of: block/allow
decisions on inbound/outbound messaging or dispatch (the admission rule is unchanged and the
component cannot block); session lifecycle; context exhaustion/compaction/respawn; coherence
gates, idempotency, or trust levels; nor anything named sentinel/guard/gate/watchdog.

Declared `--second-pass not-required`. Stated plainly because the analogous judgement was made on
PR #1749 earlier tonight and an independent reviewer there found a genuine, ship-blocking defect —
so "it looked small" is not by itself reassuring. The difference is concrete rather than a feeling:
#1749 altered delivery semantics on a path that could double-deliver a live instruction; this
alters only what is asked of a model, on a path whose result is discarded, with every failure mode
resolving to the pre-existing behaviour.

## Evidence

- **Measurement:** interleaved A/B (A,B,A,B,A,B so door drift cannot be attributed to a variant),
  `gpt-5.4-mini` via codex, identical message/clauses/evidence. n=3 per arm.
  Full prompt median **129,204 ms** / ~8,338 output tokens, range 91,520–148,719.
  Legacy-only median **28,153 ms** / ~1,386 output tokens, range 24,965–33,708. **Ranges do not
  overlap.** Against this call's own `timeoutMs: 60_000`: full exceeded the wall 3/3, legacy-only
  fit 3/3 — consistent with the observed production `errorRate 0.835`, `p50 49,315`, `p95 60,082`
  over 1,207 calls/24h.
- **Correctness, not just speed:** the legacy-only response was confirmed valid JSON matching the
  legacy schema, and materially correct — it labelled an imperative to the reader `neither`, and
  flagged an unsupported "everything green" claim `corroborated: false`.
- **Test discrimination measured, not assumed:** the new tests were run against the unfixed source
  with only the test staged → **6 failed / 4 passed**. The 4 passes are marked `CONTROL` and pass
  on both revisions by design; two of them only revealed themselves as non-discriminating *because*
  that unfixed run was done. Only the 6 failures are counted as evidence for the change.
- tsc clean (exit 0). 30/30 on this file plus `claim-observation-v1` and `action-claim`.

## Two defects found AFTER this artifact was first written, both in my own change

Recorded rather than silently folded in, because both are the kind of thing this review exists to
catch and both were missed by the review's first pass.

### 1. The change would have been INERT in production (wiring integrity)

`AgentServer` does not hand `CompletionClaimVerifier` the router. It hands it an anonymous
`{ evaluate }` wrapper so the call rides the metered LLM queue, and that wrapper exposes no
routing surface. The duck-typed resolver therefore returned `undefined` on every real install,
`includeGeneral` stayed `true`, and nothing changed — **while all ten unit tests passed**, because
they inject a router directly.

This is exactly "the logic is proven and the feature is not wired." Found by tracing the real
construction site and asking *what object is actually passed here?* — not by any test.

Fixed by adding an explicit `resolveFramework?` to `CompletionClaimVerifierOptions`, passed from
`AgentServer` where the real router is in scope; the duck-typed fallback remains for callers that
pass a router straight through. Two WIRING tests added — one pins the defect (production-shaped
wrapper yields NO resolver), one asserts an explicit resolver reaches the arbiter.

### 2. I broke `lint-llm-attribution` by hoisting the attribution to a constant

Replacing the inlined `component: 'completion-claim-verify'` literal with `CLAIM_ARBITER_COMPONENT`
made the callsite look unattributed: that lint reads the callsite **statically** and cannot resolve
a constant. It failed the build, which surfaced as two e2e preflight failures in the full suite.

Reverted to the inlined literal with a comment explaining why it must stay inlined, and added a test
pinning the constant equal to the literal so the two cannot drift while the callsite stays lintable.

## Suite status, measured

Full unit suite: **2 failed / 3003 passed** (46,869 tests). Both failures are the same
`tests/e2e/dev-preflight-cli.test.ts` case.

**Discriminated rather than assumed:** re-ran that test with my changes stashed — **it fails
identically without them.** Cause is `ERR_PNPM_IGNORED_BUILDS` on a fresh clone under pnpm 11.5.1,
which now demands explicit build-script approval; the repo declares no `pnpm.onlyBuiltDependencies`
and existing worktrees only pass because their `node_modules` predates the enforcement. So it is a
fresh-checkout packaging condition affecting anyone cloning today, independent of this change.

Filed separately rather than bundled here — mixing an unrelated packaging fix into this change is
the "batched release" anti-pattern, and it would make it impossible to attribute a later regression
to the right half. <!-- tracked: CMT-1120 -->

After the lint fix: `npm run lint` exit 0, `tsc --noEmit` exit 0, 13/13 on this file.

## Honest limits

- n=3 per arm is small; the conclusion rests on the size of the separation and the non-overlap,
  not on sample count.
- Timings came from a direct `codex exec` invocation, not through instar's provider (different
  sandbox/env/out-dir), so **absolute** numbers may differ in production. The **ratio** is the
  load-bearing result and it is controlled.
- A first attempt to confirm a *different* fix tonight compared two installed builds that were both
  `1.3.1068` — a false control that would have produced a confident wrong answer. Recorded here as
  the reason the A/B above was interleaved and the unfixed test run was not skipped.
