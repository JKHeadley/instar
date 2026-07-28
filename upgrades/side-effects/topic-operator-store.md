# Side-effects review — TopicOperatorStore (Know Your Principal, increment 2)

## What this change is
A new `src/users/TopicOperatorStore.ts` — a JSON-backed (`state/topic-operators.json`)
store for the verified per-topic operator, plus its unit test. Decoupled from
the ScopeVerifier topic→project binding by design (a topic can have an operator
without a project binding; TopicProjectBinding requires projectName/projectDir).

## Blast radius
- **Runtime impact: none.** Nothing constructs or imports TopicOperatorStore at
  boot or in any route/job/sentinel yet — adding it cannot change live behavior.
  The routes + session-start injection that consume it are later increments.
- Imports only `PrincipalGuard.establishOperator` (pure, already shipped in #902).
- New state file `state/topic-operators.json` is created lazily on first write;
  read fails safe to empty on missing/corrupt (a missing operator → the guard
  treats everything as unverifiable, which is the safe direction).

## Security review
- Operator establishment is uid-only by construction (delegates to
  establishOperator) — no path accepts a name from content as the operator
  (the Caroline failure mode is impossible).
- No network, no secrets, no new auth; one local JSON file.

## Framework generality
Pure logic + one local JSON file — no session-launch/inject/message-delivery
surface; framework-agnostic.

## Test coverage
10 unit tests (`tests/unit/topic-operator-store.test.ts`) covering both sides of
every boundary: valid-uid establish + read-back, blank-uid refusal, content-name-
never-becomes-operator, unbound→null, persistence across instances, replace,
asVerifiedOperator (feeds the guard), and sessionContextBlock (bound/unbound/uid-
fallback). tsc clean; docs-coverage class floor restored (TopicOperatorStore
documented in the Know Your Principal concept doc).

## Rollback
Delete the module + test + the doc mention; zero runtime consequence (no consumers).
