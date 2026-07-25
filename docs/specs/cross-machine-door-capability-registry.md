---
title: "Cross-Machine Door + Capability Registry"
slug: "cross-machine-door-capability-registry"
author: "codey"
status: draft
approved: false
review-convergence: pending
spec-only: true
---

# Cross-Machine Door + Capability Registry

## Scope and status

This is a deliberately incomplete, spec-first draft for ACT-409. It proposes a
cross-machine read model; it does not implement routes, storage, mesh verbs, or
fleet rollout. Open questions are recorded instead of guessed. Justin's
convergence review and the reviewer lanes are expected to settle them.

## Problem

Instar already has two useful but separate truths:

- `GET /doorways` is the doorway/model knowledge registry. It describes how a
  machine can reach model providers and overlays machine-local probe state.
- The multi-machine pool surfaces (`GET /pool`, pool machine records, mesh
  endpoint propagation, leases, placement, and capability advertisements)
  describe machines and some operational reachability.

Neither is a durable, queryable answer to: “Which machine can serve this
capability, through which doorway, with what freshness and authorization
posture?” Operators must join local `/doorways` data to pool data manually.
That creates stale routing, ambiguous failures, and multi-machine friction: a
capability can be present in a peer's config but unavailable at runtime, or a
door can be reachable locally while its advertised peer endpoint is stale.

The cross-machine registry adds a bounded, machine-qualified read model that
links a capability to its serving machine(s), doorway, endpoint reference,
verification time, and honest status. It is a projection, not a new authority:
local doorway truth and authenticated machine/mesh state remain the sources.

## Design principles

1. **Read model, not control plane.** v1 discovers and reports; it does not
   migrate sessions, mint credentials, or automatically route work.
2. **Source-linked freshness.** Every row names its source (`doorways` or pool /
   mesh observation), observed-at time, and freshness class. Missing or stale
   data is represented explicitly, never omitted or converted to “available.”
3. **Machine-qualified identity.** Keys include stable machine id and capability
   id. Nicknames and URLs are display fields, not identity.
4. **Authenticated, untrusted remote data.** Peer snapshots are accepted only
   through existing machine-authenticated mesh paths, then schema-clamped as
   untrusted data. Remote descriptions never become instructions or executable
   commands.
5. **Least disclosure.** Store endpoint references and capability metadata, not
   tokens, private model prompts, or raw credential locations. Pool scope obeys
   existing operator authorization.
6. **Deterministic conflict handling.** A local live observation outranks an
   older peer claim; contradictory claims remain visible with provenance rather
   than being silently merged.

## Proposed record (v1)

The registry is a durable, machine-local projection with a pool read assembled
from authenticated peer projections:

```json
{
  "schemaVersion": 1,
  "machineId": "mesh-machine-id",
  "entries": [{
    "capabilityId": "models:anthropic/claude-opus-4-8",
    "capabilityKind": "model|route|service",
    "doorwayId": "claude-code",
    "machineId": "mesh-machine-id",
    "status": "available|unavailable|unknown|stale|conflict",
    "endpointRef": "mesh://machine/doorways",
    "observedAt": "2026-07-25T00:00:00Z",
    "expiresAt": "2026-07-25T00:10:00Z",
    "source": "local-doorways|peer-pool|mesh-heartbeat",
    "evidence": { "doorwayScanAt": "...", "machineEpoch": 42 }
  }]
}
```

`endpointRef` is an opaque route reference, never a bearer URL. `expiresAt` is
required for remotely derived rows. A row without a fresh observation cannot
be selected as available by a future routing consumer.

## Surfaces and ownership (proposed)

- `GET /capability-registry` — this machine's redacted projection; always
  returns a truthful empty/unknown state when no observations exist.
- `GET /capability-registry?scope=pool` — operator-authorized merge of peer
  projections, with per-machine failure rows and age/freshness preserved.
- `POST /capability-registry/refresh` — bounded, read-only refresh trigger;
  no automatic routing or credential use.
- `/capabilities` advertises the read surfaces once implemented.

The existing `/doorways` registry remains authoritative for doorway/model facts
on each machine. Existing pool and mesh endpoint routes remain authoritative for
machine identity and transport reachability. The new registry owns only the
join, freshness classification, and conflict presentation.

## Alternatives considered

### A. Proxy `/doorways` from every peer on each request

Rejected for v1: it couples dashboard latency to peer availability, creates
partial-response ambiguity, and makes repeated reads expensive. It may be a
later “live probe” mode layered over the durable projection.

### B. Copy every peer's doorway JSON into one canonical global store

Rejected: it creates a second authority, loses machine-local posture, and makes
conflicts look like consensus. Keep projections machine-local and merge only at
the read surface.

### C. Let the scheduler route work immediately from the registry

Deferred: stale or conflicting capability data must first soak. v1 is
observe-only; a later routing proposal must define admission, lease ownership,
fallback, and operator override separately.

### D. Use one generic “online” boolean

Rejected: online transport does not prove a doorway or capability is usable.
Rows retain independent doorway, mesh, and freshness evidence.

## Rollout ladder and rollback

### Increment 0 — schema and read-only local projection (dark)

Define the schema, validation limits, source adapters, and a local status
reader. No route is mounted and no peer traffic is added. Rollback is deleting
the unreferenced schema/reader; no user state is authoritative.

### Increment 1 — test rung

Fixture tests cover local `/doorways` joins, stale expiry, conflicting peer
claims, malformed remote rows, and partial pool failures. A synthetic two-machine
mesh proves machine identity and no-token disclosure. Rollback is disabling the
test-only adapter; no production behavior changes.

### Increment 2 — development agent (observe-only)

Mount `GET /capability-registry` locally and populate from this agent's actual
doorway scan plus authenticated pool observations. Add a bounded refresh job
disabled by default. Rollback is an explicit dark flag that makes routes return
the documented unavailable/unknown state and stops refresh; retain no routing
decisions.

### Increment 3 — fleet dark read surface

Ship the route and schema to fleet agents, but keep peer scope and refresh dark
unless the fleet flag is enabled. Monitor freshness, conflict, payload size,
peer failure rates, and disclosure audits. Rollback is the fleet flag off and
versioned schema reader retained for forward compatibility.

### Increment 4 — fleet observe-only

Enable pool read/refresh for a bounded cohort. Publish metrics and one
aggregated attention item for sustained stale/conflict conditions. No consumer
may make routing or admission decisions from this surface yet. Rollback is
cohort disable plus refresh stop; stale rows expire naturally.

### Future increment — supervised routing (not in this spec)

Only after convergence and soak evidence may a separate spec authorize a
consumer. It must define lease ownership, fallback, operator override, and a
hard fail-closed rule for unknown/stale capability claims.

## Security, privacy, and multi-machine failure posture

- Peer reads require existing machine authentication and authorization; no new
  trust path is implied by this registry.
- Clamp counts, strings, arrays, timestamps, and enum values on write and read.
- Never return tokens, credential paths, raw model prompts, or private tunnel
  URLs. Pool rows are machine-qualified and redacted.
- A peer timeout, stale epoch, malformed payload, or clock-skew rejection yields
  a named failure row, not an omitted machine.
- Local and remote evidence are labeled separately. “Unknown” is not “down,”
  and “reachable” is not “capable.”

## Open questions for convergence

1. **Canonical capability vocabulary:** Should v1 limit `capabilityId` to the
   existing `/capabilities` keys and doorway `topModels`, or also admit route
   and service capabilities from pool advertisements? Who owns the enum?
2. **Freshness bounds:** What default TTL and maximum clock-skew tolerance are
   acceptable for peer rows? Should TTL vary by capability kind or doorway?
3. **Transport:** Should pool scope use an existing authenticated pull verb,
   piggyback on heartbeat, or add a dedicated mesh RPC? Which choice best avoids
   fan-out and thundering herds?
4. **Persistence:** Is a machine-local JSON/SQLite projection sufficient, or
   must the registry reuse an existing pool store and replication semantics?
5. **Failure HTTP contract:** Should unavailable local state be `200` with
   explicit unknown entries (recommended for a read model) or `503` when its
   source is absent? What should mixed pool failures return?
6. **Authorization:** Which existing capability/operation gate authorizes
   `scope=pool`, and should machine owners be able to restrict individual
   capability rows beyond the current pool visibility policy?
7. **Conflict policy:** Should contradictory claims remain `conflict` until an
   operator resolves them, or may a newer local observation automatically win?
8. **Refresh cadence and budget:** What cadence, concurrency cap, and alert
   threshold fit the current mesh without creating a new background-spend or
   attention-flood risk?
9. **Doorway-to-capability granularity:** Is model identity enough, or must the
   row include prompt/tool support, quotas, and channel compatibility? What is
   the minimum useful contract for a later routing consumer?
10. **Operator UX:** Which existing dashboard surface should render the pool
    view, and what is the smallest mobile-friendly failure summary?

## Non-goals

No implementation, automatic routing, credential synchronization, peer
configuration mutation, new login/enrollment flow, or LLM-based capability
classification is included in ACT-409.

