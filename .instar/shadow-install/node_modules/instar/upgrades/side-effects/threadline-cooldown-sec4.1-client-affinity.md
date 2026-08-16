# Side-Effects Review — Threadline §4.1 commit 3: client-side session affinity

**Version / slug:** `threadline-cooldown-sec4.1-client-affinity`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (behavior change confined to E2E `send()` path; precedence respects explicit caller threadId)

## Summary of the change

Third and final commit of spec §4.1. Adds `lastThreadByPeer: Map<recipientFingerprint, { threadId, firstUsedAt, lastUsedAt }>` to `ThreadlineClient` with sliding TTL (10 min), absolute TTL (2 h), LRU cap (1000). On `send()` (the E2E-encrypted path), authority precedence is now:

1. Explicit caller `threadId` (unchanged)
2. Client affinity lookup (new)
3. Mint fresh (unchanged)

`sendPlaintext()` is intentionally NOT modified — plaintext path has always minted fresh, matches the receiver-side behavior where plaintext-tofu trust doesn't populate the receiver affinity map either.

Files touched:
- `src/threadline/client/ThreadlineClient.ts` — adds TTL/cap constants, `ClientAffinityEntry` type, `lastThreadByPeer` map, `nowFn` test seam, `peekClientAffinity`/`recordClientAffinity`/`getClientAffinitySnapshotForTests` helpers, affinity lookup + record in `send()`.
- `tests/unit/ThreadlineClient-affinity.test.ts` — new file. 8 unit tests exercising cold miss, warm hit, firstUsedAt preservation on refresh, threadId-change reset, sliding TTL expiry, absolute TTL expiry, LRU cap eviction, and recency-bump-survives-eviction.

## Decision-point inventory

1. **`send()` only, not `sendPlaintext()`.** Symmetric with receiver-side spec: "Only `trust.kind === 'verified'` paths populate and read the receiver affinity map. Plaintext path mints fresh." Applying the same rule client-side keeps the whole feature consistently gated on the verified transport.
2. **Test via direct helper invocation, not full `send()` mock.** `send()` requires connected encryptor + relayClient + knownAgents entry. Mocking those to test affinity precedence would be 100 lines of mock setup for a 40-line feature. Instead, cast to a `PrivateHelpers` type and invoke the private methods directly. Runtime-identical to `send()`'s own invocations; pattern precedent: `ThreadResumeMap` tests use `_set` helper similarly.
3. **`nowFn` constructor param.** Optional, defaults to `Date.now()`. Zero risk to production callers.
4. **LRU via same delete-then-set pattern as receiver side.** Parallel implementation; easier to audit as a pair.
5. **Authority precedence order from spec.** The spec lists "explicit caller threadId > client affinity > receiver affinity > resume map > mint". Client only controls the first three levels of the client's view; the server applies receiver-affinity + resume-map on its side. Enforced via the `??` chain in `send()`.

## Blast radius

- **E2E `send()` callers that do NOT pass an explicit threadId:** now auto-coalesce to a single thread per recipient within 10 min sliding / 2 h absolute. Intended benefit — the whole point of the change.
- **E2E `send()` callers that DO pass an explicit threadId:** zero change. Explicit arg always wins.
- **`sendPlaintext()` callers:** zero change.
- **`sendAuto()` callers:** when encrypting (known agent path) → affinity used. When falling through to plaintext → no affinity. Same behavior as directly calling `send`/`sendPlaintext`.

## Over-block risk

None. This is a reuse cache; it cannot block sends. Worst case is reusing a stale thread — bounded by 2h absolute TTL and overridable by passing an explicit `threadId` in `send()`.

## Under-block risk

The `sendPlaintext` path is intentionally NOT gated by affinity. Some callers who today use `sendPlaintext` because recipient keys aren't in `knownAgents` might hope for affinity. They won't get it — but the server side wouldn't honor it either (plaintext-tofu path), so it would be ineffective even if we added it.

## Level-of-abstraction fit

Affinity cache lives on `ThreadlineClient` next to `knownAgents` and the `send` methods. Symmetric with the receiver-side placement on `ThreadlineRouter`. Extracting to a standalone class for both sides is a future refactor if more features land on these maps.

## Signal-vs-authority compliance

Cache-only feature. The authority boundary — which transport variant triggers reuse — lives in the dispatch on `send()` vs `sendPlaintext()`. Cache does not invent authority; it only uses it.

## Interactions

- **With receiver affinity (commit 2):** when both client and server reuse, the threadId round-trips consistently. First-contact on verified path: client mints, server records (via `recordAffinity`). Second-contact: client reuses affinity, server sees incoming threadId and respects it (explicit-threadId precedence wins). Tested indirectly via the 8 router tests.
- **With `ThreadResumeMap`:** client affinity is upstream. Server-side, an affinity-reused threadId still consults `ThreadResumeMap` for the resume entry, so sessions still resume correctly.
- **With `sendAuto`:** the selector still picks between E2E and plaintext based on key availability; E2E path auto-benefits from affinity, plaintext does not — symmetric with server.

## Rollback cost

Revert the commit. Map + helpers go away; `send()` reverts to always-mint on missing threadId. No persisted state; no migration.

## Tests

- 8 new unit tests in `tests/unit/ThreadlineClient-affinity.test.ts`.
- 98 tests total across `ThreadlineRouter-relay`, `ThreadlineClient-affinity`, `message-store`, `delivery-retry-manager` all pass.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. This completes §4.1. Next work on this branch: §4.2 (coalesced drain loop with DRR + failure-suppressive reservation).
