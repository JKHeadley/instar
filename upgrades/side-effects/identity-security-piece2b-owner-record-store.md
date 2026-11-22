# Side-Effects Review — The owner record on every machine: stored, bootstrapped at Basic, and kept in step

**Version / slug:** `identity-security-piece2b-owner-record-store`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Piece 2b of the approved identity and security design (topic 144636) puts piece 2a's owner record on every machine:

- `src/core/ownerRecordStore.ts` stores 2a's `keep` set in `.instar/state/owner-record/`. The enrolled, seen and pin markers live in `.instar/machine/`. It bootstraps a Basic genesis with the machine key, replaces a broken never-enrolled record, and answers `gate()`: basic, record or hold, with the enrolment never, enrolled or unknown.
- `src/core/ownerRecordSync.ts` adds signed `owner-record-push` and `owner-record-pull` mesh commands. They are bounded, deduplicated and rate-limited, with a checked revocation lane, single-flight evaluation, a pending set for out-of-order entries, and per-peer backoff. Bootstrap runs only on the lease holder after every peer has answered, with a 24-hour breaker.
- `src/core/ownerRecordWiring.ts` holds the boot wiring; `server.ts` calls it in three places.
- `src/server/ownerRecordRoutes.ts` adds `GET /owner-record`, read-only, agent token.
- `src/core/keyMaterialPaths.ts` lists `state/owner-record/`, so it is never served, backed up, committed or synced.
- `src/core/MeshRpc.ts` adds the two commands to the registered-peer class.
- `src/core/ownerRecord.ts` (2a) now returns the one verifying signature for each kept entry.
- An awareness entry and a config switch (`security.ownerRecord.enabled`, default on).

Nothing reads the gate yet. Piece 3 and later pieces do.

## Decision-point inventory

- `OwnerRecordStore.gate()`: a deterministic table over the record's status and the markers.
- `OwnerRecordSync.maybeBootstrap()`: lease holder, no split-brain, every peer answered, nothing blocking.
- `OwnerRecordSync.handlePush()`: size, deduplication, per-peer rate, and the revocation-lane check.
- Unpinned genesis selection: a registered key, enrolled beats Basic, then the lowest machine id.

## 1. Over-block

The gate can hold Sensitive and Serious actions when a record is lost or unverifiable. Nothing consumes the gate yet, so nothing is blocked today. Once piece 3 reads it:
- a hold still allows viewing and piece 1's local access link;
- a never-enrolled agent with a peer asleep stays Basic, today's behaviour.

## 2. Under-block

Bootstrap at Basic writes a record that grants nothing beyond today's behaviour. A peer's push grants nothing on its own, because every entry is judged locally by 2a's evaluator.

## 3. Level-of-abstraction fit

- **Storage and sync** are a core module, beside `MachineIdentity` and the other mesh-replicated stores.
- **The gate** is one function every later piece reads, rather than re-deriving the table.
- **The boot wiring** lives in its own module because the startup function is at the compiler's limit.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — the gate is a deterministic table over enumerable states (record status, marker presence, peer answers), with no judgment over meaning. Nothing consumes it in this change.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

The bounds are cost floors, with their sources in the spec's §3a:
- 500 entries or 2 MB per push or page;
- 4 pages per peer per cycle;
- one push per peer every 10 seconds;
- evaluation at most every 5 seconds, or every minute for inputs over 500 entries;
- a pending set of 500 entries, 2 MB and 1 hour;
- a revocation lane capped at 50.

Every bound hit is counted in `GET /owner-record`. A real revocation, by a key valid now against a key valid now, always gets the lane.

## 5. Interactions

- **The mesh:** two new verbs. An older peer answers with no handler, which counts as "not answered", so bootstrap waits. Pulls run every 15 minutes per peer, at most 4 pages each, with backoff for a silent peer.
- **Key-material paths:** the record joins the never-served, never-backed-up, gitignored, never-synced list. Its four consumers pick it up from the one list; the never-served test passes.
- **Lease and split-brain:** read only, through `coordinator.getSyncStatus()`.

## 6. Rollback

Set `security.ownerRecord.enabled: false`, or revert the commit. The files under `.instar/state/owner-record/` and the markers in `.instar/machine/` can stay: nothing else reads them. The 2a addition (`signatures`) is additive.

## 7. Evidence

- **Unit:** `tests/unit/identity-piece2b-owner-record-store.test.ts` (15) and `tests/unit/identity-piece2b-owner-record-sync.test.ts` (9). They cover:
  - bootstrap;
  - sticky enrolment;
  - the three gate outcomes;
  - genesis choice (unregistered, tie rule, enrolled beats Basic);
  - storing only the verifying signature;
  - paging;
  - replacement of a broken record;
  - a bootstrap blocked by a silent peer, the backoff and the 24-hour breaker;
  - a blocking peer marker;
  - enrolment reaching every machine and pinning;
  - an oversized push and rate limits;
  - junk versus real revocations on the lane;
  - a lease move with no second record.
- **Integration:** `tests/integration/identity-piece2b-owner-record-route.test.ts`, run by Local Verify (no hand-run integration tests on the verify machines). It covers:
  - 503 when off;
  - 401 without the token;
  - Basic, then the record, then a hold after loss;
  - no private key in the reply.
- **E2E lifecycle:** `tests/e2e/identity-piece2b-owner-record-lifecycle.test.ts`. It covers:
  - the `server.ts` wiring;
  - the route alive at 200 over a real machine identity;
  - the mesh handlers answering;
  - 503 when off.
- **2a unit tests** still pass with the new `signatures` field.

- **Live (test-agent-live):** a throwaway agent ran this build. The update migration added `state/owner-record/` to both `.gitignore` files; `GET /owner-record` answered 200 (Basic, sync wired) with the token and 401 without. Proof: `.instar/state/identity-build-144636/p2b-throwaway-proof.md` in the agent home.

## Second-pass review

An independent reviewer subagent read the code against the spec and probed it with attack scripts over six rounds (p1–p10). Every defect it found is fixed with a regression test:
- **Round 1 (6):** junk wiping the record; ancestors not stored; `replaces` excluding a genesis never judged; the revocation lane open to machine keys; the breaker never re-armed by other mesh traffic and machine-list changes; peer heads not reported.
- **Round 2 (2):** a filled record refusing the owner's revocation; junk crowding the lane.
- **Round 3 (2):** unbounded revocations past the cap; deep key chains dropped.
- **Rounds 4–6 (1 each):** a junk introducer standing in for a real key; quadratic checking; junk crowding the candidate cap.

Review: `.instar/state/identity-build-144636/reviews/p2b-second-pass.md` in the agent home.

E2E-PAIRING: EXEMPT — the owner-record verbs are mesh RPC between an agent's own machines, not device pairing; the lifecycle test exercises the production wiring.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action`
- **closure:** `bounded`
- **reason:** the only self-triggered actions are the 15-minute pull cycle (bounded pages, per-peer backoff), pushes after a local change (bounded size), and bootstrap (once, lease holder only, with a 24-hour breaker and one degradation report).
