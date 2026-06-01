# Side effects — standby skips its local tone gate on a relayed reply

## What changes at runtime

On a tokenless pool standby (a machine serving a moved session, relaying its
replies through the lease holder), the `/telegram/reply` route now SKIPS its
local tone gate. The holder's `/telegram/reply` still runs the holder's tone
gate. Detection is a new `TelegramAdapter.willRelay()` (exact `sendToTopic`
relay-vs-direct condition).

## Who is affected

- **Direct senders (the token-holding machine, single-machine agents):** ZERO
  change. `willRelay()` is false (real string token), so they gate locally
  exactly as before.
- **Tokenless standbys (a moved session replying):** skip the local tone gate;
  the reply is gated by the holder on receipt. This removes a redundant LLM call
  per cross-machine reply and the up-to-120s pre-relay stall it caused under a
  rate-limited circuit.

## Blast radius

- 2 files: `src/messaging/TelegramAdapter.ts` (new method) + `src/server/routes.ts`
  (one skip condition in `/telegram/reply`). No config, no schema, no migration
  (compiled source).
- The skip is additive to the existing `isProxy` / `isSystemTemplate` skips.

## Failure modes considered

- **Ungated reply?** No — the reply is gated by the holder (the single Telegram
  owner), which is the correct single place. The standby reply is the agent's
  finalized output; gating it twice was redundant, not a second layer of real
  protection.
- **Misdetection?** `willRelay()` mirrors the exact `sendToTopic` branch
  (`!hasUsableBotToken && outboundRelay`), so it's true iff the send would
  actually relay. A defensive `typeof ctx.telegram.willRelay === 'function'`
  guard in the route means an older adapter without the method just keeps gating
  (safe default).
- **Pairs with v1.3.182:** the relay call itself is already bounded + truthful;
  this bounds the path BEFORE the relay. Together they remove both stall points
  on the standby reply path.
