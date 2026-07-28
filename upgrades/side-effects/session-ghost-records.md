# Side-Effects Review — Session ghost-record supersession (one running record per tmux name)

**Version / slug:** `session-ghost-records`
**Date:** `2026-06-11`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `subagent (session-lifecycle adjacency)` — see appended verdict

## Summary of the change

Closes the registry leak that made the dashboard show N "duplicate sessions" that were really one terminal plus N−1 stale records (live-observed 2026-06-11 on the Mac Mini: 5 `running` records all pointing at the single tmux session `echo-resource-limitation-mitigation`, accumulated across crisis respawns June 5–7). `StateManager.saveSession` — the single funnel all eleven spawn/update callsites already pass through — now enforces the invariant *one live record per tmux session name*: when a record registers as `running`/`starting`, any OTHER record still marked live for the same `tmuxSession` is closed (`status: 'completed'`, `endedReason: 'superseded'`, `supersededBy: <new id>`, `endedAt` stamped), each through `saveSession` itself so the coherence-journal funnel records the transition. New optional `Session.supersededBy` field (additive). Files: `src/core/StateManager.ts`, `src/core/types.ts`, `tests/unit/StateManager.test.ts`, `tests/unit/state-manager-listsessions-cache.test.ts`.

## Decision-point inventory

- `StateManager.saveSession` — modify — registry bookkeeping decision (which records count as live); NOT a process-level authority: it never touches tmux, never kills a process, never blocks a spawn.
- `supersedeStaleLiveRecords` — add — best-effort hygiene wrapped in try/catch; a failure can never block the live spawn being registered.
- Spawn/kill/reap authorities (`SessionManager.terminateSession`, reaper, watchdog) — pass-through, untouched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is rejected — the change never refuses a save. The risk shape is mis-CLASSIFICATION, not blocking: could a genuinely live record be wrongly closed? Only if TWO records claim the same tmux name as live, which the tmux layer makes impossible for real sessions (`tmux new-session` with an existing name fails, and every spawn site creates tmux BEFORE saving the record — a `running` save therefore implies the name was just (re)created, so any older claimant's terminal is gone or replaced). Cross-machine names are out of scope by construction: the registry is per-machine local state, so e.g. `echo-instar-exo` existing on both laptop and Mini collides with nothing.

## 2. Under-block

**What failure modes does this still miss?**

- Ghosts created WITHOUT passing through `saveSession` (a crash after tmux creation but before the save, or hand-written records) are not retro-collapsed until the next live registration for that name. Existing on-disk ghosts on deployed agents collapse on each tmux name's NEXT respawn, not at update time — accepted: a migration sweep was considered and rejected because the next-registration path covers it with zero migration risk, and the dashboard cost of a stale ghost until then is cosmetic.
- A ghost whose tmux name never spawns again is never superseded (it just ages as a stale `running` record, exactly as today). The reaper's registry-vs-tmux zombie reconciliation remains the owner of that case.
- **Transitional window on deployed agents** (second-pass finding): until each name's first post-fix registration, pre-existing ghosts are still on disk, and the two find-by-tmuxSession re-save paths (`renameSessionByTmux`, `ModelSwapService`) can `find()` a ghost and re-save it as running — promoting the ghost and superseding the REAL record. Nothing strands (both records point at the same live terminal, and the very re-save collapses the duplicate set to one), id-keyed tracking degrades only until that session's next respawn, and the state is no worse than the pre-fix corruption it inherits. Bounded, transient, self-healing — accepted.

## 3. Level-of-abstraction fit

Correct layer. The invariant is a REGISTRY truth ("at most one live record per tmux name"), so it lives at the registry write funnel — the same single-funnel rationale as the coherence-journal derivation directly below it in the same function. Putting it at the spawn callsites (eleven of them) is the drift-prone shape this codebase explicitly rejects; putting it in the reaper would conflate hygiene-at-write with liveness-policy-at-tick.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Pure data hygiene: it corrects bookkeeping about which record represents a tmux session; it holds no authority over processes, messages, or spawns. The supersession write path is fail-open (try/catch; a hygiene failure never endangers the registration being saved).

## 5. Interactions

- **Reaper / sentinels / monitor loop** (consumers of `listSessions({status:'running'})`): they now see ONE record per live tmux name instead of N duplicates — strictly more accurate input. The reaper's per-id observation maps (`obs`) keyed on ghost ids simply stop being fed; entries age out.
- **Kill/refresh flows** (account swap, SessionRefresh, fresh-respawn): these kill-then-respawn under the same tmux name; when their kill bookkeeping runs, the old record is already terminal (no supersession fires — terminal saves never enter the path). Supersession only catches the CRASH variants where kill bookkeeping never ran — the exact leak.
- **Order-of-writes race**: a later save of a just-superseded record (e.g. a swap path stamping the old record `killed` after the new spawn registered) overwrites `completed/superseded` with `killed` — both terminal, both truthful; no flapping (terminal saves trigger nothing).
- **Journal funnel**: each ghost closes through `saveSession`, so the coherence journal records a real `completed` transition per ghost (reentry terminates: a `completed` save never re-enters supersession). No double-fire: one transition per ghost, once.
- **listSessions cache**: each supersession save invalidates the cache via the existing path — visible immediately.

## 6. External surfaces

- `GET /sessions` (and the pool-merged `?scope=pool`) stops showing duplicates — the user-visible fix.
- `Session.supersededBy` + `endedReason: 'superseded'` are additive record fields; no consumer parses an exhaustive `endedReason` enum (it is a free-form string by type).
- No config, no migration, no template change (Migration Parity: behavior ships in code; existing agents get it with the update; existing ghosts self-heal on next respawn per §2).
- Multi-machine: per-machine registries; no cross-machine write, no mesh surface.

## 7. Rollback cost

Pure code change: revert and ship a patch. Records already marked `superseded` stay terminal after rollback — correct (they were ghosts; the live terminal's record remains running). No data migration, no state repair.

---

## Conclusion

The review sharpened one decision: ghosts are closed THROUGH `saveSession` (not direct file writes) specifically so the coherence journal sees the transitions — an earlier draft wrote files directly and would have silently skipped journaling. Three behavior tests were proven failing on the unfixed code first (supersede-on-respawn, multi-ghost collapse of the real Mac Mini shape, stale-starting supersession), plus three no-op guards (same-id re-save, different names, terminal saves). Clear to ship.

**Phase 1 principle check (recorded):** registry bookkeeping with no gate/block surface; signal-vs-authority applies as a constraint check only — no brittle logic gains blocking authority.

**Phase 2 plan (recorded):** fresh worktree `.worktrees/fix-session-ghost-records` off `JKHeadley/main` @ `e6c21fa8e` (v1.3.487), identity `Instar Agent (echo) <echo@instar.local>`, canonical remote verified. Rollback: revert (above).

---

## Second-pass review (session-lifecycle adjacency)

**Concur with the review.** Independently verified: (1) all four running-status spawn callsites create tmux inside a throwing try/catch BEFORE `saveSession`, and `tmux new-session` fails on duplicate names — so a running save provably implies the prior claimant's terminal is gone/replaced; supersession can only swap which record represents a terminal, never strand one. (2) Reentry is strict depth-1 (ghost saves are `completed`, skipping the live branch; `id !== next.id` prevents self-supersession). (3) Each ghost emits exactly one `running→completed` journal event; `endedReason` has no enum parser anywhere. (4) Swap/refresh paths kill (terminal save) before respawn — no double-kill; `terminateSession`'s CAS guard means a superseded ghost can no longer be a vector for killing the live terminal — strictly safer than pre-fix. (5) No boot path re-saves running records, so no boot-time wrong-record supersession. One non-blocking transitional-window observation recorded in §2.
