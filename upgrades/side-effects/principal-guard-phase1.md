# Side-effects review — PrincipalGuard (Phase 1 brain)

## What this change is
A new pure-logic module `src/core/PrincipalGuard.ts` (operator establishment +
cross-principal attribution detector + warn/block evaluator) and its unit test.
Implements the detector half of the just-ratified "Know Your Principal" standard
(the cross-principal coherence guard from OPERATOR-IDENTITY-BINDING-SPEC.md §2).

## Blast radius
- **Runtime impact: none.** Nothing imports `PrincipalGuard` at boot or in any
  route/job/sentinel yet. Adding the file cannot change live behavior. It is the
  testable brain; wiring it into the topic-operator binding, session-start
  injection, and the outbound/at-rest review path are explicit later increments.
- **No I/O, no network, no new config/route/migration surface.** Pure functions
  over strings + a `VerifiedOperator` value object.
- **Establishment is uid-only by construction:** `establishOperator` takes the
  authenticated sender uid; there is NO code path that accepts a name from
  content as the operator (the Caroline failure mode is impossible by type).

## Security review
- The detector is conservative: a name must be capitalized (case-sensitive,
  not the `i` flag) and not in a non-principal stop-set, so "Production
  approved" / "The Board approved" do not flag. False positives warn (prose) or
  block (authority/credential) — they never silently pass a misattribution.
- No payload/secret handling; operates only on already-authored text.

## Framework generality
Pure logic, no session-launch/inject/message-delivery surface — framework-agnostic.

## Test coverage
13 unit tests covering both sides of every boundary: uid-only establishment
(incl. blank → null), each detection shape, non-principal rejection,
bound-operator pass, known-user pass, unknown-principal flag with block-vs-warn
tiering, no-operator case, and the **incident-replay regression test** — the
three real Caroline doc lines all caught (block for mandate/credential), and the
same lines crediting the bound operator all pass. `tsc --noEmit` clean.

## Rollback
Delete the module + test; zero runtime consequence (no consumers).
