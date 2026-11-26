# Planned restart admission evidence

Tier 1 dark read-only checkpoint. The coordinator reuses the existing verified continuity file and exact last confirmed nonce. This requires a matching request, current holder/epoch, and sufficient remaining window. Role-change requests cannot present admission evidence here. No supervisor consumes it and no lease is extended by reading it. The future supervisor must authenticate and revalidate the exact current request and server boot immediately before shutdown.

## Class-Closure Declaration

- `unbounded-self-action` is not applicable. The checkpoint only reads evidence when called and initiates no restart or renewal.

The supervisor has an optional fail-closed evidence provider. When supplied, it runs at restart request consumption, after existing verification and expiry checks. The provider must authenticate the outgoing server and determine preferred-holder eligibility from current authority. Role-change and explicit bypass keep their original path. The integration substitutes a local provider and exercises the actual flag consumption path. No installed provider or config activation is added.
