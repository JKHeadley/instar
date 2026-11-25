# Side effects of optional relay agent identity verification

A dormant verifier accepts the TLS key observed at a candidate relay locator only when it matches the current holder's key in the independently pinned owner record. Its evidence reader uses a separately committed agent-scoped lease.

- The certificate must match the candidate hostname and be within its validity period. The configured agent, assignment and genesis must all match. A prior pin requires the same hostname and owner lineage, and a non-regressing holder epoch. Per-holder TLS revisions remain pinned across takeover because TLS announcements are side entries and do not advance the owner-record head.
- A relay locator, public certificate or fetched announcement supplies no owner authority by itself. The caller must hold the trusted registration and committed lease independently and use the observed certificate from the same connection before credentials or app requests.
- This helper does not fetch transition material, replace a persisted pin, or change TLS runtime behavior. Native integration and previously trusted record custody remain activation prerequisites.
- No service is enabled. Direct routes and owner pairing remain independent. Reverting requires no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. This is one caller-triggered evidence read and certificate check.

Independent rereview concurred with the effective TLS winner check and per-holder rollback protection across takeover.
