# Side-Effects Review — Load-only test flakes + test-as-self teardown (ACT-074, ACT-075, ACT-064)

**Version / slug:** `flaky-tests-and-harness`
**Date:** `2026-10-09`
**Author:** `echo`
**Second-pass reviewer:** independent reviewer subagent (see "Second-pass review" below)

## Summary of the change

Four small defects, each with a regression test that fails without the fix:

1. `JevJobCompletionAudit.flush()` (`src/scheduler/JevJobCompletionAudit.ts`) awaited only the latest detached capture. An earlier, slower capture could finish after `flush()` returned, so a batch run that followed missed that evidence pack (ACT-074, CI-only flake). `flush()` now awaits every in-flight capture, tracked in a set that each capture removes itself from when it settles.
2. Protected standards measurement (`scripts/lib/standards-enforcement-measurement.mjs`). It reads canonical `main`'s SHA from GitHub, then runs `git merge-base HEAD <sha>`. When `main` moved past the local object store (another builder merged during a long suite), `merge-base` failed and the whole measurement collapsed to `not-proven` with `enforcedRatio: null` (ACT-075). It now fetches that exact SHA from the canonical remote when the commit is missing locally, and retries one transient `ls-remote` failure.
3. `instar test-as-self` (`src/commands/test-as-self.ts`, `.claude/skills/test-as-self/scripts/verify.mjs`) (ACT-064):
   - It resolves `verify.mjs` from the module's own location (fallback: canonical home), not cwd.
   - `verify.mjs --no-lease` skips the lease/demote checks when no lifeline was started; crash detection still gates.
   - Teardown boots out and removes the throwaway's own autostart (name-guarded against the canonical agent), stops every throwaway process and waits for exit (SIGKILL after 20 s), removes the autostart again, then reaps the throwaway's tmux sessions and any process still naming the throwaway home, including the public cloudflared quick tunnel. The harness's own ancestor chain is never signalled.
4. `/threadline/relay-send` (`src/server/routes.ts`): a fingerprint-addressed send with no or unreadable `known-agents.json` now counts `fingerprintToRelay`. A per-request flag prevents double counting.

## Decision-point inventory

- `/threadline/relay-send` routing — pass-through: routing decisions are unchanged; only an observability counter is incremented on a path that already went to the relay.
- test-as-self teardown — modify: decides which processes, sessions, and autostart entries to stop. It acts only on the guard-validated throwaway target.
- Protected measurement oracle — pass-through: the measured SHA is still the canonical server's advertised `main`. Only how its objects are obtained changes.

## 1. Over-block

No block/allow surface is added. The teardown sweep selects a process only when its command line contains the throwaway home path followed by a path separator, whitespace, quote, or end of string. A sibling path such as `<target>-other` is not matched (unit-tested). The harness's ancestors (the shell or wrapper that launched it, which names the target in its own argv) are excluded. A live run showed the wrapper survives.

## 2. Under-block

- Teardown leaves the throwaway home directory on disk, as before (removal stays the caller's choice).
- A throwaway process that names the home only through its cwd (not argv) is not swept. All observed throwaway processes (server, boot wrapper, MCP children, cloudflared) carry the path in argv.
- The by-SHA fetch needs network. If GitHub is unreachable, the measurement still fails, but now honestly via `ls-remote` (after one retry). That failure path is unchanged.
- `fingerprintToRelay` is still not counted for a forwarded (standby → holder) request on the standby side. That is unchanged by design: the holder counts it.

## 3. Level-of-abstraction fit

Each fix sits in the module that owns the behaviour: the audit's own flush seam, the measurement oracle's snapshot resolver, the harness's teardown, and the existing counter sites in relay-send. No parallel mechanism is added. The teardown reuses `uninstallAutoStart`, the existing autostart remover.

## 4. Signal vs authority compliance

- [x] No new blocking authority. The counter is a signal. The measurement change only makes the existing oracle reachable. The teardown acts only on resources the harness itself created, inside a target already validated by `validateTarget` (never the canonical home, never Bob).

## 4b. Judgment-point check

No judgment point is added or changed.

## 5. Interactions

- Teardown ordering matters. A shutting-down server re-installs its autostart plist and restarts its tunnel (observed live: launchd respawned a fresh server after the first, unordered teardown). The final ordering is: remove autostart, stop and wait, remove autostart again, then reap. A second live run ended with plist, processes, and tmux sessions all at zero.
- The by-SHA fetch writes objects only: no ref and no FETCH_HEAD (`--no-write-fetch-head`). It cannot change what a later `git log`/`merge-base` against local refs sees. The shared object store across worktrees just gains objects.
- `flush()` is also the shutdown seam, so awaiting all captures makes shutdown slightly more complete. Captures are bounded by `CAPTURE_INFLIGHT_CAP`.

## 6. External surfaces

- The authed `/health` → `threadline.backupRoutes.fingerprintToRelay` now increments in two cases it previously missed. Dashboards or alerts reading that counter may see it rise.
- The measurement script may contact `github.com` one extra time (fetch) when the local clone is behind. It already contacted it (`ls-remote`).
- The harness kills processes and tmux sessions it created on the operator's machine. They are scoped to the throwaway path.

## 6b. Operator-surface quality

The harness output changes: step 6 now names failing checks instead of "Command failed", and the teardown line states what was stopped. No PIN, no dashboard.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The harness and the measurement operate on this machine's processes and git checkout. The relay-send counter is the existing per-machine in-memory counter, already pool-readable through the existing `/health` surface. No new state, notices, or URLs.

## 8. Rollback cost

Pure code revert plus a patch release. No persistent state and no migration. An object fetched into a local git store is harmless and is pruned by normal `git gc` if unreferenced.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `n/a` (negative declaration). Reason: the teardown kill is a one-shot, operator-invoked CLI teardown (`instar test-as-self`). It acts only on its own validated throwaway target, makes a single bounded pass per run (a 20 s wait), and is not a self-triggered loop. The fetch fallback is one by-SHA fetch per measurement run.

## Evidence pointers

- `tests/unit/JevJobCompletionAudit.test.ts` (ACT-074 test): fails on the old `flush()`. File run 20 rounds × 4 parallel = 80/80 green.
- Stale-clone repro for ACT-075: before the fix `not-proven / enforcedRatio null`; after, `proven / 0`, with no refs or FETCH_HEAD created. The two live tests ran 5 rounds × 4 parallel = 20/20 green.
- `tests/unit/testAsSelfTeardown.test.ts`, `tests/unit/test-as-self-verify.test.ts`: verifier resolution, `--no-lease`, process/session selectors, ancestor exclusion.
- `tests/e2e/threadline/a2a-backup-routes-alive.test.ts`: the new counter test fails without the routes change.
- Live `instar test-as-self --no-roundtrip` from a non-repo cwd: VERDICT PASS. At exit, plist=0, processes=0, tmux=0.

## Second-pass review

**Round 1 — Concern raised.** The teardown sweep trusted `validateTarget`, which refused only the exact canonical home and protected basenames. Two kinds of target got through and could reach a real agent:
- a target that is an ancestor of the canonical home (for example `--target ~/.instar`): the process sweep matches `<target>/…`, so it would hit every live agent's processes;
- a target whose basename equals a live agent's (for example `/tmp/x/echo`): the tmux reaper kills every session named `echo-*`.

The other three areas (by-SHA fetch, `flush`, the counter) were judged correct.

**Resolution.** `validateTarget` now refuses `target-is-ancestor`: the target is the filesystem root, or it contains the canonical home, a protected home, or any `~/.instar/agents/*` home. It also refuses `target-name-collides`: the target's basename matches any of those homes, case-insensitive. Because this is checked at preflight, before anything is deployed or torn down, the sweep can only ever act on a path that is neither an agent home, nor contains one, nor shares a name with one. Unit tests cover both refusals and the accepted sibling (`groky-2`).

**Round 2 — Concern raised.** The tmux reaper kills `<base>-*`, but an agent's sessions are named `<agentBase>-*`. A target such as `/tmp/echo-instar` passed the exact-name check, yet its sweep would kill Echo's `echo-instar-*` sessions. Also, a symlinked target could get past the ancestor check.

**Resolution.** The name check now refuses any overlap in either direction: `base === agentBase`, `agentBase` starting with `base + '-'`, or `base` starting with `agentBase + '-'`. The ancestor check also compares symlink-resolved paths, resolving the longest existing prefix of each path. Unit tests cover both overlap directions, a name that only shares letters (`grokyy`, accepted), and a symlinked parent of an agent home (refused).

**Round 3 — Concern raised.** A target that is a symlink TO an agent home (for example `/tmp/foo` pointing to Echo's home) passed. The ancestor check only refused parents, and the exact-home check compared unresolved paths.

**Resolution.** The guard now also refuses (`target-is-canonical`) when the symlink-resolved target equals any symlink-resolved agent home. A unit test covers it.

**Round 4 — Concur with the review.** All flagged target shapes are now refused: the filesystem root, a folder containing an agent home (including through a symlink), a symlink to an agent home, and a dash-prefix name overlap. The by-SHA fetch, `flush`, and counter findings were judged correct in round 1.
