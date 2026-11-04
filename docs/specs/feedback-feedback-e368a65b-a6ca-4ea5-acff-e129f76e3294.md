---
title: "Fix: replicated-store producers are instance-bound — one locked write funnel per file, then tombstones for every delete"
slug: "feedback-feedback-e368a65b-a6ca-4ea5-acff-e129f76e3294"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
status: "draft"
parent-spec: "docs/specs/statesync-writer-agnostic-reconciler.md (§4 step 4 deletion intents, §5.3 puts-only stores); docs/specs/ws23-relationships-userregistry-security.md (PII clamps, unchanged)"
related-feedback: "feedback-e368a65b-a6ca-4ea5-acff-e129f76e3294; cluster-replicated-store-producers-are-instance-bound-several-userma. The reconciler spec tracks the same defect as fb-9ac43374-07b; the title and origin match, but confirm the two ids are the same item before closing either."
---

## 1. Problem

Several `UserManager` objects, in one process and across processes, write `users.json`. Each holds a
private in-memory map loaded once in its constructor, and each write saves that whole map over the
file. So the last writer wins, and every record it did not know about is lost or restored.

Three consequences follow:

- **Lost records.** A user added through one manager disappears when another manager saves.
- **Resurrected records.** A removed user comes back when a stale manager saves. If that manager has
  an emitter, it also sends a fresh `put` for the removed user, which is newer than the tombstone.
- **Invisible writes.** A CLI process writes the file, but the server's long-lived managers never
  re-read it. Replication hooks only exist on managers the server wired up.

The reconciler (`statesync-writer-agnostic-reconciler`) replicates whatever is on disk. It is a
backstop and does not repair the producer. Because a lost update looks exactly like a deletion, §5.3
of that spec deliberately keeps `userRegistry`, `learnings` and `evolutionActions` puts-only until
this is fixed. The producer has to be fixed before those deletions can propagate.

## 2. Evidence

### 2.1 Reproduced

Run against this tree (`5c9c3851b`) with a scratch script that drives the real `src/users/UserManager.ts`
on a temp state directory. No code was changed.

| # | Steps | Observed on disk or in memory |
|---|---|---|
| 1 | Managers A and B load an empty store; A adds alice, then B adds bob | `['bob']`: **alice is lost** |
| 2 | Managers C and E load; C removes bob; E adds carol | `['bob', 'carol']`: **bob is resurrected** |
| 3 | bob is removed; `new UserManager(dir, [bob])` is constructed | `['carol', 'bob']`: **merely constructing a manager re-adds a removed config user and writes the file** |
| 4 | A long-lived manager is open; a second manager adds dave | long-lived `getUser('dave')` is `null` |

Case 4 used a second in-process manager, which runs the same code as `instar user add`
(`src/commands/user.ts:22`). The peer half of the reproduction was **not run**, because this sandbox
has no multi-machine environment. Statements about peers below come from reading the code.

### 2.2 From reading the code

Line numbers in the original report have drifted; these are current.

**Construction sites (13).** `src/commands/server.ts:8651, 8767, 9854, 14099, 14110, 23571, 26132`;
`src/server/AgentServer.ts:3303`; `src/server/routes.ts:3757, 33568, 33595`;
`src/commands/user.ts:22, 54`.

- Long-lived: `server.ts:8651` (send-only) or `8767` (normal), `9854` (Slack),
  `AgentServer.ts:3303`, plus the read-only cached `26132`.
- Only `attachUserReplication` targets get an emitter (`server.ts:5700`). `AgentServer.ts:3303` and
  the per-request managers have none.
- Eight of the sites pass `config.users`, which makes the constructor capable of writing. That
  includes read paths: `GET /permissions/users` (`routes.ts:33595`) and both union-reader callbacks
  (`server.ts:14099, 14110`).

**Writers that bypass `UserManager` entirely.**

- `routes.ts:29804` (`updateProfile`) does read, `Object.assign`, then a plain `fs.writeFileSync`.
  It has no atomic rename, no validation (so it skips the fixture refusal) and no emitter.
- `PostUpdateMigrator.ts` (fixture quarantine, around line 2790) rewrites the file directly.
- `init.ts` and `setup.ts` write the initial file before any server exists. These are harmless.

**Two defects the report did not name.**

- **Signed test-identity rows get erased.** Only the manager at `server.ts:8767` holds
  `testIdentityKey`. Every other manager skips a legitimately signed `allowTestIdentity` row on load
  (`verifyAllowTestIdentity` returns false without a key), and `persistUsers` then writes a file
  without that row. Malformed rows are dropped the same way.
- **A corrupt file gets replaced.** `loadUsers` backs up a corrupt file and continues with an empty
  map, so the next `persistUsers` replaces the file with just the new user.

**Other stores with the same shape.**

| Store | Pattern | Exposure |
|---|---|---|
| `EvolutionManager` (3 files) | Re-reads on each call, then read-modify-write with no lock | Narrow race with `instar reflect` (`ReflectionConsolidator.ts:89`, no emitter) |
| `KnowledgeManager` catalog | Same; `instar knowledge` runs as a separate process | Narrow race between CLI and server |
| `RelationshipManager` | One file per record, but the cache loads once | The server can re-save a record the CLI deleted (reconciler spec §5.3) |

**Corrections to the record.**

- Reconciler spec line 58 lists `instar user add/remove`, but there is no `user remove` command
  (`src/cli.ts:1635-1654` has only `add` and `list`). The only production caller of `removeUser()`
  is `UserPropagator.ts:191`. The CLI-delete gap for users is therefore prospective, while the
  stale-writer resurrection is live today.
- Puts from the CLI already have a route to peers: the reconciler seam reads `users.json` directly.
  What they lack is any route into the server's in-memory state.

## 3. Proposed fix

### 3.1 Decision: a file-level write funnel, not a single owner process

The report offers either. Routing every write through the server would make the CLI depend on a
running server, yet `instar user add` must work when the server is down and before first boot. A
funnel fixes both in-process and cross-process writers with one mechanism, and needs no new IPC.

Sharing one `UserManager` inside the server is **not** sufficient on its own, because it leaves CLI
processes unsolved. It also needs `RouteContext` plumbing that the funnel makes unnecessary.

### 3.2 Phase 1 — `users.json` funnel

**New helper, `src/core/lockedJsonFile.ts`:**

```ts
withFileLockSync<T>(file: string, fn: () => T, opts?: { deadlineMs?: number }): T
atomicWriteJsonSync(file: string, value: unknown): void   // unique temp + rename
```

It is built on `proper-lockfile`, already a dependency, with a dedicated lock path (`<file>.lock`,
`realpath: false`) so the target need not exist. It generalises `lockSyncWithRetry` from
`PasskeyCredentialStore.ts:58`.

- The deadline defaults to 2 s and the stale threshold is 10 s.
- The manager API is synchronous, so a contended lock briefly blocks the event loop. The critical
  section contains a read, rename and local journal append; measure its duration and keep the
  ordinary case within milliseconds. The deadline bounds lock acquisition, while a separate
  watchdog must report a slow append.
- On timeout it throws a typed `StoreLockTimeoutError`. It never falls through to an unlocked write.

**`UserManager` mutations become disk transactions.** `upsertUser` and `removeUser` each do this:

1. Take the lock.
2. Read the **raw** array from disk.
3. Check channel collisions against disk, not memory.
4. Apply a single-record change to the raw array.
5. Write atomically and rebuild the in-memory map from the array just written.
6. If a replication emitter is attached, append the affected user's `put`, or the removed user's
   tombstone, to the local journal synchronously while holding the same file lock. Do not emit every
   survivor. A failed
   emit is counted and leaves the local write intact; the reconciler retries the current disk
   projection, and Phase 3's durable intent covers a delete.
7. Release the lock. No deferred emitter may publish an older snapshot after a later transaction.

Applying the change to raw rows is what preserves rows this manager cannot load, including signed
test-identity rows it has no key for and malformed rows. `persistUsers()`, the whole-map save, is
deleted. The lock serializes local journal appends with file commits across manager instances and
CLI processes. Emitting only the affected record also avoids re-publishing an unchanged survivor
after another process deletes it. The synchronous journal append is part of the bounded critical
section; a slow or failed append must be measured and reported, and must never fall back to an
out-of-lock replay of an old snapshot.

**Failure rule: an unparseable file aborts the write.** The transaction throws and leaves the file
alone, rather than replacing it. Boot-time load keeps its backup-and-continue behaviour, so a corrupt
file still cannot stop boot.

**Reads refresh.** Every public read first compares `(ino, mtimeMs, size)` from `fs.statSync` with
the last-seen signature and reloads on change. `ino` is included because an atomic rename always
changes it. This extends the pattern at `server.ts:26119`, and it also covers `users.json` changing
through a git-sync merge. If a refresh finds a corrupt file, the manager keeps its last good map and
logs loudly.

**Constructors stop writing.** The `initialUsers` merge moves to an explicit
`seedInitialUsers(users)` method that runs inside the funnel, adds only ids missing from disk, and is
called once at boot by the authoritative manager. Other sites stop passing `config.users`. This fixes
case 3 for the read paths. For the boot seed itself, see decision D1.

**Bypassing writers move onto the funnel:**

- `routes.ts:29804` calls a new `UserManager.updateProfile(id, patch)`, which validates. This also
  makes that route atomic and gives it replication.
- The `PostUpdateMigrator` quarantine rewrites under `withFileLockSync`.
- `init.ts` and `setup.ts` stay as they are, because they run before any concurrent writer exists.

**Ratchet test:** a source scan fails if any non-allow-listed file under `src/` writes `users.json`
other than through the funnel, so a new bypass cannot land quietly.

### 3.3 Phase 2 — the same funnel for the other stores

- `EvolutionManager`: wrap each load-modify-save in `withFileLockSync` on that file.
- `KnowledgeManager`: same for `catalog.json` in `ingest` and `remove`.
- `RelationshipManager`: re-read the record from disk before `save`. If the record file is gone and a
  deletion intent covers it, refuse the re-save. This closes the resurrection noted in reconciler
  spec §5.3.

Each store uses its own file lock for the complete read-modify-write and local journal append. A
writer must never emit from a snapshot after releasing the lock; a failed append is recovered from
the current disk projection or a durable deletion intent. Phase 2's tests exercise these orderings
before Phase 3 enables tombstones.

Phase 2 can ship independently of Phase 1. It must ship before Phase 3 for the two evolution files.

### 3.4 Phase 3 — tombstones for the three puts-only stores

Do this only after Phases 1 and 2, because it is only safe once a missing row can no longer be a lost
update. It extends the existing mechanism and adds no new one:

- `UserManager.removeUser` and the `EvolutionManager` prune paths (`saveLearnings`, `saveActions`)
  write `recordDeletionPending` before the commit and `recordDeletionDone` after it, as
  `KnowledgeManager.remove` does at `KnowledgeManager.ts:197, 209`.
- The pending intent, file commit, ordered journal append and done marker all occur under that
  store's file lock. If the process dies between them, recovery uses the durable pending intent;
  no later writer may publish the older key from an earlier snapshot.
- Add key-only builders, starting with `buildUserTombstoneFromKey` (today only the channel-based
  `buildUserTombstoneData` exists), plus learning and action equivalents.
- Add `deletionIntents` and `tombstoneFromKey` to the three seams in
  `ReplicatedStoreReconcilerWiring.ts`, and update reconciler spec §5.3 and the §6 store table.
- The inference rule does not change: tombstones come only from explicit intents, never from absence.
- Archived actions are unaffected. `expire` deliberately writes no tombstone
  (`EvolutionManager.ts:1303`), and that stays true.

**Channel changes need an intent too.** `deriveUserRecordKey` hashes the full channel set, so an
upsert that changes a user's channels creates a new key and strands the old record on peers. With the
funnel, the transaction can see both versions, so it writes an intent for the old key and appends the
old-key tombstone before the new-key put while holding the lock.

## 4. Coverage after the fix

| Mutation | Local file safe | Server sees it | Reaches peers |
|---|---|---|---|
| Server manager add/update | Yes | Yes | Hook and reconciler |
| Per-request manager add | Yes | Yes | Reconciler |
| `updateProfile` route | Yes (new) | Yes | Reconciler |
| `instar user add` | Yes | Yes (new) | Reconciler |
| `removeUser` in any process | Yes | Yes | Tombstone by intent (new, Phase 3) |
| User with **no channels** | Yes | Yes | **No, by design** |

The last row is a deliberate exclusion. A channel-less user has no cross-machine identity
(`deriveUserRecordKey` returns null), so `instar user add` with no channel should print a notice that
the user stays on this machine.

## 5. Limits

- The lock covers one machine's filesystem. Cross-machine convergence remains the journal's job.
- During an update, an old server still running beside a new CLI does not honour the lock. The window
  closes when the server restarts.
- A reader can still see a value that is one stat old. That is acceptable for resolution, and REQ-M14
  (the local index is authoritative for inbound principals) is unchanged.
- Refresh-on-read adds one `statSync` per lookup. Measure this on the Telegram resolution path during
  Phase 1.

## 6. Test plan

Phase 1 tests fail on today's code and pass after the fix.

**Unit, `tests/unit/user-manager-write-funnel.test.ts`:**

- Two managers add different users sequentially, and both survive (case 1).
- A stale manager's upsert does not resurrect a removed user, and the emitter sees no `put` for it
  (case 2).
- Two managers interleave an upsert and a remove while journal emission is paused. The later delete
  cannot be followed by an older `put`, including when the first manager held other survivors.
- An emission failure after the file commit never schedules an out-of-lock replay of that snapshot;
  the reconciler sees only the current disk value or the durable delete intent.
- Constructing a manager never writes `users.json`, compared by bytes and `ino` (case 3).
- A long-lived manager sees an external add without being rebuilt (case 4).
- A keyless manager's write preserves a signed test-identity row and a malformed row.
- A write against a corrupt file throws and leaves the bytes unchanged.
- A channel collision with a row only on disk is refused.
- Lock timeout throws `StoreLockTimeoutError` and writes nothing.

**Integration, `tests/integration/user-manager-multiprocess.test.ts`:** N child processes each add M
users concurrently, and all N×M are present afterwards with the file parseable throughout.

**Phase 2, `tests/unit/replicated-store-write-funnels.test.ts` and
`tests/integration/replicated-store-multiprocess-writes.test.ts`:**

- Two `EvolutionManager` instances update the same learnings and actions files from stale views;
  both distinct records survive. A concurrent prune and save cannot restore the pruned record or
  publish an older `put` after its tombstone.
- A CLI `instar reflect` process and a running manager write distinct evolution records at the same
  time; both remain on disk and the journal follows commit order.
- Two `KnowledgeManager` instances, including one launched through `instar knowledge ingest`, add
  different catalog entries while one removes another entry. No entry is lost or resurrected, and
  the removal intent remains durable across a process restart.
- Two `RelationshipManager` instances save and delete the same record with a forced interleaving;
  a stale save sees the deletion intent and refuses to restore the record. Unrelated records survive.
- Each store's lock timeout refuses a write without changing file bytes or appending an event.

**Phase 3:**

- Extend `replicated-store-reconciler-wiring.test.ts` so the three stores are seamed with intents.
- A two-instance e2e test extending `tests/e2e/ws2-userregistry-cross-instance.test.ts`: remove on
  instance A in a process with no emitter, and assert the tombstone reaches instance B.
- A lost-update test proves that a row missing without an intent produces no tombstone.
- A channel-set edit on instance A leaves no old-key ghost on instance B. A peer that still holds
  the older, smaller channel set retains its valid identity until it receives the ordered old-key
  tombstone and new-key put; inbound resolution never grants a channel to the wrong user.

**Regression:** the existing `UserManager`, `ws26-user-topicop-*` and `silent-loss-*` suites. Tests
that rely on the constructor persisting `initialUsers` will need updating, which is expected.

## 7. Rollout and rollback

- Phases 1 and 2 change no file format and need no migration. They are always on, because a data-loss
  fix should not sit behind a flag. Rollback is a revert, and lock files left behind go stale harmlessly.
- Phase 3 rides the existing per-store `multiMachine.stateSync.*` gates. A tombstone already emitted
  is a removal on every peer and a revert does not undo it, so start with one dev agent and watch the
  reconciler counters before widening.

## 8. Design choices

- **D1. A removed user who is still in `config.users`.** The boot seed would re-add them on restart.
  Recommendation: skip the seed when the newest intent for that record key is `done`, and log it. The
  cost is that deliberately re-adding the same person to config then needs an explicit
  `instar user add`.
- **D2. Writes refused on a corrupt file.** Registration stays blocked until the file is repaired.
  Recommendation: accept this and raise an attention item, because the alternative is silently losing
  every other user.
- **D3. Should `instar user remove` exist?** It is not required for this fix, and Phase 3 makes it safe
  to add. Recommendation: leave it to a separate change, and correct reconciler spec line 58 either way.
- **D4. Intent for a changed channel set (§3.4).** Recommendation: include it. Without it, every
  channel edit leaves a ghost record on peers. The implementation must preserve the identity of a
  peer holding the older, smaller channel set until the ordered old-key tombstone and new-key put
  arrive. The Phase 3 cross-instance test above verifies that boundary under REQ-M14.
