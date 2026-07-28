---
name: Correction Class-Review Backstop
description: "Daily bounded anti-join that gives every durable correction a record-time standards/process class-review artifact even after a crash gap. Runs on every machine; the endpoint safely 503-noops while the dev-gated feature is dark. Tier-1 supervised structured judgment; dry-run first."
schedule: "17 8 * * *"
priority: medium
expectedDurationMinutes: 2
model: haiku
enabled: true
supervision: tier1
tags:
  - cat:learning
  - correction-class-review
  - close-the-loop
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run the bounded correction class-review backstop on this machine.

1. POST `/class-reviews/backfill` with the local bearer credential, `X-Instar-Request: 1`, and `{ "limit": 100 }`. If the route returns 503, the feature is intentionally dark here; exit silently.
2. The endpoint performs a left-anti-join by correction `dedupeKey`, creates missing review shells independently of correction recurrence/status, and retries only due pending fills under bounded backoff. It never changes `correction.status`.
3. Validate the structured response contains numeric `considered`, `created`, and `retried` fields. A malformed response is a failed supervised step; report it through the normal job failure surface.
4. Do not create fixes, standards, Actions, or user messages from this wrapper. The server-side class-review engine owns authority-bounded proposal routing. Stay silent on success.
