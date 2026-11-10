# Side-effects review — one carrier of post-compaction context (the server stands down when the hook seeded)

**Version / slug:** `cb-one-recovery-carrier`
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.1 ("One carrier of post-compaction context") and §7.7 (seeded marker, context epoch). Converged 6 rounds, approved by the operator 2026-11-09 17:22 PST (topic 141133). Phase 0, second slice; stacked on `cb-compaction-recovery-source` (PR #3014).
**Tier:** 2 (fleet-wide change to session recovery after compaction).
**Change size:** `src/core/PostUpdateMigrator.ts` (hook literal + one CLAUDE.md sentence migration), `src/monitoring/CompactionSentinel.ts` (seed wait), new `src/monitoring/compactionSeedMarker.ts`, `src/commands/server.ts` (two deps), `src/scaffold/templates.ts` (one sentence, two copies), tests.

## Summary of the change

Since PR #3014 the SessionStart(compact) hook seeds the session's recovery context. The server's `CompactionSentinel` still injected its own recovery payload on the PreCompact / watchdog / route triggers, so a compaction with an unanswered user message got two recovery copies. Now:

1. **Hook writes a seeded marker.** In the compact branch (switch on, Claude Code), the hook runs `compaction-recovery.sh` as a child instead of `exec`, prints its output unchanged, and only when it exited 0 and printed something writes `<agentHome>/.instar/state/context-layers/_seeded/<session_id>.json` (`{sessionId, epoch, source, seededAt}`; dir 0700, file 0600, atomic rename). The session id must match `[A-Za-z0-9_-]{1,128}`, so stdin cannot steer the path. Switch off or another engine: the old `exec`, byte-for-byte.
2. **Sentinel waits for it.** With the switch on, a marker reader wired, and a Claude Code session, `report()` enters `awaiting-seed` instead of injecting. It polls every 2 s. A marker that belongs to this compaction (written after its compact-boundary entry, 2 s slack; or after the report while no boundary is visible) and that is newer than the last marker already consumed for that session ⇒ `compaction:seeded`, finalized `recovered`, **no inject**. No such marker by 30 s after the boundary entry (or 180 s when no boundary ever appears) ⇒ today's path runs once, including its existing busy-session defer. The zombie-kill veto holds during the wait (status is non-terminal).
3. **Epoch binding.** Measured on real Claude Code 2.1.321: the SessionStart(compact) hook runs **before** this compaction's `compact_boundary` entry is flushed, so the newest boundary the hook can see is the *previous* compaction's. The hook therefore writes an empty epoch, and the sentinel binds it to the boundary entry that belongs to its report (newer than the last consumed marker, and not earlier than the report for a PreCompact trigger, 120 s lookback for the late watchdog/route triggers), the same deterministic key §7.7 names. Idempotence is keyed on the marker's `seededAt`: a marker is accepted only if it is newer than the last one consumed for that session.
4. **CLAUDE.md sentence.** "The compaction-recovery hook re-injects all of this. If it doesn't fire…" promised a recovery that never ran. Template and `migrateClaudeMd` now name the block to look for (`=== IDENTITY RECOVERY (post-compaction) ===`) and say what to read if it is missing. Idempotent exact-string replacement.

**L7 evidence (real Claude Code 2.1.321, throwaway project, real `/compact`):** marker written (`0600`, dir `0700`) with the real session id; transcript has `compact_boundary` uuid `49f9a483-…`. Replaying that real transcript and marker through the sentinel (PreCompact report 4 s before the boundary): `seeded by its compaction hook (epoch 49f9a483-…)`, 0 server injects.

Not in this slice, all in the same approved spec and tracked under CMT-1536: the server fallback moving onto the idle-gated `PendingInjectStore` path, retiring `recoverCompactedSession`'s payload into the standing packet (needs the Phase 1 layers), the PostCompact hook/route and the PreCompact steering hook.

## Decision-point inventory

- **Modified:** whether the server injects a recovery payload after a compaction. Today: always (subject to busy-defer). Now: not when a fresh, unconsumed seeded marker shows the hook already delivered. Deterministic over file evidence; no judgment.
- **Added:** none that blocks user-visible work.

## 1. Over-block

The server stands down when the hook seeded. If the hook's seed printed output but that output did not actually reach the model (the hook timed out after printing, say), the server no longer covers it. Bounded: the hook only reads local files and calls the local server with short timeouts, well inside 5 s in the L7 run; the standing canary (later Phase 0 slice) is what detects a seed that printed but never landed. A marker is written only on exit 0 with output, so a crashed or empty seed never suppresses the server path.

Slower fallback where the hook cannot help: if a session's Claude session id is not yet bound on the server, or a worktree session runs without `INSTAR_AGENT_HOME` (the marker lands under the worktree's `.instar`), the marker is unreadable and every recovery for that session waits 30 s after the boundary (180 s when no transcript is found) before the server injects. Fails in the safe direction; the delay is the cost.

## 2. Under-block

Two copies can still happen if the hook seeds after the sentinel already gave up (boundary seen, 30 s passed, no marker). That is the spec's bound, and a seed over 30 s late is itself a failure the canary counts. Non-Claude engines keep today's single server carrier.

Narrow residual: if compaction A was never reported to the sentinel, and a late (watchdog or route) report for compaction B arrives within 120 s of A before B's boundary entry is flushed, A's boundary and marker can satisfy B's wait. Harm only if B's own hook also failed; the standing canary (later Phase 0 slice) counts that as a compaction without a recovery block.

## 3. Level-of-abstraction fit

Right layer: the hook is the only process that knows its seed succeeded; the sentinel is the existing single owner of server-side recovery, and the wait is a new state in its lifecycle, not a parallel watcher.

## 4. Signal vs authority compliance

The marker is evidence; the sentinel holds the existing authority to inject and now declines when evidence shows delivery. No brittle check gains blocking authority over user messages. Fail direction: no marker / unreadable marker / switch off ⇒ today's behaviour.

## 5. Interactions

- **RateLimitSentinel defer:** unchanged; `deferIf` runs before the wait.
- **Zombie-kill veto:** held while `awaiting-seed` (non-terminal), so a seeded session is not reaped mid-wait; released 5 s after `recovered` as today.
- **Dedupe:** a second trigger during the wait hits the "already active" early return, as during injection today.
- **PreCompactionFlush:** independent consumer of the PreCompact event; untouched.
- **project-digest hook test / reachability test:** the recovery script is now referenced three times in the hook (check, legacy exec, seeding run); the reachability test's count updated, its invariant (every reference is the installed path) unchanged.

## 6. External surfaces

New file under `.instar/state/` (gitignored, never git-synced). No new route. One CLAUDE.md sentence changes on every agent. No user-facing message changes.

## 7. Multi-machine posture

Machine-local by design: the marker is written and read on the machine hosting the session, which is the only machine whose sentinel recovers it. Nothing replicates or needs to.

## 8. Rollback cost

`contextBudget.compactionRecovery.enabled: false` restores the old hook branch and the old sentinel path with no restart of sessions needed (the sentinel reads the switch live; the hook reads it per event). Release revert reinstalls the previous hook. Stray marker files are inert.

## Second-pass review

**Reviewer (independent subagent), first pass: Concern raised**, three points:
1. (high) The hook stamped the newest visible boundary, which on every compaction after the first is the previous compaction's, so a second compaction's marker collided with the consumed key and got a duplicate inject. **Fixed:** the hook writes an empty epoch; the sentinel binds the epoch and keys idempotence on the marker's `seededAt`; boundaries at or before the last consumed marker are never re-bound. Test: two compactions in one session each stand down on their own marker.
2. (medium) A previous compaction's unconsumed marker could stand in for a PreCompact report that arrived before its own boundary, leaving a failed seed uncovered. **Fixed:** a PreCompact report accepts only evidence at or after the report (2 s slack); the 120 s lookback applies only to the late triggers. Test: a previous unconsumed marker never stands in, and the server path runs when the new seed fails.
3. (low) Slower recovery where the marker is unreadable was not named. **Fixed:** named under Over-block.
Reviewer concurred on bash correctness, stuck-state handling, and switch-off / non-Claude byte-identity.

**Second pass: Concur after revisions** (verified against the code; 37/37 in the four affected test files). One narrow residual named under Under-block; artifact wording corrected.

## Addendum (2026-11-10) — silent-fallback markers

The repo's no-silent-fallbacks lint (`tests/unit/no-silent-fallbacks.test.ts`, baseline 494 on main) counted five of this change's catch blocks as silent. Each is a deliberate fail-safe in the direction of *today's behaviour* (the server sends its own recovery): an unreadable recovery switch, an unreadable or torn seed marker, a partial first line in the transcript tail window, and an unreadable transcript (no boundary ⇒ the marker is not trusted). Each now carries a `@silent-fallback-ok` reason; no behaviour changes. Lint back to 494; the CompactionSentinel and compaction unit tests (82) pass.
