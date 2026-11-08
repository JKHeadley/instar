# Server-down remote recovery

## What Changed

Added independently installed SSH and HTTPS recovery listeners with protected runtimes, signed owner grants and revocation, finite repair actions and shared durable budgets. Added setup and phone enrollment/control paths, source-bound route proofs, pool health and bounded peer repair. Trusted updates preserve and reconcile recovery bindings. Keep-awake cleanup now stops only its own helper.

## What to Tell Your User

Recovery setup checks whether each machine has two recently tested paths from the same peer. Missing grants, enrollment or proof show as setup needed or unknown. Your phone can enable or revoke individual routes, revoke a source and explicitly rearm bounded repair. Revocation shows pending until a target acknowledges; offline authority expires within 24 hours.

## Summary of New Capabilities

Peers can inspect and restart an enrolled machine's agent while its main server is stopped. Host SSH and the outbound public relay remain separate carriers. Owner approval, target identity, intentional sleep and finite repair budgets continue to apply.

## Evidence

Validation and live qualification are recorded in [the side-effects review](../side-effects/server-down-remote-recovery.md). Test agents were isolated and expiring; no laptop test agent was started.
