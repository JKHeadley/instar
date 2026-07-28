# Side-Effects Review — conformance-gate timeout fix

**Slug:** `conformance-gate-timeout`
**Date:** `2026-05-26`
**Author:** Echo
**Spec:** `docs/specs/conformance-gate-timeout.md` (converged v1, approved by Justin 2026-05-26)
**Second-pass reviewer:** independent adversarial reviewer concurred ("blocking finding closed, nothing missing") after catching the second 30s wall in the v0 draft.

## Summary of the change

`POST /spec/conformance-check` (the Standards-Conformance Gate, auto-wired into `/spec-converge` by PR #403) timed out (HTTP 408 at 30s) on a real ~400-line spec. Root cause is **two** 30s walls: (A) the route was never added to the `requestTimeout` middleware's `perPathOverrides`, and (B) both `ClaudeCliIntelligenceProvider` and `CodexCliIntelligenceProvider` hardcoded `execFile(..., { timeout: 30_000 })` and ignored the `IntelligenceOptions.timeoutMs` the interface already defines, while the reviewer never passed one. A middleware-only fix would have converted the loud 408 into a silent empty `degraded` report (worse).

Fix (4 source edits):
1. Both providers: `timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS` (default 30s unchanged for every other caller).
2. `StandardsConformanceReviewer`: pass `timeoutMs: CONFORMANCE_REVIEW_TIMEOUT_MS` (150_000).
3. `middleware.ts`: exported `OUTBOUND_MESSAGING_TIMEOUT_MS`, new `SPEC_REVIEW_TIMEOUT_MS = 180_000`, `buildRequestTimeoutOverrides()` (single source of truth, now includes `/spec/conformance-check`), and `resolveRequestTimeout()` (matching logic extracted + shared with tests).
4. `AgentServer.ts`: wires `requestTimeout(..., buildRequestTimeoutOverrides())` instead of an inline literal.

## Decision-point inventory

No new decision point is created. The gate stays **signal-only + fail-open** — the change only lets the review *finish* so it can emit its (advisory) report. No blocking authority added (that remains the separate later `scg-blocking-authority` item).

## Seven-dimension review

1. **Over/under-reach** — Provider change is gated behind `options?.timeoutMs` being present, so the default path is byte-identical for every other `evaluate` caller (classifiers, sentinels, tone gate). Middleware override matches `/spec/conformance-check` (+children) only; the fast sibling `/spec/conformance-metrics` keeps the default — asserted by `resolveRequestTimeout('/spec/conformance-metrics', …) === default` in the unit test.
2. **Level-of-abstraction fit** — Each edit sits at its correct layer: child-process budget in the provider, review budget in the reviewer, HTTP budget in the middleware. No cross-layer leakage.
3. **Signal vs Authority** — Unchanged; verified above.
4. **Interactions** — The two budgets interact only through the ordering invariant `CONFORMANCE_REVIEW_TIMEOUT_MS (150s) < SPEC_REVIEW_TIMEOUT_MS (180s)`, pinned by a test, so the provider's clean kill fires before the middleware 408 → fail-open, not a raw timeout.
5. **Rollback cost** — Trivial and total: revert the edits; no data, no state, no migration.
6. **Migration parity** — N/A. All edits are server/library runtime code shipped in the package; none touch agent-installed files (`.claude/settings.json` / config / CLAUDE.md template / hooks / skills). Existing agents receive it on package update like all runtime code.
7. **Failure modes** — (a) Spec exceeds 150s → provider kills cleanly → fail-open degraded report (advisory); no 408, no regression vs today. (b) A caller passing `timeoutMs` to a provider expecting the old hard 30s → covered by the default-unchanged guarantee + the both-sides provider tests. (c) Override map drifting from the server's real wiring → prevented by testing the extracted production map/matcher. (d) Inner budget set ≥ outer → caught by the ordering-invariant test.

## Tests added/changed

- `tests/unit/ClaudeCliIntelligenceProvider-timeout.test.ts` (new) and an added block in `tests/unit/CodexCliIntelligenceProvider.test.ts`: behavioral — short `timeoutMs` kills a slow fake binary (regression catcher: pre-fix this budget was ignored), generous/absent budget resolves (honors longer; 30s default unchanged).
- `tests/unit/standards-conformance-gate.test.ts`: asserts the reviewer passes `timeoutMs === CONFORMANCE_REVIEW_TIMEOUT_MS` to the provider.
- `tests/unit/AgentServer-outbound-timeout.test.ts`: rewritten from a brittle source-regex into a wiring-integrity test that imports the production `buildRequestTimeoutOverrides()` + `resolveRequestTimeout()` and asserts `/spec/conformance-check` → 180s, `/spec/conformance-metrics` → default, plus the ordering invariant and that AgentServer wires the shared builder.

All 44 tests across the four files pass. Independent reviewer re-verified the revised plan against live code.
