# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Internal LLM reliability is now judged per component, not hidden inside one aggregate.**
The feature-metrics response includes each component's LLM error rate with its
real-call denominator and a reliability summary. The health response becomes
degraded when a component with at least 20 real calls crosses a 20% error rate,
and reports the component, errors, denominator, and severity. A failed metrics
read is explicitly `unavailable`, never an empty healthy result.

Three known timeout failures are also corrected. Profile-intent classification
now separates its four-second primary attempt from a 15-second overall fallback
budget. Completion verification gets a 60-second attempt and no longer enters a
nested deferrable queue. Topic-intent extraction gets the same 60-second
long-observer budget.

## What to Tell Your User

Nothing to configure. Health reporting may now correctly show a degraded
internal LLM component that the old aggregate hid. The response names the
affected component and includes the denominator so the result can be assessed.

## Summary of New Capabilities

- Per-component LLM error rate and reliability severity in feature metrics.
- Component-level internal LLM reliability in the health response.
- An explicit unavailable state when reliability cannot be enumerated.
- Workload-specific timeout budgets for the affected classifier and observers.

## Evidence

- Failure-first unit and integration coverage proves a 90% failing component is
  surfaced even while the aggregate error rate remains below 10%.
- The health route is covered for all three outcomes: healthy, component
  failure, and metrics unavailable.
- Call-site tests pin the separated profile attempt/overall budgets, the
  completion observer's 60-second non-deferrable call, and the extractor's
  60-second attempt.
- TypeScript typecheck and 100 targeted unit, integration, and end-to-end tests pass.
