# Side-Effects Review — Conversations reads build one verified view and reuse it; a slow machine no longer holds every owner request

**Version / slug:** `graph-read-view-cache`
**Date:** `2026-11-16`
**Author:** `Echo (topic 144007, Accept all round 2)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Justin's Accept all retry (20:33 PST 2026-11-16) felt "buggy and sluggish". Measured on the live Studio (1.3.1856): every Conversations owner read took 3 to 9 seconds and held the server's event loop for about 3.4 s while it ran (a `/health` sent alongside waited the same time). A CPU profile of one `GET /conversation-graph/suggestions`: 3.2 s in the handler, of which `readiness()` 2.7 s: `ConversationGraphRuntimeReadSource.readiness()` called `runtime.retainedProjection()` and `runtime.inventory()`, and `inventory()` called `retainedProjection()` again and `materializeGraphSourceInventory()`, which called `certifiedUnion()` again, and `reconcileGraphSourceCoverage()` once more: four full read-and-verify passes over every record per read. Header custody (`synchronize`, the title resolver, `get`) and change-status visibility (`ConversationGraphOwnerChanges.subjectOf`) each ran another uncached pass, per effort title. An Accept all of 21 projects makes about 150 such reads.

A real Accept all on a two-machine throwaway (Studio + M5) then showed the second fault: with the M5 frozen for 45 s, the Studio answered no Conversations request for about 7 minutes (every request 20 to 30 s, then 408), including requests that need nothing from the M5. `ConversationGraphDefault.ensureOwner` runs on every owner request inside its serialized section and called `distribute()`, which, even when every pin was already held, re-sent the complete pin set to each peer and awaited the reply. One slow or asleep machine therefore held every owner request for the peer timeout, one after another.

Fix (Tier 1, 12 source files, ~210 LOC):
- `ConversationGraphReplicationRuntime.readView()`: the retained projection and the inventory built from ONE `certifiedUnion`, reused until the key changes: `source.readViewMarker()` (every durable write including outbox bookkeeping, record count, local + pending erasure targets), the own + peer stream file stamp (`ReplicatedPeerStreamReader.foldSignature`, the same stamp its fold cache uses), dropped origins, readiness, lease epoch, last verification time, retained-snapshot sequence, membership hash, local-activity revision, and a 15 s cap (coverage staleness is judged against the clock). A key that cannot be computed is never served from cache. Built-while-changing views are not remembered. Erasure paths (`denyLocalErasure`, `localFleetPurge`) drop the cache explicitly. `retainedProjection()` and `inventory()` keep their behaviour (uncached) for writers and proofs; they accept an already-computed union.
- `materializeGraphSourceInventory` and `reconcileGraphSourceCoverage` accept the union already computed for the read.
- `ConversationGraphRuntimeReadSource`: readiness uses `readView()`; graph events, the create-effort index and each event's `verifyHistoricalRecord` are worked out once per view (was a linear `find` plus a re-verify per call).
- Header custody: an owner read passes the view's records to `synchronize(records)`; the title resolver and `ConversationGraphOwnerChanges.subjectOf` use `runtime.retainedForRead()` (the view, or a fresh build if the view cannot be built). Write-path checks (`custody.get` → header version, a correction snapshot's `synchronize()`) still build fresh.
- Writes in flight are never cached: `save()` counts in-flight writes and moves the revision again on `setImmediate` after it resolves, i.e. after the caller's in-memory record update (certificate, receipts, cancellation). `readViewMarker` also covers the historical-import authority.
- **The writes-held-forever fault (found by the real two-machine run).** After the M5 briefly held the lease (Studio frozen), it reserved its own copy of a source observation the Studio had already recorded (same idempotency key, its own sequence 32 vs the saved 5). Restore never admits such a reservation (the key is recorded), but `snapshotNativeTail` counted it, so every tail-close on the M5 refused with `graph-native-tail-conflict` and the Studio could never certify another owner change: every change stayed "Saved here. Waiting for … to confirm". Such a reservation is now retired durably (`ConversationGraphIntake.retireSuperseded`, re-checked inside the intake queue), before every native-tail snapshot and at the start of every tail collection, but only when the key resolves to a DIFFERENT saved record that is certified and verifies (a merely pending record could still be canceled, so then nothing changes). Retiring it keeps every reader consistent (own-tail checks, the inventory check, new reservations); filtering it in one place only would have moved the deadlock to the machine holding it (second-pass finding).
- Diagnostics: a refused peer replicate request now logs its action and code once per distinct pair (`refused a peer tail-close request: graph-native-tail-conflict`; the peer still only sees "refused"); a saved owner change that cannot be promoted logs why once per reason (`a saved change is still waiting: details-unavailable`). Round 1 could not explain the held tail-close for lack of exactly these lines.
- `ConversationGraphDefault.distribute`: when every pin is already held here, sharing the complete set again runs in the background, single-flight, at most every 30 s. Collecting missing pins (first establishment) is still awaited exactly as before.

Effort: Tier 1, 0 spec rounds, measured on the live Studio, proven on a real two-machine throwaway.

## Decision-point inventory

- Read-view reuse — add — deterministic key match; no judgment.
- Pin re-share timing — modify — awaited → background once all pins are held.

## 1. Over-block

None added. A read that cannot mark its state builds fresh, as before.

## 2. Under-block

Staleness is the risk of any cache. Every input the view reads is in the key: own durable writes (`viewRevision` bumps in `save()` and `removeBundle()`, before the write), records added or removed, erasure targets (local fence + pending), peer stream files (path, size, mtime, inode), dropped origins, readiness/lease/verification time, retained snapshot, membership and local activity; plus a 15 s cap for clock-judged coverage. A peer's commit reaches this machine only through its stream files, so it changes the key. Erasure also drops the cache directly. The view is used only by owner reads and the read-side header/subject lookups; commits, proofs and repair still compute fresh.

The background pin re-share cannot weaken custody: pins are public signed evidence, collection of missing pins is still awaited, and each peer still verifies what it receives. A peer that missed the complete set gets it on the next pass (30 s).

## 3. Level-of-abstraction fit

The cache lives in the runtime, which owns every input it depends on. Callers ask for "the read view", not for a cache.

## 4. Signal vs authority compliance

- [x] No new authority. Verification still runs on every record of each built view.

## 4b. Judgment-point check

No heuristic. Fixed 15 s and 30 s bounds.

## 5. Interactions

- `refreshReadiness` / readiness expiry (60 s): `isReady()`, `lastVerifiedAt` and the lease epoch are in the key, so a readiness change rebuilds the view.
- The lost-member case (`conversation-graph-local-read-capability`): `readView()` throws exactly as `retainedProjection()` does (key cannot be computed → no cache; build throws).
- Pin collection on first join, peer refusal and non-member pairing: graph-default integration tests (26) pass unchanged.

## 6. External surfaces

None. No route, wire or file format change.

## 6b. Operator-surface quality

No new words; the dashboard gets its answers in well under a second instead of 3 to 9 seconds, and keeps answering while another machine is slow.

## 7. Multi-machine posture

Machine-local cache by design: each machine caches its own verified view of the same replicated records. The pin change reduces cross-machine coupling: a slow peer no longer stalls the other machine's owner requests.

## 8. Rollback cost

Pure code change: revert and ship a patch. No migration, no stored state (the cache is memory only).

## Conclusion

Owner reads do one verified pass per change in the graph instead of four-plus per read, and an owner request never waits on a peer that already holds its pins.

## Second-pass review

**Reviewer:** independent reviewer subagent (fresh context; read the diff, the artifact and the replication code).
**Verdict on the first version: concern raised, no security hole** (erasure, viewer filtering and per-read verification hold). Findings and what was done:
1. Medium: `viewRevision` moved before the awaited write while callers update the in-memory record after it, so a read in between could cache the old record for up to 15 s (matters for the header-version write check). Fixed: in-flight writes disable caching and the revision moves again after the caller's continuation (`setImmediate`); the header-version check builds fresh.
2. Low: the historical-import authority was not in the key. Fixed (in `readViewMarker`).
3. Low: header reads/renames would newly depend on the inventory half of the view. Fixed: write paths build fresh; read paths fall back to a fresh build (`retainedForRead`).
4. Low: `close()` did not wait for the background pin re-share. Fixed (`await this.repinInFlight`).
**Second round (the tail change):** concern raised: excluding the reservation only in `snapshotNativeTail` left it in `collectNativeTailClosure`'s own-record and inventory checks and in `submitPrepared`'s reserve, so the holder would deadlock next time it held the lease; retire it durably, only behind a certified saved record. Done. Also: the refused-request log took the peer's `action` text unchecked (log injection by an unauthenticated caller); now pattern-checked `/^[a-z-]{1,32}$/` or `unknown`. The four earlier fixes re-checked and hold.
**Third round (durable retirement):** concur. Unlink (not move aside) is right; the capacity ledger has no refund path and the leftover charge protects against a fresh duplicate; lock order is mutation → intake queue, no deadlock. Low note taken: an erased certified saved record also supersedes (its body may no longer verify).
Checked and fine per the reviewer: erasure/forget (fence + pending targets in the marker, explicit cache drop), quarantine (set before save), peer commits (stream stamp), viewer filtering (per read), no caller mutates cached records, re-share concurrency (`receivePin` synchronous, verified against the stored publication), first establishment unchanged.

## Evidence pointers

`tests/integration/conversation-graph-read-view-cache.test.ts` (2 tests: one union per view; reuse until a commit, a stream change, an unreadable stream state, a lost member or 15 s; page reads share the view and verify each event once). `tests/integration/conversation-graph-native-tail-superseded.test.ts` (2 tests: a real signed duplicate reservation is retired durably and the tail closes; behind an uncertified saved record it is left alone and the conflict still refuses). Graph default integration tests pass. Real two-machine throwaway (Studio + M5 Pro, real writes): with both up, 6 project Accepts in 91 s; with the M5 frozen 45 s at project 2, all 6 accepted in 216 s, page ending "All 6 projects accepted."; before the tail fix the same freeze held every later change indefinitely. Live Studio measurements and the throwaway runs are in the PR.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a performance and coupling defect in the graph read path, closed by the tests above).
