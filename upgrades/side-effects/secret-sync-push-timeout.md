# Side-Effects Review — Secret sync push timeout

**Version / slug:** `secret-sync-push-timeout`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`src/commands/server.ts`: the secret-sync provisioner's `send` passes `{ timeoutMs: 30_000 }` to `meshClient.send` for the `secret-share` command instead of using the mesh default of 5 s. Evidence (2026-10-31): `POST /secrets/sync-now` on the Studio reported `aborted` for the Mama PC three times, while the Mama PC's own log recorded `[secret-sync] stored 60 secret(s)` at each attempt; its vault read takes ~50 ms, so the slow part is the receiver's decrypt-and-write of the whole set before it answers. Tier 1: one call site, a waiting time.

## Decision-point inventory

None. No gate, block or filter changes.

## 1. Over-block

None: a longer wait cannot refuse anything.

## 2. Under-block

A really unreachable peer now reports failure after 30 s instead of 5 s; `sync-now` answers later. No other effect.

## 3. Level-of-abstraction fit

The per-call `timeoutMs` override exists for exactly this ("heavy commands", MeshRpcClient). The mesh default stays 5 s for every other command.

## 4. Signal vs authority compliance

Not a decision point.

## 5. Interactions

`provisionAll` sends to peers one after another, so one slow or dark peer delays the rest by up to 30 s each. The boot-time push runs in the background; `sync-now` is an explicit operator lever. Acceptable for a handful of machines.

## 6. External surfaces

None beyond the existing mesh request.

## 7. Multi-machine posture

Unchanged: secret sync is the replication path; this makes its success report truthful.

## 8. Rollback cost

Revert the one line.

## Conclusion

The sender stops reporting false failures for a peer that stored the secrets.

## Evidence pointers

- Mama PC `logs/server.log`, 2026-11-01T02:26:41Z, 02:27:00Z, 02:43:49Z: `[secret-sync] stored 60 secret(s) from m_03b30f5b…` (the Studio).
- Studio `POST /secrets/sync-now` at the same times: Mama PC `ok: false, reason: "This operation was aborted"`.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** No new self-triggered action; only the wait of an existing operator-started or boot-time send changes.
