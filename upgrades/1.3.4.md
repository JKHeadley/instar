# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Standards-Conformance Gate (`POST /spec/conformance-check`, auto-invoked during `/spec-converge`) could not review a real, full-size spec — it timed out. The review hit **two** independent 30-second walls:

1. The HTTP request-timeout middleware applied its 30s default to the route — the conformance route was never added to the per-path override map that already gives the LLM-backed messaging routes a longer budget.
2. Both intelligence providers (`ClaudeCliIntelligenceProvider`, `CodexCliIntelligenceProvider`) hardcoded their `execFile` child-process timeout at 30s and ignored the `IntelligenceOptions.timeoutMs` the interface already defines, and the reviewer never passed one.

A middleware-only fix would have been worse than the bug: past the outer wall, the model call still died at 30s inside the provider, and the reviewer swallows that throw into an empty `degraded` report — turning a loud 408 into a silent "no findings," which reads like the spec passed.

The fix removes both walls: the providers now honor `options.timeoutMs ?? DEFAULT` (the 30s default is unchanged for every other caller — opt-in only); the conformance reviewer passes a 150s budget; the middleware grants the route a 180s outer budget (above the inner 150s so a genuinely-too-slow review degrades fail-open instead of erroring at the client). The override map and its longest-prefix matcher were lifted into `middleware.ts` as a single source of truth so a wiring-integrity test asserts the exact production config. The gate remains signal-only and fail-open — this only lets the review finish so it can emit its advisory report.

## What to Tell Your User

- **Spec self-review now works on real specs**: When you put a spec through review, the automatic constitution check can now actually finish on a full-length spec instead of quietly giving up — so it reports real concerns instead of a misleading "all clear."
- It is still advisory only — it flags things for me to weigh, it never blocks on its own, and nothing on your end changes.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conformance gate completes on full-size specs | Automatic during spec review (no longer times out at 30s) |
| Providers honor a per-call time budget | Automatic — internal callers that need a longer LLM call now get it; the 30s default is unchanged for everything else |

## Evidence

**Failure reproduced (before):** Dogfooding the gate against a real ~400-line spec (the feedback-factory-migration draft, 18,218 chars) returned `HTTP 408 {"error":"Request timeout","timeoutMs":30000}`. Reading the code confirmed the second wall: both providers call `execFile(..., { timeout: DEFAULT_TIMEOUT_MS=30_000 })` and never read `options.timeoutMs`; the reviewer (`standards-conformance.ts`) passed no budget and returns `{ degraded: true, degradeReason: 'error' }` on any throw.

**Verified to stop (after):** Built this branch and ran the actual `StandardsConformanceReviewer.review()` (real `ClaudeCliIntelligenceProvider`, model `capable`/opus) against that same 18,218-char spec and the live 23-article constitution:

```
=== RESULT after 36.9s ===
degraded: false
standardsChecked: 23
findings: 1
  - [Building] Testing Integrity: The spec sets parity-against-Python as the sole acceptance bar and explicitly subordinates...
```

The review ran for **36.9 seconds — past the exact 30s wall that previously killed it** — and returned a non-degraded report with a real finding. Pre-fix, this identical call is killed at 30s by the provider and yields an empty `degraded` report; post-fix it completes and emits real signal.

**Mechanism regression-locked by behavioral tests** (not mocks): new tests spawn a slow real subprocess and prove a short `timeoutMs` now kills the call while a generous/absent budget lets it finish (both providers); the reviewer is asserted to pass `CONFORMANCE_REVIEW_TIMEOUT_MS`; and the production override map/matcher resolve `/spec/conformance-check` → 180s while the fast sibling `/spec/conformance-metrics` stays on the default. Full push suite: 983 files, 18,458 tests, 0 failures.
