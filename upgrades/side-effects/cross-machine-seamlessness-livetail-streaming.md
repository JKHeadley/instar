# Side-Effects Review — Cross-Machine Seamlessness: live-tail streaming wired live

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3b (converged, approved)

Makes the encrypted live-tail stream END-TO-END LIVE: the holder now actually pushes
the conversation tail to the standby on a cadence (the receiver has been live since the
live-tail-wire commit). First true integration into the running server.

## What changed
- `src/messaging/TelegramAdapter.ts` — NEW `getKnownTopicIds(): number[]` accessor
  (keys of topicToSession) — the set of live conversations to stream.
- `src/commands/server.ts`:
  - In the lease block, constructs the holder-side `HttpLiveTailTransport` (sender) —
    peers resolved from the registry, each peer's X25519 key via
    `idMgr.getEncryptionPublicKeyPem` → SPKI-DER base64; content encrypted via encryptForSync.
  - Before AgentServer construction, constructs `LiveTailSource` (content provider =
    `telegram.getTopicHistory(topic, 500)` formatted append-only; active topics =
    `telegram.getKnownTopicIds()`) and a cadence `setInterval(liveTailPushRateMs)` that
    calls `pushTick()` — GATED on `coordinator.holdsLease()` so ONLY the awake machine
    streams (mirrors scheduler/sentinel gating). Timer unref'd. Only when
    `liveTailTransport: 'tunnel'` + coordinator enabled + telegram present.

## Over-block / under-block
- Holder-gated: a standby that does not hold the lease never streams (no double-push).
- Solo agent / no peers: the sender's broadcast is a reachable no-op — zero behavior change
  for single-machine installs (the dominant case). `liveTailTransport: 'git'` skips it entirely.
- Window-shift caveat: getTopicHistory is a bounded recent window (500), so a conversation
  exceeding it triggers a one-off full resend (LiveTailSource divergence path) — the standby
  buffer dedups by seq + caps by bytes, so this is correct, just occasionally redundant.
  Documented; a growing/append-only provider is a tracked tuning follow-on. <!-- tracked: ACT-156 -->

## Signal vs authority
- The cadence timer reads authority (coordinator.holdsLease()) to decide whether to stream;
  it does not mutate authority. The sender carries redacted+encrypted content only.

## Interactions
- Sender (HttpLiveTailTransport) + LiveTailSource + the already-live receiver
  (/api/live-tail → decrypt → LiveTailBuffer) now form the complete one-directional stream.
- The handoff flush() (next commit) will reuse this same LiveTailSource for its manifest.

## Rollback cost
- Low. The accessor is additive; the streaming block is guarded and unref'd. Reverting removes
  the block + accessor with no effect on single-machine installs.

## Tests
- Components already unit-tested: HttpLiveTailTransport (6), LiveTailSource (6, incl. the
  reconstruct-through-LiveTailBuffer correctness proof), live-tail-receive-roundtrip (3).
  101 seamlessness unit tests green; tsc clean. The true holder→standby streaming is
  exercised by the two-machine hardware test-as-self (task 8) — a single-machine e2e cannot
  drive a no-peer no-op sender.
