---
title: "Fix: replicated-store producers are instance-bound — UserManager last-writer-wins and unwired CLI writers"
slug: "feedback-feedback-e368a65b-a6ca-4ea5-acff-e129f76e3294"
author: "echo"
status: "draft"
parent-spec: "docs/specs/statesync-writer-agnostic-reconciler.md (the on-disk backstop); docs/specs/multi-machine-replicated-store-foundation.md (send-side emitter)"
feedback-cluster: "cluster-replicated-store-producers-are-instance-bound-several-userma"
severity: "critical"
---

# Problem

The users registry (`<stateDir>/users.json`) has more than one writer, and those writers
do not coordinate. A write can therefore silently erase another writer's records, and
some writers never take part in replication.

1. **Several in-memory owners of the same file (lost update).** `UserManager` loads
   `users.json` into a private `Map` once, in its constructor (`loadUsers`). After that,
   every mutation calls `persistUsers()` (`src/users/UserManager.ts:409`), which writes the
   **whole in-memory map** to a temp file and renames it over `users.json`. The temp file plus
   rename prevents a torn file. It does nothing for a stale read, so the last writer wins.
   Two managers with different views will each overwrite the other's additions.

   Current construction sites (non-test):

   | Site | Lifetime | Writes? | Replication attached? |
   |---|---|---|---|
   | `src/commands/server.ts:8411` `userManagerSendOnly` | long-lived | yes | yes (`attachUserReplication`) |
   | `src/commands/server.ts:8527` `userManager` (normal mode) | long-lived | yes | yes |
   | `src/commands/server.ts:9540` `slackUserManager` | long-lived | yes | yes |
   | `src/server/AgentServer.ts:3261` `arUsers` | long-lived | via `initialUsers` merge | no |
   | `src/server/routes.ts:33050` `buildSlackRegistry()` | per request | yes (`addUserInteractive`) | **no** |
   | `src/server/routes.ts:33077`, `:3726`; `server.ts:23069`, `:25431` | per call | via `initialUsers` merge only | no |
   | `src/commands/user.ts:22` `instar user add` | separate process | yes | **no** |

   Note that **any** construction with a non-empty `initialUsers` argument can write: a
   config user that is not yet on disk goes through `upsertUser`, which calls `persistUsers`.
   So even "read-only" per-request sites can write a full snapshot from a fresh load.

2. **Writers in other processes skip replication.** `instar user add`, `instar relationship`,
   `instar knowledge ingest` and `instar reflect` run as separate processes. They build their own
   managers (e.g. `src/commands/relationship.ts:26` constructs a `RelationshipManager`) with no
   journal emitter. Two consequences follow:
   - the server's long-lived in-memory managers never see the change. Worse, the next
     server-side `persistUsers()` writes the server's stale map back to disk and **erases the
     CLI's record**;
   - no `emitPut`/`emitDelete` is produced, so peers learn about the change only if the
     writer-agnostic reconciler later picks it up from disk (if it survived that long).

3. **Deletion propagation has to stay off until 1 and 2 are fixed.**
   `ReplicatedStoreReconcilerWiring.ts:156` (userRegistry), `:176` (learnings) and `:195`
   (evolutionActions) are deliberately puts-only. A lost update looks identical to a
   deletion on disk. Turning on tombstones-from-disk now would broadcast a clobbered record
   as a deliberate delete to every peer, so one local race would become fleet-wide data loss.

# Evidence

- Reporter (CMT-1005, 2026-10-25): "several UserManager instances write one users.json
  last-writer-wins; CLI processes … and per-request managers construct unwired managers."
  Line numbers in the report have drifted. The table above uses current `HEAD`.
- `src/commands/server.ts:5505-5518` comment states the gap directly: "there is NO single
  canonical UserManager … SECONDARY paths NOT covered … the Slack org-permission admin
  route (per-request UserManager in routes.ts) and the `instar user add` CLI (a separate
  process)".
- `persistUsers()` does not re-read the file or check for changes before it writes.

## Reproduction (to become the failing test)

```ts
const a = new UserManager(dir); const b = new UserManager(dir);   // both load {}
a.upsertUser(alice);   // users.json = [alice]
b.upsertUser(bob);     // users.json = [bob]   ← alice lost
expect(new UserManager(dir).listUsers().map(u => u.id).sort()).toEqual(['alice','bob']); // FAILS today
```

Cross-process variant: start a server-mode `UserManager`, run `addUser()` from
`src/commands/user.ts` against the same `stateDir`, then make any server-side upsert. The
CLI user disappears from disk. No journal entry was ever emitted for it.

# Proposed fix

Two layers. Layer A makes a write safe no matter who performs it. Layer B makes every
supported write path replicate. Layer C (turning on tombstones) depends on both.

## Layer A — file-level write funnel (read-modify-write under a lock)

Change `UserManager` so that each mutation applies a **delta** to the current disk state
instead of writing out a snapshot:

1. `upsertUser` / `removeUser` / `addUserInteractive` take an exclusive lock on
   `users.json.lock`. Use `proper-lockfile`, which is already a dependency through
   `SharedStateLedger`. Settings: stale timeout ≈10s, bounded retries. This lock works
   between processes, so it covers both the CLI and the server.
2. Inside the lock: **re-read** `users.json` with the same validation and fixture refusal
   that `readProfilesFromDisk` already uses. Apply only the single-record change. Write
   with the existing temp-file + rename. Refresh `this.users` / `this.channelIndex` from
   the merged result.
3. If the lock cannot be acquired, throw an error (fail closed). Do not fall back to an
   unlocked write. A registry write is rare and initiated by an operator, so a visible error
   is better than silent loss.
4. Reads keep using the in-memory cache, refreshed from disk when it is cheap to check:
   `fs.statSync(usersFile).mtimeMs`/size compared with the last value seen, checked in
   `resolveFrom*`/`getUser`/`listUsers`. A long-lived manager then picks up CLI and peer
   writes without a restart.
5. The `initialUsers` merge in the constructor runs through the same locked delta path,
   so per-request constructions cannot write a stale full snapshot either.

This alone fixes the reproduction above and the server-erases-CLI-record case.

## Layer B — every supported mutation replicates

The in-process emitter only reaches managers that `attachUserReplication` was called on.
Instead of plumbing an emitter into every construction site (routes, CLI), **remove the
need for one at the producer**:

- **In-process:** add a module-level registry `getUserManager(stateDir)` that returns
  one shared instance per `stateDir`. Point the three long-lived server sites,
  `AgentServer.ts:3261`, and the `routes.ts` sites at it. `attachUserReplication` is then
  called once. Each `new UserManager(...)` in `src/server`/`src/commands/server.ts`
  becomes a lint/test failure (allowlist: tests, `commands/user.ts`).
- **Separate processes (CLI):** the CLI writes through Layer A only, so the disk stays
  correct. Replication for those writes comes from either:
  - (preferred) **server delegation**: when a server for the agent is running (health
    check on the configured port), `instar user add` calls an authenticated local route
    (`POST /users`, admin auth) so the server's shared, emitter-wired instance performs the
    write. The CLI uses the file-direct Layer A path only when no server is running, and
    prints a note that the change will replicate after the next reconcile; or
  - (backstop, already specified) the writer-agnostic reconciler sees the `users.json`
    change and emits puts. With Layer A in place, the on-disk state is a correct
    superset, so a reconciler put is trustworthy.
- Use the same pattern for `RelationshipManager` (`commands/relationship.ts`), knowledge
  ingest and `reflect` (learnings/evolution stores): one shared instance per process,
  locked delta writes to their JSON files, and server delegation from the CLI when
  available. This spec covers the UserManager change in full. The other stores need one
  follow-up each, using the same helper (see "Shared helper").

### Shared helper

Pull Layer A out into `src/core/LockedJsonStore.ts`:
`mutate<T>(file, (current: T) => T, { validate })` → lock, read, apply, write atomically,
unlock. Then UserManager, RelationshipManager and the evolution stores share one audited
implementation instead of three ad-hoc ones.

## Layer C — enable deletion propagation (after A and B)

Only after Layer A has shipped for a store may its reconciler seam add
`deletionIntents`/`tombstoneFromKey`, as the knowledge seam already does. A record that
disappears from disk must be backed by an explicit deletion intent written by
`removeUser` inside the same lock, never inferred from absence alone. This keeps a
residual race (e.g. a manual edit of the file) from turning into a fleet-wide tombstone.

# Tests

- `tests/unit/users/UserManager-concurrent-writers.test.ts`
  - "two UserManager instances sharing users.json preserve both additions" (the
    reproduction above, fails today).
  - "removeUser on one instance does not resurrect via a stale second instance".
  - "a long-lived manager observes a write made by another instance (stat refresh)".
- `tests/integration/user-cli-replication.test.ts`
  - Child process runs `addUser` while an in-process server-mode manager exists. The CLI
    record survives a later server upsert and is emitted (delegated path) or reconciled
    (backstop path).
- Lint/ratchet test: no `new UserManager(` in `src/server/**` or `src/commands/server.ts`
  outside the shared accessor.

# Risks and rollout

- Lock contention: registry writes are rare, so the impact is negligible. Lock stale-detection
  covers a crashed holder.
- The stat-based refresh adds one `stat` per resolve. That is cheap, and it can be throttled
  (e.g. at most once per 1s).
- Behaviour on single-machine agents only changes in that lost updates stop happening.
  Replication stays dark by default.
- Ship order: A (UserManager) → B (shared accessor + CLI delegation) → the same A/B for
  relationships, learnings and evolution actions → C, one store at a time.

# Open questions

- Should CLI delegation be required when a server is detected (refuse the direct write),
  or only preferred?
- Is a `POST /users` admin route acceptable from a security point of view, or should the
  CLI use the existing internal-auth channel?
