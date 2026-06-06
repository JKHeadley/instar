# Side-effects review — Phase-2 LLM judge for ORG-INTENT governance (CMT-1128)

## What this change does

Adds the semantic resolver the keyword matcher's honesty work (#899) pointed
at: when the keyword-overlap refusal test MISSES, one bounded LLM call judges
whether any ORG-INTENT constraint forbids the action by MEANING. Surfaces:
(1) `judgeRefusal()` in IntentTestHarness.ts (the judge primitive),
(2) `resolveExpectationJudged()` in ScenarioPack.ts (the red-team harness
Phase-2 resolver), (3) POST /intent/org/test-action escalates a keyword miss
to the judge when `monitoring.orgIntentLlmJudge.enabled` is true AND an
intelligence provider is configured. Ships DARK (default false).

## Decision boundary (both sides tested)

- Keyword MISS + judge says forbidden → governed/refused with
  `method: 'llm-judge'` and the semantically-matched constraint (the live
  boundary-map replay: "unverified work as completed" governs "estimates as
  confirmed numbers"; the unit test FIRST proves the keyword matcher misses
  this exact pair, then proves the judge closes it).
- Keyword MATCH → short-circuit: heuristic verdict returned, provider never
  called (call-count asserted). The pre-filter contract from types.ts:
  heuristics narrow candidates, the provider decides.
- Judge requested but unavailable (provider throws / circuit open / malformed
  reply) → heuristic verdict stands with `judgeUnavailable: true`; route
  still 200 (unit + integration + e2e).
- Judged not-forbidden → `method: 'llm-judge'` ungoverned with
  judgment-not-ground-truth framing in the reason string.
- Flag OFF (or no provider) → byte-compatible Phase-1 response, zero provider
  calls (integration + e2e).

## Blast radius

- `src/core/IntentTestHarness.ts`: additive exports (`judgeRefusal`,
  `JudgeMethod`, `JudgedRefusalResult`, `JudgeOptions`); the existing class
  and its keyword logic are untouched (its 9 tests pass unmodified).
- `src/redteam/ScenarioPack.ts`: `ResolvedExpectation.method` widened to the
  `'keyword-heuristic' | 'llm-judge'` union (additive — the sync
  `resolveExpectation` still always reports `'keyword-heuristic'`; its
  honesty test passes unmodified); new optional `judgeUnavailable` field; new
  async `resolveExpectationJudged`.
- `src/server/routes.ts`: the test-action handler computes the heuristic
  verdict exactly as before, then — only inside the flag+provider guard —
  escalates a miss. Flag-off path emits the identical response object.
- `src/core/types.ts`: new optional `monitoring.orgIntentLlmJudge` config
  block. No migrateConfig (absent → off, the principalCoherence sibling
  convention).
- LLM spend: at most ONE fast-model call per keyword-missed test-action
  request (or per scenario hint in the red-team resolver), temperature 0,
  maxTokens 250, 8s timeout, attributed `IntentLlmJudge`/`gate` so
  /metrics/features and burn detection see it. No background loop — the
  judge only runs inside an explicit request.
- No new routes (route floor untouched), no new core class files (class
  floor untouched), no migration surface, no subprocess.

## Migration parity

No agent-installed files change (no hooks, no config defaults written, no
CLAUDE.md template text, no skills). The config flag is opt-in and absent
means off — nothing to migrate.

## Framework generality

Framework-agnostic: the judge consumes the IntelligenceProvider interface,
so per-component framework routing (`IntentLlmJudge` under category `gate`)
applies — the judge can run on whichever framework the routing table says.

## Tests

- `tests/unit/intent-llm-judge.test.ts` — 16 tests: judgeRefusal verdict
  parsing both sides, prose-wrapped JSON, malformed/typed-wrong replies,
  provider throw, no-constraints short-circuit, out-of-range index tolerance,
  call-options pinning (fast/temp-0/attribution/timeout);
  resolveExpectationJudged: the boundary-map replay (keyword miss proven,
  judge governs), keyword-match short-circuit (zero provider calls), judge
  unavailable honesty, judged-ungoverned framing, multi-hint iteration,
  mixed failure+verdict semantics.
- `tests/integration/intent-llm-judge-route.test.ts` — 5 tests over the full
  HTTP pipeline: judged governance over the wire, match short-circuit,
  unavailable honesty, flag-off byte-compatibility, flag-on-without-provider.
- `tests/e2e/intent-llm-judge-lifecycle.test.ts` — 3 tests on a REAL
  AgentServer.start(): feature-alive (200 + llm-judge verdict through the
  production options seam), judge problem never breaks the route, dark
  server byte-compatible.
- Regression canaries green: IntentTestHarness (9), redteam-scenario-pack
  (26), org-intent-routes (21), mtp-protocol-test-action-lifecycle (4),
  no-silent-fallbacks (5); tsc clean; docs-coverage --check passes (floors
  hold — no new routes or class files).

## Rollback

Delete the judge block in the test-action route, the two new functions, the
type widening, and the config block. No state, no migrations, no on-disk
artifacts to unwind (verdicts are request-scoped).
