# Side-Effects Review — Cross-Machine Seamlessness: live-tail wire (receiver) + transport

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3b/G3c (converged, approved)

Second piece of the wire-transport increment (after the lease wire transport). Stands
up the encrypted holder→standby live-tail channel: the SENDER transport class and the
RECEIVER end-to-end (route → decrypt → sequence-deduped buffer, fully live).

## What changed
- `src/core/HttpLiveTailTransport.ts` — NEW. Holder-side sender: redacts content
  (liveTailRedaction) BEFORE anything leaves the machine, encrypts per-peer with the v3
  machine scheme (encryptForSync: ephemeral X25519 + AES-256-GCM, forward-secret per
  flush), and POSTs to each standby's `/api/live-tail` over the authenticated machine
  channel (signRequest). No peers → reachable no-op (solo agent unaffected). Injected
  fetch/encryptor/clock for testability.
- `src/server/machineRoutes.ts` — NEW route `POST /api/live-tail` (authMiddleware) +
  `onLiveTailReceived` ctx callback. Validates the flush shape, rejects an unverifiable
  peer at the auth boundary BEFORE any content is accepted (§8 G3c), hands the encrypted
  flush to the server-lifecycle decryptor, returns 400 on decrypt/verify failure (logged
  to SecurityLog as `live_tail_rejected`).
- `src/server/AgentServer.ts` — NEW `liveTailReceiver` option, passed through to the
  machine-routes context as `onLiveTailReceived`.
- `src/commands/server.ts` — constructs the standby-side `LiveTailBuffer` + the decrypt
  receiver closure (decrypts with THIS machine's X25519 private key, then sequence-deduped
  applyFlush), wired only when `liveTailTransport: 'tunnel'`. The holder-side sender
  (HttpLiveTailTransport.broadcast) is constructed/driven by the flush producer in the
  NEXT increment piece (inbound-dispatch + handoff) — the class ships unit-tested here.

## Over-block / under-block
- The receiver REJECTS (400) any flush it cannot decrypt/verify — intended over-block; a
  forged or wrong-key flush must never enter the context window. Replay/duplicate seqs are
  dropped by LiveTailBuffer (no double-append corrupting history).
- Redaction is conservative/high-precision (false positives acceptable per §8 G3c); ordinary
  prose is left intact (tested).
- Solo / no-peer: the sender is a no-op and the receiver simply never fires — identical to a
  disabled mesh. `liveTailTransport: 'git'` skips the tunnel receiver entirely.

## Signal vs authority
- The transport carries no authority — it does not decide who is leader or who may send;
  it only moves (redacted, encrypted) context. The FencedOutbox/lease (separate) hold send
  authority. The receiver's only judgment is cryptographic (auth tag + machine-auth), not policy.

## Interactions
- Reuses the established v3 machine path: `signRequest`/`machineAuthMiddleware` (mutual auth),
  `encryptForSync`/`decryptFromSync` (the same scheme as secret sync), and `MachineIdentity`'s
  dedicated X25519 encryption keys — no new crypto invented.
- Feeds `LiveTailBuffer` (already shipped), whose sequence-dedup is the context-integrity guard.
- **Tracked follow-on (not this commit):** carry-by-reference for large tool output (§8 G3b) —
  depends on the durable encrypted work-ledger reference mechanism not yet built; redaction
  (the actual security requirement) is fully in place. <!-- tracked: ACT-156 -->
- **Next piece (same increment):** the holder flush producer drives `broadcast()` from the live
  message path; the handoff-ack transport + HandoffSentinel live-wiring consume the buffer.

## Rollback cost
- Minimal. The route is additive (unknown route → 404 previously); the option is optional;
  the sender class is unreferenced by the live path until the next piece. Reverting removes
  the new file + the four additive edits.

## Tests
- `tests/unit/HttpLiveTailTransport.test.ts` (6): no-peer no-op, signed POST to /api/live-tail,
  **redaction-before-encryption** (no secret leaves in the clear — security-negative), per-peer
  encryption, unreachable-on-all-error, non-ok-not-reachable.
- `tests/unit/live-tail-receive-roundtrip.test.ts` (3): encrypt→decrypt→apply round-trip,
  replayed-seq dropped (no double-append), **non-recipient cannot decrypt** (security-negative).
- Full seamlessness suite green (76 unit tests across 9 files); tsc clean.
