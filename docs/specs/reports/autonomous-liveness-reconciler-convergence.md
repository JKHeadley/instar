# Convergence Report — Autonomous Liveness Reconciler

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI on every round (rounds 1–3) and returned `MINOR ISSUES` with no blocking architectural flaw on the converged design. Gemini-2.5-pro was attempted each round and `degraded (timeout)`; per the aggregation rule the spec-level flag is the clean successful codex pass. The spec received genuine outside-the-Claude-family review.

## ELI10 Overview

When the agent runs a long autonomous job, its actual running process gets recycled every few hours — normally invisible, because the job is supposed to automatically come back. One night that automatic comeback failed: a lookup returned empty at the exact instant of the recycle, so nothing brought the job back. The job's status file still said "active, 15 hours left," but no process was running it, and nothing was watching for that contradiction. The user messaged an hour later to silence.

This spec adds a small background "watcher" that works like a thermostat instead of a one-time switch: it continuously checks "for every job that says it's active with time left, is a process actually running it? If not — and it's safe — bring it back." Because it re-checks continuously, it heals the job no matter *how* it got orphaned. It is the companion to the already-shipped "heartbeat" (which handles "alive but quiet"); this handles the worse "gone but the records say I'm here."

The review process changed the design substantially, and the headline change is honesty about scope: the watcher is now explicitly a **backstop**, and the spec **also fixes the original lookup bug at its source** in the same change — so we're not papering over a real, reproducible bug with a polling loop. The other big changes made the watcher safe under stress (it no longer fights the session-reaper into mutual exhaustion), race-free (an atomic claim + a kill-if-stopped check so a just-issued stop always wins), and bounded (it gives up loudly after a few tries instead of looping). It ships off for everyone and in observe-only mode on the dev agent first.

## Original vs Converged

- **Originally** the watcher was the *only* fix. **After review** it ALSO fixes the root-cause lookup bug (a `getTopicForSession` returning null at the reap instant, confirmed in the actual code at `server.ts:7429`) in the same PR — a backstop that masks a deterministic bug is the Phase-2 anti-pattern.
- **Originally** it would respawn whatever was gone. **After review** it pressure-gates against the session-reaper (which deliberately sheds sessions under load) — and that skip is itself bounded so a chronically-loaded box can't leave a dead run dead forever.
- **Originally** "is anyone already spawning this?" was a non-atomic check. **After review** it's an atomic in-process claim taken *before* a live re-check, with a post-spawn settle that kills the new session if a stop arrived during the async spawn — and that kill clears the `midWork` tag so the revival queue can't undo it.
- **Originally** it trusted the run's own state file for the working directory and resume id. **After review** the state file is untrusted input; cwd comes realpath-resolved from the authoritative binding registry (refusing anything that escapes the agent home), resume id from the canonical resume map (missing → attention, not a silent fresh start), and a stale state file from an obsolete run is rejected by a generation check.
- **Originally** "shared cap with the queue" was asserted but didn't exist. **After review** the reconciler owns its own cap, and collective over-spawn is prevented by the in-flight lock + counting the queue's resurrections toward the same give-up bound.
- **Plus**: snapshot sessions once per tick (not hundreds of subprocess calls), bound each respawn with a timeout, re-entrancy guard, GC the bookkeeping maps, and a concrete plan to flip it from observe-mode to live.

## Iteration Summary

| Round | Reviewers | Material findings | Spec changes | Standards-Conformance Gate |
|-------|-----------|-------------------|--------------|----------------------------|
| 1 | security, adversarial, scalability, integration/multi-machine, decision-completeness, lessons-aware + codex (gemini degraded) | ~30 (incl. CRITICAL reaper-thrash, HIGH double-spawn, HIGH root-cause-not-fixed) | comprehensive rewrite | ran (0 flags) |
| 2 | full 6 internal + codex (gemini degraded) | ~12 (incl. HIGH pressure-permanent-death, HIGH spawn-lock deadlock, HIGH await-gap unsound, HIGH lease self-block, HIGH closure-hoist) | targeted round-3 revision | n/a (signal-only) |
| 3 | security, adversarial, decision-completeness + codex | 2 material (HIGH settle-kill/midWork bypass, MED generation source) + codex MINOR clarifications | 2 fixes + 2 clarifications | n/a |
| 4 | focused security/adversarial confirmation | 0 (both fixes SOUND) | none | n/a |

## Full Findings Catalog (material, by round)

**Round 1 (resolved in the round-2 rewrite):** reaper-vs-reconciler thrash burns the cap and abandons a healthy run (CRITICAL → pressure-gate + reap-log consult + mark-respawned-midWork + root-cause fix); double-spawn window with the ResumeQueue (HIGH → shared in-flight predicate); root cause not fixed, only backstopped (HIGH → same-PR edge fix); operator-stop not re-checked across the await (HIGH → actuation recheck); run-state file trusted for cwd/resumeUuid (HIGH → untrusted-input + authoritative sources); failed-spawn vs redie conflated (HIGH → separate counters); per-tick O(runs×sessions) tmux subprocess fan-out (HIGH → once-per-tick snapshot); await-in-loop blocks the tick (HIGH → respawn timeout); shared-cap claimed but absent (HIGH → resolved: reconciler owns its own); plus debounce-gaming, notice/attention flood, dryRun masks the thrash, epoch-0 stop lookback, cap GC, re-entrancy.

**Round 2 (resolved in round 3):** pressure-gate → permanent death (HIGH → bounded skip); in-flight `spawning` flag leak → deadlock (HIGH → TTL); "across no await gap" unsound (HIGH → atomic claim + settle-kill); lease AND-gate self-blocks single-machine dev (HIGH → holdsLease defaults true on null syncStatus); extracted closures capture block-local `resolveTopicForTmux` (HIGH → hoist); liveness closure reintroduces fan-out (HIGH → own snapshot); midWork re-loops through the queue's cap (MED → unify); active-state circular authority (MED → generation match); resumeUuid-absent silent fresh (MED → attention default); reap-log window gameable (MED → max-cadence window).

**Round 3 (resolved in round 4):** settle-kill of a midWork-tagged session revived into a stopped topic (HIGH → settle-kill is a terminal abort that clears midWork); run-generation source under-specified (MED → named `started_at` + optional `run_generation` stamp); codex MINOR: in-flight claim primitive + authoritative-source precedence (folded as clarifications).

**Round 4:** both fixes confirmed SOUND; no new material issues → converged.

## Convergence verdict

Converged at round 4. The final round produced zero material new findings (both round-3 fixes confirmed sound). Zero unresolved entries in `## Open questions`. The spec is ready for user review and approval. The build (component rewrite to match the converged design + the same-PR root-cause edge fix + server/route wiring + 3-tier tests) follows on `approved: true`.
