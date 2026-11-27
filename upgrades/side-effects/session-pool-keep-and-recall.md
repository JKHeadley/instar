# Side-Effects Review — a live conversation stays put, and a moved one gets its recent messages

**Version / slug:** `session-pool-keep-and-recall`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** codex-cli gpt-6-astra, 2 rounds; first round's findings fixed; last round's verdict still serious, its design points stated as accepted limits, see the report

## Summary of the change

`SessionRouter` keeps an unowned key on this machine when a session for it is already running here, subject to every mandatory placement check, and confirms the claim at once. A new read-class mesh verb, `topic-history-pull`, lets a moved session fetch recent messages from the lease holder with no shared bearer token; the bearer call stays as the fallback and gains a deadline.

## Decision-point inventory

- Keep a live local session on a new placement — add — live session, no preferred machine, this machine passes placement alone with no escalation.
- Serve history to a peer — add — registered peer, read class, capped by the handler.

---

## 1. Over-block

Keep could hold a conversation on a busier machine when a peer is cheaper. That is the point: a running session is not moved for cost. Overload, a lost workspace and a blocked quota all still move it, because placement refuses this machine alone.

## 2. Under-block

Sessions away from the lease holder with no ownership record are not found. A failed confirm is not retried by the router. Both are stated in the spec.

## 3. Level-of-abstraction fit

Keep sits in the router, the one place Telegram, Slack and the drain share, and reuses `decide`, the CAS and `confirmClaim`. Recall follows the existing pull-verb pattern.

## 4. Signal vs authority compliance

No judgment moves into a brittle check. `liveLocalSession` is a fact from the session manager; placement keeps its authority over eligibility, and a pin still wins.

## 5. Interactions

The drain's `forceReplace` uses failover placement, which keep does not touch. The Telegram confirmation after delivery still runs and finds the row already `active`, a no-op. Moves are unaffected: a moved key has an owner, or its old session has closed.

## 6. External surfaces

One new mesh verb. An older peer answers `no-handler` and the bearer fallback carries it. No HTTP route, config or user-visible change. It discloses to this agent's own machines what the bearer route already does.

## 7. Multi-machine posture

This is multi-machine code. It is inert on one machine: no mesh, and no router past dark. History is read-only and holds no replicated state. Ownership changes go through the existing CAS and journal, so no second authority appears.

## 8. Rollback cost

Revert. No stored state. `enabled:false` stops all routing at once.
