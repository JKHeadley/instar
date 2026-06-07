# SubscriptionPool multi-account registry (P1.1)

<!-- bump: minor -->

## What Changed

Added `SubscriptionPool` — a new file-backed registry that records an operator's
subscription accounts, the first building block of the Subscription & Auth
Standard (multi-account quota-aware load balancing). Each account entry carries a
nickname, its provider and framework, a lifecycle status, and — by design — only
the LOCATION of its login (its config home, e.g. the per-account
`CLAUDE_CONFIG_DIR`), never any tokens. A structural guard rejects any attempt to
store a credential-bearing field, so "store the location, not the secret" is
enforced in code rather than by convention.

A CRUD API was added behind the new `/subscription-pool` route family
(GET / POST / PATCH / DELETE), wired through the server, AgentServer, and route
context. The registry is file-backed (atomic write, per-record version counter),
mirroring the existing CommitmentTracker durable-registry pattern.

This ships DARK and ADDITIVE: an empty pool is a pure no-op, so single-account
agents are unaffected. The route is deliberately classified agent-internal for
now (it does not appear in the capabilities self-discovery surface and is not yet
mentioned in the agent template), because a bare registry with no enrollment
wizard or quota-aware scheduler is not a finished capability to advertise. It
graduates to a surfaced capability when those later phases land.

Coverage: 27 tests across all three tiers — unit (both sides of every validation
boundary, the credential-rejection guard, corruption resilience), integration
(full CRUD over real HTTP), and an e2e feature-alive check (the route answers 200
in the dark state and supports live enroll / read-back / persisted-to-disk).

## What to Tell Your User

I've started building the system that lets me manage several of your
subscriptions at once. The first piece just remembers each account by a friendly
nickname and where it logs in — never its passwords or tokens, which stay where
your real login tool keeps them. Nothing changes for you yet: it's switched off
until the later pieces (logging in from your phone, and automatically switching
accounts before one hits its limit) are ready. When you ask me to set that up, I
can walk you through it then.

## Summary of New Capabilities

- **Subscription account registry** — records each subscription account (nickname,
  provider, framework, login location, status). Stores the login location only,
  never credentials; a structural guard rejects credential-bearing fields.
- **Account management API** — list, add, rename/re-status, and remove accounts
  via the new `/subscription-pool` routes (operator/internal for now).
- **Dark + additive** — an empty pool is a no-op; existing single-account agents
  are unaffected, and the capability stays agent-invisible until the enrollment
  wizard and quota-aware scheduler make it user-usable.
