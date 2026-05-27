---
title: "Conformance-gate timeout fix — two 30s walls: middleware budget + provider honoring timeoutMs"
slug: conformance-gate-timeout
review-iterations: 1
review-convergence: "v1 — converged after one adversarial + one standards round (2026-05-26). The adversarial round caught a BLOCKING miss in the v0 draft: a second, inner 30s wall in the intelligence providers that a middleware-only fix would have masked as a silent 'degraded' (empty) report — worse than the loud 408. Root cause and fix surface corrected accordingly. Standards round added the production-map wiring-integrity test requirement."
eli16-overview: "conformance-gate-timeout.eli16.md"
approved: true
approval-context: "Approved by Justin on 2026-05-26 (topic 12476) after the converged plain-English summary. The convergence's adversarial round caught the second (inner provider) 30s wall before any code was written; Justin approved the complete four-edit fix."
lessons-engaged:
  - "Verify component is actually wired (PR #334 dead-code lesson) — the unit test must assert against the PRODUCTION override map, not a hand-rolled one, or it goes green while the wiring stays broken"
  - "A test can encode the bug as correct — a middleware-only unit test would pass while the gate stays broken end-to-end (the inner provider wall)"
  - "External/adversarial review catches what the author's own pass misses — the second 30s wall was invisible to me until the adversarial reviewer traced the provider"
  - "Gate latency vs client timeout (B24) — budget the WHOLE synchronous path (middleware AND the provider's child-process timeout), not just the outer layer"
  - "Bug-fix evidence bar — 408 reproduced; the inner wall verified by reading both providers + the reviewer call"
  - "Don't over-engineer — honor an already-declared interface field; do not add config knobs or an async rearchitecture nobody needs"
  - "ELI16 companion (sibling file)"
  - "Seven-dimension side-effects review (§5)"
build-mode: "Small, bounded, fully revertible — 4 source edits (2 providers honor timeoutMs, reviewer passes one, middleware outer budget) + tests across each boundary."
---

# Conformance-gate timeout fix

> Read the ELI16 companion (`conformance-gate-timeout.eli16.md`) first. This is the technical detail.

## 1. Problem (reproduced)

`POST /spec/conformance-check` is the Standards-Conformance Gate — code that reads `docs/STANDARDS-REGISTRY.md` and uses a top-tier (opus) model to review a spec against every standing standard. PR #403 auto-wired it into `/spec-converge` Phase 1 so the constitutional pass runs structurally (the dogfood-to-ship enforcement of the Self-Hosting standard).

On 2026-05-26, dogfooding the gate against a real ~400-line spec returned:

```
HTTP 408 {"error":"Request timeout","timeoutMs":30000}
```

## 2. Root cause — TWO 30-second walls, not one

The v0 draft of this spec identified only the outer wall. An adversarial review traced the inner one. Both exist and both fire at ~30s:

**Wall A (outer, HTTP middleware).** `requestTimeout` (`src/server/middleware.ts:291`) applies a 30s default to every route, with a `perPathOverrides` map granting LLM-backed routes more time. The outbound-messaging routes are registered at `OUTBOUND_MESSAGING_TIMEOUT_MS = 120_000` (`AgentServer.ts:380-388`). `/spec/conformance-check` was never added, so it inherits 30s and 408s.

**Wall B (inner, provider child-process).** Even with Wall A raised, the review's opus call dies at 30s anyway: both intelligence providers hardcode the child-process timeout and **ignore the `timeoutMs` the interface already defines**:
- `ClaudeCliIntelligenceProvider.evaluate` (`:35`) → `execFile(..., { timeout: DEFAULT_TIMEOUT_MS })`, `DEFAULT_TIMEOUT_MS = 30_000` (`:18,58`).
- `CodexCliIntelligenceProvider.evaluate` (`:96`) → same, `:23,149`.
- The interface `IntelligenceOptions.timeoutMs` exists and is documented "provider should honor or surface as throw" (`types.ts:632-633`), but neither provider reads it.
- The reviewer (`standards-conformance.ts:120-125`) passes `{model, temperature, maxTokens, attribution}` — **no `timeoutMs`** — and on any throw returns `{ findings: [], degraded: true, degradeReason: 'error' }` (`:126-127`).

**Why a middleware-only fix is worse than nothing.** With only Wall A raised, a slow review hits Wall B at 30s → `evaluate` rejects → the reviewer's `catch` returns an empty `degraded` report → the handler returns **200 with zero findings**. A loud, obvious 408 becomes a quiet "no problems found" — the silent-no-op our standards exist to prevent, now actively *masked* as success. The complete fix must remove BOTH walls.

The companion GET route `/spec/conformance-metrics` only reads counters; it stays on the 30s default (it makes no model call).

## 3. Fix (4 source edits + tests)

1. **Providers honor `timeoutMs`** — in both `ClaudeCliIntelligenceProvider.ts:58` and `CodexCliIntelligenceProvider.ts:149`, change `timeout: DEFAULT_TIMEOUT_MS` → `timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS`. This mirrors the existing `options?.model ?? DEFAULT_MODEL` pattern in each `evaluate`. `DEFAULT_TIMEOUT_MS` stays 30_000, so every caller that does NOT pass a budget is completely unchanged — only callers that opt in get more time.

2. **Reviewer passes a budget** — in `standards-conformance.ts`, add `timeoutMs: CONFORMANCE_REVIEW_TIMEOUT_MS` to the `evaluate` options, with a named constant `CONFORMANCE_REVIEW_TIMEOUT_MS = 150_000` defined in that module.

3. **Middleware outer budget** — in `AgentServer.ts`, define `SPEC_REVIEW_TIMEOUT_MS = 180_000` next to `OUTBOUND_MESSAGING_TIMEOUT_MS` and add `'/spec/conformance-check': SPEC_REVIEW_TIMEOUT_MS` to `perPathOverrides`. The 180s outer budget sits **above** the 150s inner budget on purpose: a genuinely-too-slow review is killed cleanly by the provider (→ degraded report, advisory, fail-open) ~30s before the middleware would 408, so the client never sees a raw timeout. Headroom rationale: a human-authored spec driving >150s of opus review is implausible; the ordering makes the over-budget case degrade gracefully rather than 408.

4. **Extract the override map for testability** — lift the `perPathOverrides` object literal into a small exported `buildRequestTimeoutOverrides()` (or exported const) in `AgentServer.ts`/a sibling, so the unit test asserts against the **same map the server actually wires** (closes the dead-code/false-wiring trap — see §5).

## 4. Why this scope and no more

- No config knob (`specReview.conformance.timeoutMs`): nobody asked for runtime-tunable review latency, and adding it pulls in `ConfigDefaults` + a `migrateConfig` Migration-Parity entry for no benefit. A named constant is the right altitude.
- No async rearchitecture: honoring an already-declared interface field + an outer budget fully resolves the reproduced failure class for human-authored specs. Async would be justified only if measurement ever showed specs approaching 150s, which the headroom makes implausible. This is a scoping boundary, not a promised future change.
- `DEFAULT_TIMEOUT_MS` unchanged → zero behavior change for every other reviewer/sentinel/classifier that calls `evaluate` without a budget.

## 5. Tests (Testing Integrity — covering each boundary the bug crossed)

- **Provider honors `timeoutMs` (both providers, both sides of the boundary):** assert `execFile` is invoked with `{ timeout: <passed value> }` when `options.timeoutMs` is set, and with `30_000` when it is absent. Use the existing `CodexCliIntelligenceProvider.test.ts` execFile-seam pattern; add the mirror for the Claude provider.
- **Reviewer passes the budget:** assert `StandardsConformanceReviewer.review` calls `intelligence.evaluate` with `timeoutMs === CONFORMANCE_REVIEW_TIMEOUT_MS` (a fake intelligence that records the options).
- **Middleware wiring-integrity (production map):** assert that the override map the server actually builds (via the extracted `buildRequestTimeoutOverrides()`) resolves `/spec/conformance-check` → `SPEC_REVIEW_TIMEOUT_MS`, `/spec/conformance-metrics` → default, and an arbitrary path → default. This must read the PRODUCTION map, not a hand-rolled one — a hand-rolled map would let the test pass while the server stays misconfigured (the PR #334 dead-code lesson).
- **Budget ordering invariant:** a cheap assertion that `CONFORMANCE_REVIEW_TIMEOUT_MS < SPEC_REVIEW_TIMEOUT_MS`, so the provider's clean kill always precedes the middleware 408.

## 6. Seven-dimension side-effects review

1. **Over/under-reach** — Provider change is gated behind `options?.timeoutMs` being present, so only opt-in callers are affected; default path byte-identical. Middleware override matches `/spec/conformance-check` (+children) only; `/spec/conformance-metrics` is a sibling, not a child, so it keeps the default (verified against the matcher `req.path === prefix || startsWith(prefix + '/')` + descending-length sort, `middleware.ts:297-310`).
2. **Level-of-abstraction fit** — Each edit sits at its correct layer: child-process budget in the provider, review budget in the reviewer, HTTP budget in the middleware wiring. No logic leaks across layers.
3. **Signal vs Authority** — Unchanged. The gate stays signal-only + fail-open; the fix only lets the review *finish* so it can emit its (advisory) signal. Blocking authority remains the separate later `scg-blocking-authority` item.
4. **Interactions** — `DEFAULT_TIMEOUT_MS` untouched ⇒ no impact on the dozens of other `evaluate` callers (classifiers, sentinels, tone gate). Middleware change is one additive key. The two budgets interact only via the ordering invariant (§5), which a test pins.
5. **Rollback cost** — Trivial and total: revert 4 small edits; no data, no state, no migration. Reverting restores prior (broken) behavior exactly.
6. **Migration parity** — N/A. All four edits are server/library runtime code shipped in the package; none touch agent-installed files (`.claude/settings.json` / config / CLAUDE.md template / hooks / skills). Existing agents get it on package update like all runtime code.
7. **Failure modes** — (a) Spec exceeds 150s → provider kills cleanly → fail-open degraded report (advisory), no 408, no regression vs today. (b) Someone later passes `timeoutMs` to a provider expecting the old hard 30s → covered by the default-unchanged guarantee + the both-sides test. (c) Override map drifts from the server's real wiring → prevented by testing the extracted production map. (d) Inner budget set ≥ outer → caught by the ordering-invariant test.

## 7. Scope boundaries

No async redesign and no config knob, for the reasons in §4 — these are deliberate scope limits with stated rationale, not unfinished work. Everything the reproduced failure requires is in §3.
