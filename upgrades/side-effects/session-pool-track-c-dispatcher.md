# Side-Effects Review — Session Pool Track C(2): MeshRpc dispatcher (L0)

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L0 (approved). **Track:** C part 2 (the receive side). Ships DARK (no HTTP route wired yet — that's the next step).
**Files:** src/core/MeshRpc.ts (added MeshRpcDispatcher)

## What changed
- **`MeshRpcDispatcher`** (added to MeshRpc.ts): the transport-agnostic receive side. `dispatch(env)` runs the two gates (verify THEN rbac via `acceptEnvelope`), records the nonce ONLY on full accept (a rejected command never burns a nonce — anti-DoS), audits rejections via an injected `onReject` (SecurityLog), then routes to a registered per-command handler. Returns `{ok, result}` or `{ok:false, reason, status}` with an HTTP status mapping (auth → 401/403, freshness → 409, unimplemented handler → 501). Handlers, verify/rbac deps, nonce-record, and the audit sink are all injected.
- **Layering (not a stub):** the dispatcher carries the command set; the MUTATION handlers (place/claim/release/transfer) are registered by their owning layers (L3/L4/L5 — Tracks D/E/F). A verified+authorized command with no handler yet returns `no-handler` (501) — the honest "this layer isn't wired yet" state, not a silent stub. Read-class handlers (capacity-report/session-status) can be backed by the L2 registry now.

## Blast radius
- **None at runtime yet** — nothing constructs a `MeshRpcDispatcher`. Additive to the (already-dark) MeshRpc.ts. The HTTP route (`POST /mesh/rpc`) + production wiring (Ed25519 verify, NonceStore, router-lease read, handler registry) land in the next step.

## Risk + mitigation
- **Risk:** a rejected command consuming a nonce (replay-DoS) or an accepted one not recording (replay hole). **Mitigation:** nonce recorded EXACTLY on accept (after both gates), before handler dispatch — tested both ways (accepted place burns the nonce; rejected place does NOT; no-handler still burns it because it WAS authorized).
- **Risk:** wrong status codes leaking auth info. **Mitigation:** explicit reason→status map, tested (401 wrong-recipient, 403 not-router, 409 replayed-nonce, 501 no-handler).

## Rollback
- Additive + dark + unwired. Remove `MeshRpcDispatcher` to revert.

## Tests
- tests/unit/MeshRpc.test.ts now 21 (15 prior + 6 dispatcher): accept→record→dispatch; reject-unauthorized audits + no-nonce-burn (403); wrong-recipient (401); no-handler burns nonce (501); read-class routes; replayed-nonce (409). tsc clean.

## Agent awareness
- Internal m2m infra; agent awareness covered by Track B's CLAUDE.md blurb. <!-- tracked: session-pool-track-c -->
