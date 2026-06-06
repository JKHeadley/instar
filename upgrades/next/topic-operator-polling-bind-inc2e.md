---
bump: patch
audience: agent-only
maturity: experimental
---

## What Changed

The verified topic operator is now recorded automatically on BOTH inbound
ingress paths (Know Your Principal standard, security-build increment 2e — the
final operator-binding gap). Increment 2d covered only the lifeline-forward
route; the adapter long-poll (no-lifeline) path never bound. The bind now lives
at the shared `onTopicMessage` seam (`wireTelegramRouting`), guarded by
`isAuthorizedSender` — load-bearing there, because the seam also fires for
unauthorized senders. The seam resolves the server's own store instance
late-bound (a second instance on the same file would lose updates between the
two in-memory caches), and `TopicOperatorStore.setOperator` now skips the disk
write when the record is unchanged (per-message re-binds become pure reads).

## What to Tell Your User

Nothing user-facing changes. Foundation wiring (experimental) for the identity
isolation security work: the agent now learns its verified operator from
authorized inbound messages no matter how its Telegram connection is set up.
Only authorized senders are ever recorded, and a recording failure never
affects message handling.

## Summary of New Capabilities

- Operator auto-bind at the `onTopicMessage` convergence seam (covers the
  polling path; authorized senders only; fail-soft; pre-boot messages bind
  nothing, fail-safe).
- `AgentServer.getTopicOperatorStore()` — public accessor for the seam's
  late-bound store resolution.
- `TopicOperatorStore.setOperator` idempotency: identical record → no disk
  write.

## Evidence

Verified by 6 Tier-1 unit tests (`topic-operator-polling-bind`: authorized
binds, unauthorized Caroline refusal, null store / getter throw / setOperator
throw all fail-soft with routing continuing, missing uid no-op), 2 Tier-1 store
tests (idempotent skip both sides), and 3 Tier-2 integration tests
(`topic-operator-polling-bind`: full Caroline replay through the seam,
single-instance no-clobber across two topics on disk, pre-construction →
post-construction lifecycle). All 60 existing topic-operator/session-context
canaries and 13 e2e lifecycle tests stay green. Clean `tsc --noEmit`.
