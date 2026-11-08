# Side-Effects Review — Disk Steward

**Version / slug:** `disk-steward`
**Date:** `2026-11-07`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review below)`

## Summary of the change

Tier 2. A per-machine disk watcher (`src/monitoring/DiskSteward.ts`, `diskSteward/levels.ts`, `diskSteward/pruneRunner.ts`, `diskStewardMain.ts`, `diskSteward/pruneCategories.ts`, `DiskStewardPoster.ts`, `diskSteward/wiring.ts`, `src/server/diskStewardRoutes.ts`) runs inside every agent server. It measures free space, forecasts, cleans two tool caches when allowed, and posts through the lease holder in a "Disk space (all machines)" topic.

Companion fixes:
- `src/monitoring/agentWorktreeGit.ts` + `AgentWorktreeReaper.ts`: a linked `node_modules` and a provable `dist/` count as regenerable. Inbound-link index. A process command line keeps a checkout. A failed working-folder scan keeps all.
- `src/localVerify/orchestrator.ts` + `orchestratorSeams.ts` (+ `runVerifyMain.ts`, `LocalVerifyService.ts`, `localVerifyWiring.ts`): an orphan run sweep at run start. A `kept-failed.json` that cannot be parsed is never overwritten, and both readers record a degradation (`LocalVerify.keptList`) that rides the run result to the server's reporter; kept entries are listed with their size; a skipped sweep always says why in the run log; the process view (lsof, ps) is read once per sweep.

Registrations: notification category `disk-steward` + floor envelope factory + lint exception; system-topic key `agent-disk-topic`; config defaults + a dev-agent migration for cleanup; dark-gate exclusion (destructive); machine-local write domain + git-sync exclusion; feature ladder entry; self-action controller (eternal sentinel); CLAUDE.md section, template and migration; Registry First row.

Size: about 30 files, ~2,400 lines added. Effort: spec 6 review rounds (the Tier-2 cap), two scope cuts. Proportion: out of line with the original brief, for a stated reason. The deletion rules had to be fitted to this machine's real layout (shared dependency links, pipeline links, generated files).

**Local Verify follow-up (2026-11-08, Mac M5 Pro builder):** the first Local Verify run failed the unit lane in four files, all of them this PR's registrations rather than behaviour: the hand-authored dark-gate attribution map had no row for `monitoring.diskSteward.prune.enabled` (+21 line shift below it); the completeness test had no tracking entry for the migrator's `/disk-steward` sniff key (and the section had no Codex/Gemini shadow marker, now added); the new reaper test deleted its own fixture files through the guarded `SafeFsExecutor` funnel inside a repo it had itself promoted to an instar source tree (now plain `fs.unlinkSync` on fixture residue); and the silent-fallback ratchet rose by 8 (3 reaper walk catches, 2 steward catches, 1 cleanup-child catch, all fail-safe and now annotated with their reason; the two boot catches in `server.ts` now report through `DegradationReporter`, since a steward that fails to start or to ensure its topic is exactly the silent degradation the reporter exists for). CI's Docs Coverage also fell under the class floor by the two new classes; a `site` feature page and an observability cross-link cover them. Gate attempts for this follow-up: 1 commit.

## Decision-point inventory

- Level / forecast / cadence: **signals**. They decide when to clean and when to speak, and block nothing.
- Cleanup categories (npm cache, DerivedData): a **new deletion authority**, bounded by construction to two tool-owned roots with containment, busy-process and age checks. Automatic runs: off by default; on for development agents through an explicit config value. **Manual runs** (`POST /disk-steward/prune`, any Bearer caller, forwarded once to a named peer) run whatever the switch says, by design (spec §3.6): they apply exactly the automatic category rules, so a caller gains no deletion beyond those two caches. A request without `dryRun` is a real run.
- Reaper cleanliness and in-use rules: an **existing deletion authority**. The cleanliness rule is loosened only where the checkout itself corroborates it: a symlinked `node_modules`, and a `dist/` with file-by-file provenance inside one build window. Real `node_modules` folders were already kept before this change and still are. The in-use rule is tightened: inbound links, command lines, and fail-closed scans (a failed `lsof` now keeps every checkout; before, it read as an empty set).
- Local Verify sweep: an **existing deletion path, newly scheduled**. It only uses a non-forced `git worktree remove` on folders the verifier named and registered and that no process uses.

## 1. Over-block

The reaper is now more conservative in three places:
- any inbound link keeps its target checkout;
- a failed working-folder scan keeps all;
- an unreadable folder owned by this account freezes all reaping.

A real `node_modules` folder keeps its checkout as before.

That keeps worktrees that are in fact safe; the yield is honestly low today (fb-4ee99a20-35b). The Local Verify sweep keeps anything not named like a verifier run, so hand-made copies in `runs/` stay forever (reported, not removed). The cleanup skips while any npm install or Xcode build tool runs. On a machine that is always building, it may rarely run; the post still offers the manual clear.

## 2. Under-block

- A cache deletion can race a build that starts in the seconds after the last process check (declared accepted risk: a rerun).
- Links into a worktree from outside the scanned folders (another agent's home, inside a real `node_modules`) are not seen. None found on the Studio.
- Hand edits inside a Local Verify run checkout are not protected beyond git's dirtiness check (run checkouts are disposable).
- An npm subprocess that outlives a crashed child is not killed.
- Posts are at-least-once (a rare duplicate on a lease move).
- Several agents sharing one Telegram group each post the same disk fact.
- `dist/` provenance has a 15-minute window: a hand edit to a compiled output, or a hand-placed file inside `dist/data|keys|native`, made within 15 minutes of the build still counts as build output. Accepted: an edit to generated output inside the build window is vanishingly rare, and the source it maps to is merged.

## 3. Level-of-abstraction fit

A server-side monitor, not a job, because `JobScheduler` does not run on standbys (the brief's constraint). The cleanup lives in a child process, not the server, because git, du and rm must not block the event loop. The reaper and Local Verify changes sit in their own modules, where the deletion rules already live. The steward never widens either of them, and it does not call the reaper at all.

## 4. Signal vs authority compliance

Compliant. Levels and forecasts are signals feeding a fixed, deterministic deletion floor; no brittle check gates agent behaviour. The new deletion authority has an enumerable domain (two folders) and irreversible-consequence keep rules (`docs/signal-vs-authority.md`: authority is narrow and conservative; the detectors only choose timing).

## 4b. Judgment-point check

The thresholds, cadence and cleanup interval are judgment-candidates with deterministic floors and the operator as arbiter through live config (spec, Decision points touched). No competing-signals decision is reduced to a static heuristic. The floor (`max(5%, 2 GiB)`) is an external constraint imported from `AppMediaStore`.

## 5. Interactions

- **Notification gate:** warn posts use the new `disk-steward` category (quiet by default); critical posts use `attention-item` + `agent-cannot-operate` with per-machine, per-stage source contexts, which share the gate's significant budget (3 per 10 min) with other emitters. A thrown send retries with backoff; a quiet record counts as posted.
- **System-topic adoption:** the new key rides the existing loop. Its model in the self-action registry still holds.
- **Reaper:** `preparePass` runs at the start of each `reap()` and before `GET /worktrees/agent-reaper`; that route now waits for the async link walk (~90 s on Echo's home).
- **Local Verify:** the sweep runs in the run child after the bare-clone check and never fails a verify.
- **Config:** the `applyDefaults` add-missing block; the dev-agent migration runs before `applyDefaults`.

## 6. External surfaces

- New Telegram posts in a new (lazily created, or boot-created on multi-machine holders) topic. Echo uses its existing topic 140571 via `topicId`.
- New routes: `GET /disk-steward[?scope=pool]`, `POST /disk-steward/posted`, `POST /disk-steward/prune`, `GET /disk-steward/prune/:runId` (Bearer). Forwarded prune requests carry `X-Disk-Steward-Forwarded` and are never re-forwarded.
- A per-user lock file at `~/.instar/disk-steward/caches.lock`.
- A new agent-awareness section in CLAUDE.md.

## 6b. Operator-surface quality

No dashboard or approval surface is touched. The Telegram post is the operator surface. It is written in plain words, names the machine, and carries a next step on every line (tested in `tests/unit/diskStewardPoster.test.ts`).

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Samples, cadence, prune runs and the audit log: machine-local by design.** `machine-local-justification: hardware-bound-resource`. Excluded from git sync (`FileClassifier`) and registered as a machine-local write domain.
- **Posting is one-voice:** only the lease holder sends, rendering each machine's due post from numbers and acknowledging it back. Cadence stays on each machine, so a lease move loses nothing (at-least-once).
- **Topic id:** rides system-topic adoption, written by the holder.
- **Pool view:** proxied-on-read (`?scope=pool` asks each machine live; an unreachable or url-rejected machine is listed with its error).
- **Status surfaces:** `GET /disk-steward` (new). `GET /worktrees/agent-reaper` now reflects the inbound-link rule.

## 7b. Self-action convergence (unbounded-self-action)

Class `unbounded-self-action`, closure `guard`. The steward posts and cleans on its own, so it is registered in `src/testing/selfActionRegistry.ts` as `disk-steward`, an eternal sentinel: a low disk must keep being reported. The ratchet in `tests/unit/self-action-convergence.test.ts` asserts its rate floor. Steady-state bound:

- post send attempts are never closer than 15 min;
- retries back off from 15 min to 6 h;
- an unsent post is dropped after 24 h, and the next one waits a full repeat window;
- cleanup runs at most once per 6 h, and stops after three runs that each free under 1% (the breaker).

All of these brakes are persisted in the machine-local state file and restored at boot.

## 8. Rollback cost

- Watcher: `monitoring.diskSteward.enabled: false` + restart.
- Automatic cleanup: `monitoring.diskSteward.prune.enabled: false`. That does not stop the manual route; `monitoring.diskSteward.enabled: false` plus a restart (the route then returns 503) stops both. What cleanup removed is caches its tool rebuilds.
- Reaper and Local Verify changes: revert the PR. The reaper only gets more conservative or removes checkouts whose content is in main; the sweep only removed registered verifier orphans.

No data migration. A hot-fix release suffices.

## Conclusion

Ready to ship with the declared limits. The deletion surface is two tool caches plus two narrowly corroborated reaper classes. Every unknown keeps.

## Second-pass review

Required: this change touches a watchdog-like monitor and deletion paths.

Independent reviewer (subagent), first pass: Concern raised. (1) The manual route runs regardless of the cleanup switch, and this was undisclosed. (2) The real `node_modules` claim was mis-stated as new. (3) The 15-minute `dist/` window was not listed. All three were fixed in this artifact; no code change was needed.

Second pass: **Concur with the review.** It confirmed that nothing can delete outside the two cache roots, a live, linked or dirty worktree, or a folder the verifier did not create, and that no brittle check holds blocking authority. Its one wording note (the restart needed for the stop) is applied.

## Second-pass review, independent re-read (2026-11-08, Local Verify change)

Local Verify flagged `independent-review-absent` for `src/localVerify/orchestrator.ts` and `orchestratorSeams.ts`: the first trace recorded a reviewer, but the review above did not read that diff on its own. A fresh reviewer subagent read the Local Verify diff cold (code, spec §5, signal-vs-authority) before reading this artifact.

**First verdict: Concern raised.** Deletion safety held on every question asked (only verifier-named, clone-registered, not-in-use folders through a non-forced remove; an unreadable process view keeps; an unparseable kept list stops the sweep and is never overwritten; the sweep never throws into the verify; nothing assumes one machine). The concerns:

1. A `git worktree list` failure skipped the sweep silently (the one skip path with no log line). **Fixed:** logged with git's status and stderr.
2. Spec §5 promised a degradation record (`LocalVerify.keptList`) and kept entries listed with their size; the code only wrote a capped log line. **Fixed:** a `degrade` seam fired by both readers of an unparseable list, and `keptEntries: [{dir, bytes}]` through a `treeSize` seam (`du -sk`, null when unreadable). The reviewer's second pass caught the first version of this fix: the run child had configured its own DegradationReporter against the server's `degradations.json`, an unsynchronised read-modify-write the server never reads. Final design: the child only logs the event and carries it in `result.degradations`; the service hands each one to an `onDegradation` seam bound to this server's reporter, the one `/health` serves. The spec is unchanged; the code now does what it says.
3. The spec claimed `keepFailed` leaving an unparseable file untouched was tested; it was not, nor the list-failed skip, nor the lsof/ps line parsing. **Fixed:** `keepFailed` exported; 8 tests added (17 in the file).
4. `lsof` and `ps` ran once per candidate (up to 42 scans for the motivating 21 orphans). **Fixed:** one process view per sweep (10 s memo).
5. A stray file in `runs/` (a `.DS_Store`) was listed as kept every run. **Fixed:** the real `list` seam returns directories only.
6. Noted, accepted: a process holding files open inside a checkout without its working folder there, or a process on another machine sharing the volume, is not seen. Run checkouts are disposable copies under a machine-local root (spec §5 known limit).

**Second verdict:** Concern raised again, on the fix for item 2 (the run child writing the server's `degradations.json`); redesigned as described there. **Third verdict: Concur with the review** (orphanSweep 17 passed, LocalVerifyService 143 passed). Its one note, a crash result dropping collected degradations, is applied: a crash result carries them too.

