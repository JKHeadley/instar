# Side-Effects Review — Threadline §4.1 commit 2: receiver-side session affinity

**Version / slug:** `threadline-cooldown-sec4.1-receiver-affinity`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (behavioral change is narrowly gated on `trust.kind === 'verified'`; current runtime populates `plaintext-tofu` so default path is unchanged)

## Summary of the change

Second of three commits implementing spec §4.1. Adds `recentThreadByPeer: Map<fingerprint, { threadId, firstUsedAt, lastUsedAt }>` to `ThreadlineRouter` with sliding TTL (10 min), absolute TTL (2 h), and LRU eviction at 1000 entries. On inbound threadless messages from verified peers, the router now consults the map before minting a new threadId — reusing an existing one if both TTLs are satisfied. On every inbound message (whether reused, minted, or explicit), the router records affinity.

**Gating is strict.** `peekAffinity` and `recordAffinity` both short-circuit when `relayContext.trust.kind !== 'verified'`, so plaintext-tofu paths (the current runtime default) mint fresh every time — same as pre-commit behavior. The map stays structurally empty on the plaintext path; verified by a test.

Files touched:
- `src/threadline/ThreadlineRouter.ts` — adds TTL/cap constants, `ReceiverAffinityEntry` type, `recentThreadByPeer` map, `nowFn` test seam, `peekAffinity`/`recordAffinity`/`getAffinitySnapshotForTests` helpers, affinity lookup in `handleInboundMessage`.
- `tests/unit/ThreadlineRouter-relay.test.ts` — updates `createEnvelope` to distinguish "default" vs "explicitly absent" threadId; adds 8 new tests covering verified reuse, plaintext no-op, explicit threadId wins, LRU eviction at cap, sliding TTL refresh, sliding TTL expiry, absolute TTL expiry.

## Decision-point inventory

1. **Evict-on-read vs periodic sweep.** Spec §4.1 mentions "periodic sweep every 5 min". Evict-on-read is functionally equivalent for correctness, requires no timer plumbing, and has no dispose() lifecycle. Chose evict-on-read; sweep can be added in a later commit if adversarial churn causes stale-entry pressure.
2. **LRU via insertion-order delete-then-set.** JavaScript Map preserves insertion order for iteration; `delete` + `set` moves key to tail. Matches the spec's LRU semantics without a separate bookkeeping structure.
3. **`nowFn` constructor seam.** Needed for deterministic TTL tests. Default is `Date.now()`; production callers pass nothing. No behavioral risk.
4. **Affinity record on every path (reuse, mint, explicit).** Spec says "Authority precedence: explicit > client > receiver > resume > mint". Recording on explicit-threadId paths keeps the map fresh so future threadless follow-ups reuse the most-recent thread, which matches user intent. No hijack risk: recording is still gated on verified trust.
5. **Clock-injected tests use `createMockMessageStore()` inline.** The default shared `router` doesn't get the clock, so each TTL test spins up a throwaway `clockRouter`. Keeps default-router tests fast and the TTL tests hermetic.

## Blast radius

- **Verified path (not currently wired anywhere):** new affinity reuse behavior — threadless follow-ups from the same verified peer collapse onto one session instead of spawning fresh per message.
- **Plaintext-tofu path (current runtime default):** zero behavior change. Map is never read, never written. Verified by test `mints fresh for plaintext-tofu peer even on follow-up` that asserts `snapshot.size === 0` after a plaintext send.
- **No relay context path:** zero behavior change. `peekAffinity(undefined)` and `recordAffinity(undefined, …)` are no-ops.

## Over-block risk

None. The receiver affinity map is a reuse optimizer, not a block gate. Worst-case wrong decision is reusing a stale thread — bounded by absolute TTL (2 h) and mitigated by the explicit-threadId override.

## Under-block risk

The map is strictly gated on `trust.kind === 'verified'`. Under-block would mean reusing a thread for a peer that only had `plaintext-tofu` trust — the code cannot do this, because `peekAffinity` returns null on non-verified kinds. Enforced by union narrowing and by a dedicated test.

## Level-of-abstraction fit

Map and helpers live on `ThreadlineRouter` where they belong — the router is already the decision point for threadId resolution. Extracting to a standalone `ReceiverAffinityCache` class would be over-engineered for a 60-line feature.

## Signal-vs-authority compliance

The affinity map is a cache (signal). The authority boundary — whether this peer is impersonation-safe — is set upstream when the construction site writes `trust.kind = 'verified'`. The cache only *uses* that authority; it doesn't invent it. Compliant.

## Interactions

- **Spawn path:** `handleInboundMessage` sets `message.threadId` before calling `spawnManager.evaluate` or `threadResumeMap.get`. Both downstream consumers see the reused threadId, so resume-by-threadId continues to work.
- **Live-session injection (PR-4):** if the affinity-reused thread has a live session, `tryInjectIntoLiveSession` picks it up — this is the *intended* benefit: follow-ups collapse onto the running session.
- **`ThreadResumeMap`:** the affinity cache sits upstream of the resume map. If both have entries, affinity-reused threadId is the one that queries the resume map, so the resume map still wins if its entry is valid.
- **Concurrent same-peer inflight:** `pendingSpawns` set serializes spawns per-threadId. If two verified threadless messages arrive concurrently, the second sees the reused threadId in `pendingSpawns` and returns `'Spawn already in progress'` — safe, same semantics as pre-commit.

## Rollback cost

Revert the commit. The map and helpers go away; `handleInboundMessage` falls back to always-mint on threadless messages. No persisted state to migrate; the cache is process-local.

## Tests

- 8 new unit tests in `describe('receiver-side session affinity', ...)`.
- All 23 tests in `ThreadlineRouter-relay.test.ts` pass.
- `npx tsc --noEmit`: clean.

## Rollout

Ship on `feat/threadline-cooldown-queue-drain`. Next commit in the same PR: client-side `lastThreadByPeer` in `ThreadlineClient`.
