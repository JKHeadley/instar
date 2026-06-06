---
bump: minor
audience: agent-only
maturity: experimental
---

## What Changed

Added `src/core/PrincipalGuard.ts` — the pure-logic brain of the "Know Your
Principal" cross-principal coherence guard (constitution standard ratified in
#898). It establishes a topic's operator only from the authenticated sender,
detects operator-role-decision attributions in agent-authored text ("X
approved", "Mandate (X)", "locked with X", "X dropped a token"), and flags any
credited to a principal who is neither the bound operator nor a known user —
blocking authority/credential misattributions, warning on prose. No runtime
consumers yet (the wiring is a later increment).

## What to Tell Your User

Nothing user-facing changes. This is foundation code (experimental) for the
security fix behind the Caroline identity-bleed incident — it does not alter any
current behavior.

## Summary of New Capabilities

- `PrincipalGuard` (experimental, no runtime consumers yet): `establishOperator`,
  `detectAttributions`, `evaluatePrincipalCoherence`.

## Evidence

Net-new capability. Verified by 13 unit tests including the incident-replay
regression test (the three real Caroline doc lines all caught with the topic
bound to the operator; the same lines crediting the operator all pass) and a
clean `tsc --noEmit`.
