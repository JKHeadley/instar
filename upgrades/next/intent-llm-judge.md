---
bump: patch
audience: agent-only
maturity: experimental
---

## What Changed

Phase-2 LLM judge for ORG-INTENT governance (CMT-1128): when the
keyword-overlap refusal test misses, POST /intent/org/test-action (and the
red-team harness expectation resolver) can now escalate to one bounded LLM
call that judges whether a constraint forbids the action by meaning rather
than wording — closing the keyword matcher's false-negative side that the
first boundary-map run exposed. Verdicts carry their method: llm-judge is
claimed only for a real, parsed LLM verdict; a judge problem keeps the
heuristic verdict and flags judgeUnavailable. Ships dark behind
monitoring.orgIntentLlmJudge.enabled and requires a configured intelligence
provider; with the flag off the route response is byte-for-byte unchanged.

## What to Tell Your User

Nothing — this ships dark and is an internal governance-testing improvement.
If they previously saw an intent boundary report calling something
"ungoverned," that verdict was keyword-based and conservative; once this
feature is enabled, those misses get a semantic second opinion before being
reported as candidate gaps.

## Summary of New Capabilities

- judgeRefusal in IntentTestHarness: one bounded fast-model call (temperature
  0, 8s timeout, attributed IntentLlmJudge/gate for /metrics/features)
  judging an action against the constraints by meaning.
- resolveExpectationJudged in the red-team ScenarioPack: keyword pre-filter,
  LLM decision, honest judgeUnavailable signal.
- POST /intent/org/test-action escalates keyword misses to the judge when
  monitoring.orgIntentLlmJudge.enabled is true; refusal verdicts then carry
  their method.

## Evidence

tests/unit/intent-llm-judge.test.ts (16, including the boundary-map replay
that first proves the keyword miss and then proves the judge closes it),
tests/integration/intent-llm-judge-route.test.ts (5, full HTTP pipeline both
flag states), tests/e2e/intent-llm-judge-lifecycle.test.ts (3, real
AgentServer.start with the provider injected through the production seam).
Regression canaries IntentTestHarness + redteam-scenario-pack +
org-intent-routes + mtp-protocol lifecycle + no-silent-fallbacks all green;
clean tsc; docs-coverage floors hold.
