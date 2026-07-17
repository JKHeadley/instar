# Side-Effects Review — Mesh endpoint advertisement without tunnel success

**Version / slug:** `mesh-endpoint-advertisement-without-tunnel`
**Date:** `2026-07-16`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `not required`

## Summary

The boot composition root now runs self endpoint discovery after the optional
tunnel attempt rather than only inside its success branch. A resolved
Cloudflare URL is still recorded as before; LAN and Tailscale ropes are now
advertised when Cloudflare is unavailable. Pool-presence and session-routing
calls select the first validated candidate from the existing shared endpoint
resolver rather than reading only the legacy Cloudflare URL.

## Decision-point inventory

- Boot tunnel result — **modified** — no longer controls whether non-tunnel
  mesh endpoints are advertised.

## 1. Over-block

No block/allow surface — over-block is not applicable. Advertisement remains
gated by an enrolled machine identity and the existing
`meshTransport.enabled` switch.

## 2. Under-block

Detection failures remain best-effort and omit only the failed rope. A machine
with no working LAN, Tailscale, or Cloudflare path remains honestly
unreachable. Tunnel recovery that happens later still relies on the existing
TunnelManager/sleep-wake re-advertisement lifecycle; this boot fix does not add
a competing recovery loop.

## 3. Level-of-abstraction fit

The boot composition root is the correct layer because it owns tunnel startup,
endpoint advertisement, and the shared peer URL seam used by presence/session
calls. The existing `PeerEndpointResolver` remains the sole validation and
priority authority; no parallel endpoint-selection logic is added.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

This is transport discovery and idempotent registry wiring. It removes an
accidental dependency; it does not interpret intent, filter information, or
make a judgment decision.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The enumerable
rule is that every independently detected healthy transport may be advertised;
one optional transport's startup outcome does not authorize the others.

## 5. Interactions

The endpoint write is idempotent. A successful tunnel contributes its URL; a
failed quick tunnel contributes `null`, leaving LAN/Tailscale intact. Later
tunnel recovery and sleep/wake re-advertisement use the existing idempotent
path and can add or replace the Cloudflare rope. Callers receive one validated
candidate exactly as before; the candidate may now be LAN or Tailscale when
Cloudflare is absent.

## 6. External surfaces

`GET /pool` becomes more honest because reachable peers retain advertised
ropes during a tunnel outage. Registry schema, authentication, mesh RPC, and
operator actions are unchanged. The existing machine registry gains endpoint
values it was already designed to carry; no new external request is introduced.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** Each machine discovers its own physical endpoints and writes
them to its self-owned registry row. The existing authenticated registry-sync
path propagates that row to peers, which consume it through the endpoint
resolver and pool heartbeat. There are no user-facing notices, no topic-bound
durable state, and no generated user URL. Cloudflare URLs continue to cross
machine boundaries through the existing `lastKnownUrl` and endpoint fields.

## 8. Rollback cost

Pure code rollback with no migration. Rolling back restores the failure where
a tunnel outage suppresses every endpoint at the next boot.

## Evidence

- `tests/unit/mesh-url-advertisement-wiring.test.ts`
- `tests/unit/MeshEndpointAdvertiser.test.ts`
- `tests/unit/mesh-url-advertiser.test.ts`
- Live single-agent CROSS-MACHINE laptop/Mini health probes.

## Conclusion

The fix is narrow and clear to ship. It restores the intended independence of
the three existing mesh transports without changing their security, priority,
or retry policies.

## Second-pass review

Not required: this does not touch messaging block/allow, session lifecycle,
compaction, a coherence gate, trust, or a sentinel/guard/watchdog.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller is added or
modified — not applicable.
