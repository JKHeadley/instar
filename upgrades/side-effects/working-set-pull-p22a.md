# Side-Effects Review — Working-Set Pull verb + pending-pull ledger (P2.2a)

**Version / slug:** `working-set-pull-p22a`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (spec converged over 4 rounds with 4 internal lenses + cross-model; this implements §3.2/§3.4/§3.5 as written; serve side gated dark)`

## Summary of the change

P2.2a of WORKING-SET-HANDOFF-SPEC: the chunked `working-set-pull` mesh verb
(both sides), the durable pending-pull ledger, and never-clobber landing.

1. `src/core/WorkingSetPull.ts` — `WorkingSetPullServer` (serve: fresh
   manifest as allowlist, O_NOFOLLOW + fd-identity TOCTOU defense, 1 MiB
   chunked responses, offset-0 whole-file sha256 + cheap fstat generation
   anchor, serveConcurrency busy gate) and `WorkingSetPuller` (receive:
   sequential offset cursors with chunksPerTick yields, anchor-mismatch
   restart-from-0 bounded by chunkRestartCap → `unstable`, assembly verified
   against the offset-0 hash, busy retry WITHOUT breaker penalty,
   assembled-bytes budget, hostile-relPath jail, never-clobber with
   hash-suffixed alongside copies capped at 2 via SafeFsExecutor).
2. `src/core/PendingPullLedger.ts` — the durable EXO-case record: serialized
   `mutate(fn)` funnel (single-writer, the topic-flood-#3 lesson),
   corrupt-parse quarantine (never silent-empty), TTL sweep with one honest
   expiry notice, supersede clears ALL lower-epoch records across nominees,
   (peer,topic,epoch) attempt-cap breaker.
3. Three lockstep verb edits: `MeshCommand` union member, RBAC read/observe
   case, dispatcher handler in server.ts (answers 'disabled' until the §3.7
   gate constructs the serve side).
4. Config: `CoherenceJournalUserConfig.workingSet` (types.ts) + the
   ConfigDefaults literal. NO separate enable flag — the serve side
   constructs IFF `replication.enabled === true` (the same explicit gate as
   the replication transport; never the `?? developmentAgent` dark gate).
5. `src/data/state-coherence-registry.json`: `pending-pulls` category
   (machine-local, single-writer).

NOT in this slice (P2.2b): the onAccepted trigger, the reflex route, the
staggered drain wiring, CLAUDE.md template, e2e, the peer-visibility guard,
live two-machine verification. Nothing schedules a pull yet — the verb
serves only when explicitly enabled, and no caller exists.

## Decision-point inventory

- **Serve allowlist verdict**: want paths matched against the FRESH manifest
  recomputed per request — outside → `refusedPolicy`; flagged → honest
  reason (`secretFlagged`/`tooLarge`/`liveSource`); vanished → benign
  (`goneSinceManifest`/dropped from fresh manifest), never an attack log.
- **TOCTOU identity**: O_NOFOLLOW open (final-component symlink refused at
  the syscall), fstat(fd) regular-file check, then lstat(path) vs fstat(fd)
  dev+ino equality — a raced object swap reads nothing.
- **Anchor mechanics**: offset-0 pays ONE full read+hash (the assembly
  authority); later chunks fstat-only. Mismatch → restart-from-0; an
  mtime-preserving rewrite that dodges fstat still fails assembly
  verification (bounded restarts, then `unstable`).
- **busy vs breaker**: busy = retry-without-penalty (bounded by
  busyRetryCap); ONLY genuine failures reach `recordAttempt`. The just-woke
  producer answering busy by design must not exhaust the records the drain
  exists to recover.
- **Budget basis**: assembled, verification-passed bytes — discarded restart
  chunks never count (a near-budget unstable file can't starve the set).
- **Never-clobber**: absent → jailed temp+rename write; identical sha →
  skippedExisting; divergent → alongside (sanitized basename + env-derived
  sender id + hash8 — idempotent for repeated identical divergence), cap 2
  with oldest-evicted THROUGH SafeFsExecutor (the single, narrow deletion
  exception; content survives on the producer).

## 1. Over-block

A symlink destination on the receive side is refused even if its target is
in-jail (deliberate — never write through a peer-influenced link). An
offset past EOF is refused (`refusedPolicy`) rather than answering empty. A
divergent local file is never updated in place — by design the local copy
wins and the incoming lands alongside.

## 2. Under-block

The full pre-parse transport ceiling on the puller side requires a bounded
fetch at the MeshRpcClient layer — this slice enforces the decode-side
backstop (oversize `dataB64` refused before decode); the bounded-fetch
wiring rides P2.2b where the client is constructed. The serve busy gate is
per-instance (in-process counter), not cross-process. The secret-content
scan inherits the §3.1 leak-reduction (not boundary) honesty.

## 3. Level-of-abstraction fit

The verb logic lives in core (transport-agnostic, seam-injected) exactly
like JournalSyncApplier; server.ts only constructs + registers. The ledger
is its own module because its single-writer funnel is a different
discipline from the manifest's pure computation. The three lockstep edits
mirror journal-sync precisely (union, RBAC class, handler).

## 4. Blast radius

Dark by default: the serve side constructs ONLY under
`replication.enabled === true` (today: the echo pair); everywhere else the
handler answers 'disabled'. No caller schedules pulls yet (P2.2b). The
ledger is instantiated only by tests in this slice. Registry entry is
metadata. A bug can affect only explicitly-replication-enabled pairs, and
the puller verifies every byte against served hashes before any write.

## Evidence

- `tests/unit/WorkingSetPull.test.ts` — 16 passing: round-trip (single +
  multi-chunk), generation-anchor restart lands the NEW content, never-sits-
  still → `unstable` (no livelock, nothing landed), busy retry-without-
  penalty + busyExhausted, never-clobber matrix (alongside naming regex,
  hash-idempotency, cap-2 eviction, symlink destination refused), hostile
  relPath matrix from a malicious manifest, ownership-recheck abort,
  assembled-bytes budget, serve refusal matrix + TOCTOU symlink swap.
- `tests/unit/PendingPullLedger.test.ts` — 13 passing: restart-proof
  persistence, idempotent file_, supersede-clears-all-nominees, TTL expiry
  once, breaker + new-epoch reset, CONCURRENT mutate() drops no record,
  corrupt → quarantine + one notice (never silent-empty), absent ≠ corrupt.
- `tests/integration/working-set-pull-roundtrip.test.ts` — 4 passing: 1.5MB
  near-cap chunked round-trip through the REAL express.json + signed
  MeshRpcClient path with an INDEPENDENT content oracle (source machine's
  on-disk original), want-outside-manifest refused through the full stack,
  divergent-alongside through the full stack, mixed-version no-handler → 501.
- Adjacent suites unchanged: journal-sync round-trip, mesh-rpc route +
  client round-trip, reader (78 total across the 8 suites). Typecheck +
  full lint chain clean (registry: 67 categories).
