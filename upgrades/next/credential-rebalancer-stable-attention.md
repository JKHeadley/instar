# Credential rebalancer stops duplicating persistent Attention items

<!-- bump: patch -->

## What Changed

Persistent credential-rebalancer conditions now carry structural identity from
the policy that detects them. Their durable Attention item identity is derived
from the condition type and affected slot, rather than from the credential
ledger's changing version.

Repeated passes observing the same condition therefore reuse the existing
Attention item. Different slots and different condition types remain distinct.
One-off rebalancer episode notices retain their previous behavior while the
shared Attention condition model is developed separately.

## What to Tell Your User

The credential rebalancer will no longer keep adding duplicate queue items while
the same slot remains without an eligible rescue target. The first item remains
visible and actionable; later checks reuse it instead of filling the queue.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Stable credential-rebalancer condition items | Automatic whenever the rebalancer observes a persistent slot condition |

## Evidence

- The policy tests prove persistent notices carry their condition type and slot.
- The orchestrator tests prove repeated passes and changing ledger versions
  derive the same item identity for the same condition.
- Different slots and condition types derive different identities.
- Credential route lifecycle tests, the repository lint suite, and the build pass.
