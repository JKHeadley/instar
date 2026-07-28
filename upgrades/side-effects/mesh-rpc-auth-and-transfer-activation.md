# Side-effects review — /mesh/rpc bearer-auth exemption + transfer-by-nickname activation

## What was happening (real-hardware, 2026-05-29)

After the HTTP presence transport (B, v1.3.102) deployed to the laptop, the Mac
mini STILL showed offline in `GET /pool`. Root cause, found by probing the mini's
`/mesh/rpc` over its tunnel: **401 "Missing or invalid Authorization header"**.

`/mesh/rpc` — the §L0 machine-to-machine command transport — was sitting behind
the general API bearer-token middleware, but `MeshRpcClient.send` sends only the
signed envelope (no `Authorization` header), and it *can't* send a useful one:
each machine install holds its own `authToken`, so the sender has no token the
receiver would accept. So EVERY cross-machine call — the new presence pull AND
`deliverMessage` / `place` / `claim` / `transfer` — was rejected 401 before the
dispatcher's envelope check ever ran. The pool passed all in-process dispatcher
tests yet was completely dead over a real tunnel.

Separately, the headline "move this to <nickname>" trigger was unbuilt: the
recognizer + planner existed as pure tested units but had no caller, nothing
persisted the pin, and `SessionRouter.route()` was called with no `topicMetadata`
— so placement always fell back to least-loaded and a relocation command did
nothing.

## The fix

1. **`src/server/middleware.ts`** — exempt `/mesh/rpc` from the bearer gate, next
   to the other signature/HMAC-authed m2m endpoints (`/a2a/inbox`, relay). The
   route is authed SOLELY by its Ed25519 signed, recipient-bound envelope
   (verify → RBAC → nonce, in the dispatcher). This single change is what makes
   the cross-machine pool function over the wire at all.

2. **`src/core/TopicPlacementPinStore.ts`** (new) — durable `{topicId → {preferredMachine,
   pinned, updatedAt}}`. `asTopicMetadata()` shapes the pin for
   `PlacementExecutor.decide`; `lastUpdatedAtMs()` feeds the rate-limit guard.

3. **`src/commands/server.ts`** — wire the §L4 transfer-by-nickname activation
   (gated on stage ≠ 'dark', BEFORE the route() interception): recognize the
   command → plan → on transfer/noop set the pin AND release local ownership so
   the topic's next message re-places onto the pinned machine via the
   already-wired placeAndClaim → spawnOnMachine → owner-side `onAccepted` resume
   path; confirm-required/reject reply to the user; the command message is
   consumed. And pass `topicMetadata: pinStore.asTopicMetadata(sessionKey)` into
   `route()` so placement honors the pin.

## Blast radius

- **The auth exemption is the only change to a live, always-on code path.** It
  REMOVES a gate from `/mesh/rpc`; the dispatcher's envelope verification (which
  already ran on every accepted call) becomes the sole auth — strictly stronger
  than a shared bearer for cross-machine (per-peer Ed25519 keys, recipient
  binding, nonce replay protection). A non-mesh / single-machine agent never
  receives a `/mesh/rpc` POST, so the exemption is inert for it.
- **The activation is dark-gated.** The recognizer/pin/route-metadata wiring only
  runs when `_sessionPoolStage() !== 'dark'` (default dark), so it ships inert and
  is exercised only in the controlled rollout/proof. The pin store is a new file
  under `stateDir/session-pool/`; nothing reads it unless the activation runs.
- **No new config / route / schema / hook / skill → no migration.** Server +
  middleware + one new core module; existing agents pick it up on the next
  release. Both machines need it (the receiver's `/mesh/rpc` must accept the
  envelope; the router needs the recognizer + pin).

## Tests

- `tests/unit/mesh-rpc-auth-exemption.test.ts` — `/mesh/rpc` reaches its handler
  with NO Authorization header (and even with a wrong bearer — the envelope is
  the auth); a normal protected path still 401s without a token.
- `tests/unit/topic-placement-pin-store.test.ts` — set/get/asTopicMetadata/
  lastUpdatedAtMs/clear, durable across instances, corrupt-file tolerance.
- `tests/unit/transfer-activation-wiring.test.ts` — server boot constructs the
  pin store + recognizer/planner imports, recognizes on inbound before route(),
  applies a transfer (sets pin + releases ownership), returns when handled, passes
  the pin as `topicMetadata`, and is dark-gated.
