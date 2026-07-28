# PrincipalGuard — module reference

`src/core/PrincipalGuard.ts` is the pure-logic detector behind the **Know Your
Principal** constitution standard (`docs/STANDARDS-REGISTRY.md`) and the
operator-identity binding spec (`docs/specs/OPERATOR-IDENTITY-BINDING-SPEC.md`).
It is the Phase-1 brain of the cross-principal coherence guard born from the
"Caroline" identity-bleed incident (CMT-1125): an autonomous session silently
credited its operator's decisions to a different real principal, in the agent's
own output, where no inbound gate watched.

## API

- **`establishOperator(authenticatedUid, displayName?)` → `VerifiedOperator | null`**
  Establish a topic's operator ONLY from the platform-verified sender id. There
  is no path that accepts a name from content as the operator — the Caroline
  failure mode is impossible by type. A blank uid yields `null` (an unbound
  topic, which the evaluator treats as "everything is unverifiable").

- **`detectAttributions(text)` → `Attribution[]`**
  Find operator-role-decision shapes in agent-authored text: `mandate`,
  `approval`, `lock`, `credential`, `acting-for` (e.g. "Mandate (X)", "X
  approved", "locked with X", "X dropped a token", "on behalf of X"). The
  principal NAME must be capitalized; capitalized non-names ("Production
  approved", "The Board approved") are not flagged.

- **`evaluatePrincipalCoherence(text, operator, knownUserNames?)` → `PrincipalFinding[]`**
  Flag any attribution to a principal who is neither the bound operator nor a
  known user (from `UserManager`). Authority/credential misattributions
  (`mandate`, `credential`) → **block**; prose → **warn**. An attribution to the
  bound operator or any known user resolves cleanly and is not flagged.

## Status

Pure logic, deterministic, no I/O — **no runtime consumers yet**. The later
increments wire it into the topic-operator binding, the session-start
"who is my operator" injection, and the outbound/at-rest review path. Verified
by `tests/unit/principal-guard.test.ts` (13 tests) including the incident-replay
regression: the real Caroline doc lines are all caught with the topic bound to
the operator, and the same lines crediting the bound operator all pass.
