# Side-Effects Review — Pool dashboard streaming phase 2a (serving endpoint)

**Version / slug:** `dashboard-stream-phase2a-serving`
**Date:** `2026-06-07`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Serving side of cross-machine streaming: StreamTicketStore (single-use ticket),
`pool-stream-ticket` mesh verb (mint), `/pool-stream` WS endpoint (ticket-gated
peer streaming reusing the existing WSManager client path), serving-side input
gate (allowRemoteInput default-off) + session-name validation.

## Decision-point inventory

(1) Ticket auth vs signed-headers-at-upgrade → ticket (bounded, single-use,
restart-replay-proof). (2) Remote input default → OFF (lateral-movement). (3)
Session-name handling → strict charset + must-be-running before tmux.

## 1. Over-block

Remote input is refused by default (input-not-allowed) — intended; watching is
unaffected. A session-name that isn't tmux-safe OR isn't running is refused
(invalid-session / session-not-found) — correct, never relay blind.

## 2. Under-block

The minted ticket is a bearer credential: anyone holding it (within 60s,
once) can open the stream. Mitigated: minted only to an authenticated peer
(mesh verb), single-use, short TTL, optional wrong-machine defense-in-depth. A
peer that can watch a session sees its output (disclosure accepted for
same-operator peers, per spec §2.3).

## 3. Level-of-abstraction fit

The peer reuses the existing WSManager client/handleMessage path (one streaming
implementation, not a fork); only the upgrade (ticket consume) and the
write-gate differ. Ticket minting rides the existing mesh dispatcher (no new
auth surface). Store persistence matches the PendingPullLedger idiom.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The new authority (ticket consume, input gate, name validation) is structural
and fail-closed: no ticket → 503/401; bad name → refused; peer input off →
refused. Identity comes from the mint record / mesh-auth, never an unverified
upgrade claim.

## 5. Interactions

- WebSocketManager local (/ws) path: unchanged except the new existence-before-
  input guard (a real improvement; the two existing input/key tests updated to
  register the session).
- MeshRpc RBAC: pool-stream-ticket joins the read/observe class (mint discloses
  nothing; ticket+gate are the controls).
- StreamTicketStore persistence: new durable category `stream-tickets`
  registered in state-coherence-registry.
- Config: `dashboard.poolStream.allowRemoteInput` (absent = false = safe, so no
  migrateConfig needed — absence is correct).
- Phases 2b (requesting side) + 3 (UI) consume this; not wired to the dashboard
  UI yet.

## 6. External surfaces

New WS path `/pool-stream` (ticket-gated) + new mesh verb `pool-stream-ticket`.
No new HTTP route, no Telegram, no notifications. One new durable state file
(stream-tickets.json, names+expiry only — no secrets).
