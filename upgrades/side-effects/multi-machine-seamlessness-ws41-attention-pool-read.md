# Side-Effects Review — WS4.1 attention pool-scope (read-side)

**Version / slug:** `multi-machine-seamlessness-ws41-attention-pool-read`
**Date:** `2026-06-12`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required (read-only observability merge — no block/allow, no mutation, no session/ownership surface)`

## Summary of the change

The read-side of WS4.1 (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.1): `GET /attention?scope=pool`
merges every online peer's attention items into one view so the dashboard shows one
queue across the whole pool. Local items are tagged with this machine's id/nickname
at read time; remote items with the peer's. Tolerant (per-peer 5s timeout → a
`pool.failed` marker, never a 500), short-TTL cached (3s, so dashboard polling
doesn't re-fan-out per request), and P17-coalesced at the merge point (same-key
NORMAL items across machines collapse to ONE row; HIGH/URGENT never coalesced).
Plain `GET /attention` stays back-compatible (`{items,count}`), now self-tagged with
machine identity when the pool is wired. Files: `src/server/routes.ts` (the merge
helper + the scope branch), `src/messaging/TelegramAdapter.ts` (optional
`machineId`/`machineNickname` on `AttentionItem`), `src/scaffold/templates.ts` +
`src/core/PostUpdateMigrator.ts` (Agent Awareness + Migration Parity).

**Scope boundary:** this is the READ half only. The durable, operator-bound,
machine-independent `/ack` (a replicated ack record + mutating mesh verb with its own
RBAC class + owner revalidation) is the security-sensitive write half and ships as a
SEPARATE slice under the same approved spec. <!-- tracked: CMT-1416 -->

## Decision-point inventory

- `GET /attention?scope=pool` merge — **add** — a read-only aggregation. No
  block/allow; never mutates an item; returns a tolerant merged view.
- The P17 coalesce key — **add** — a read-side display grouping (collapses duplicate
  rows); the write-side per-machine budgets remain the authoritative bound.
- `AttentionItem.machineId/machineNickname` — **add (optional, read-stamped)** — no
  persistence change; stamped at read time, absent on single-machine installs.

---

## 1. Over-block
No block/allow surface — a read-only merge. Not applicable.

## 2. Under-block
N/A (read-only). The coalesce could in principle hide a distinct-but-same-key item,
but HIGH/URGENT are exempt and the per-item store is unchanged (every item is still
individually addressable via `GET /attention/:id`); the merge only affects the
pool LIST view.

## 3. Level-of-abstraction fit
Right layer: mirrors the proven `GET /sessions?scope=pool` precedent exactly (route-
level fan-out + per-peer-timeout + `failed` markers + machine tagging). The store
(`TelegramAdapter`) stays machine-agnostic; the machine view is composed in the route.

## 4. Signal vs authority compliance
Compliant — pure read, zero authority. It gates nothing.

## 5. Interactions
- The plain `GET /attention` path is unchanged except for optional machine tags
  (additive). The PATCH/DELETE/`:id` routes are untouched.
- The short-TTL cache is keyed by status; a status-filtered pool read and an
  unfiltered one have separate cache entries (no cross-contamination).
- Coalesce reads `sourceContext`/`category`/`title` — fields the flood guard already
  populates; no new write contract.

## 6. External surfaces
- New query mode on an existing route. Old callers (no `?scope=pool`) get the
  back-compatible array-shaped... (object `{items,count}`) response unchanged.
- A peer's `GET /attention` is called with the agent bearer (same pattern as
  sessions pool scope). A peer on an OLD version simply returns its local
  `{items,count}` — merges fine (machine tags filled from the registry).
- Timing: bounded by the 5s per-peer timeout; a slow/dark peer contributes a
  `failed` marker, never delays past the timeout.

## 7. Multi-machine posture (Cross-Machine Coherence)
**proxied-on-read** — the merged read fans out to peers per request (cached 3s),
each item tagged with its owning machine. No replication, no durable cross-machine
state in this slice (that is the deferred `/ack` write half). The pool registry's
online flag is consulted to skip a known-dark peer cheaply. Phase-C clean: the
fan-out is per-online-peer and the coalesce is O(items) — no 2-peer assumption.

## 8. Rollback cost
Trivial: the scope branch is additive; reverting the PR restores today's local-only
`GET /attention`. No durable state written, no migration beyond the additive CLAUDE.md
bullet (idempotent, content-sniffed).
