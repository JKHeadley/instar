# Side-Effects Review — the session build-context store drops expired rows on write

**Version / slug:** `build-context-prune`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `not required (see below)`

## Summary of the change

Tier 1. `SessionBuildContextStore.record()` in `src/core/SessionBuildContextStore.ts` writes the store through a new private `withoutExpired(all, now)`, which leaves out rows whose `updatedAt` is more than `maxAgeMs` (default six hours) old. No other method changes. One source file, one test file.

Why: rows were never removed. On the Studio the file reached 32,378 rows / 8.2 MB, 99.7% expired; `record()` parses the whole file for every running session on every monitor pass and rewrites it for every new session.

## Decision-point inventory

None. `getRestore()` (which decides whether a restart restores a build context) is unchanged; it already refused every row this change removes.

---

## 1. Over-block

Not applicable as a gate. What is removed that might have been wanted: nothing readable. `getRestore` returns null for a row past `maxAgeMs`, and no other reader of the store exists in `src` (the per-machine key is read only through this class).

## 2. Under-block

- **The store is still read in full on every `record()` call.** With pruning it stays at about the number of sessions seen in the last six hours (90 rows / 24 KB on the Studio), so the cost is small, but the read-parse per session per pass remains. Caching it in memory would be a larger change with a multi-writer question, and is not needed at this size.
- **A store that is never written is never pruned.** An agent that stops spawning sessions keeps its old rows until the next write. It also stops paying for them: fewer sessions means fewer `record()` calls.
- **The legacy shared key and other machines' keys** are not touched; each machine prunes its own file on its own writes.

## 3. Level-of-abstraction fit

The store owns its own retention; the rule used is the one the store already applies on read. No scheduler, job or migration is added: the first write after the update shrinks the file.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No block/allow surface. A data-retention change inside one store.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point. The age limit is the existing constant.

## 5. Interactions

- **Behaviour change, deliberate:** a session that stays in one worktree past `maxAgeMs` used to keep an expired row (`record()` returns early when the paths are unchanged, so `updatedAt` was never refreshed). Now that row is dropped at the next write, the next `record()` for the session finds no prior row and writes a fresh one, and a restart restores the worktree. Cost: one extra write per long-lived session per six hours. Pinned by a test.
- **Write frequency is otherwise unchanged:** writes still happen only when a session's paths change or a new session appears. The hot path (unchanged session) writes nothing; pinned by a test.
- **Concurrent writers:** the store is single-writer per machine key (standby-write-reconciliation §3.3). Pruning adds no new read-modify-write window; it filters the object already being written.
- **Git sync / state backup:** the file is per-machine state; a smaller file is a smaller diff. The first pruned write is one large deletion in that file's history.
- **Clock going backwards:** `now - updatedAt` negative keeps the row (it is `<= maxAge`), as `getRestore` also treats it as fresh.

## 6. External surfaces

- Install base: every agent with sessions runs this path; each one's file shrinks at its first write after the update.
- Persistent state: same file, same format, fewer rows. No migration.
- Operator surface: none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**: the recorded paths are on this machine's disk and the store is keyed per machine (existing design). Each machine prunes only its own key. No notices, no URLs.

## 8. Rollback cost

Pure code change: revert and release. Rows already pruned are not restored by a revert, and none of them was restorable.

---

## Second-pass review

**Reviewer:** not required. The change touches no block/allow decision, session lifecycle action, gate, sentinel or watchdog: `getRestore` and the respawn path are unchanged, and the rows removed are exactly the rows `getRestore` already refused. The one behaviour change (section 5) is stated and pinned by a test.

---

## Conclusion

Bounded retention for a store that had none, using the store's own existing age rule. Clear to ship.

## Evidence pointers

- Studio `state/session-build-context-m_03b3….json`, 2026-11-13 16:04Z: 32,378 rows, 8,209,026 bytes, 32,288 past six hours, oldest 2,078 h; after a manual prune 90 rows, 24,458 bytes (copy of the original kept beside the throughput scripts).
- Freeze and profile captures in `logs/server-freeze/` (15:31Z, 15:38Z, 15:56Z): `get <- readAll <- record <- recordBuildContextAsync` as the top JS frame group.
