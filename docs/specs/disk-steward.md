---
title: "Disk Steward — every machine watches its own free space, clears two kinds of tool cache, and warns early"
slug: "disk-steward"
author: "echo"
parent-principle: "Responsible Resource Usage; An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "disk-steward.eli16.md"
status: "converged"
approved: true
approved-by: "Echo, under its standing grant to approve non-constitution specs (memory: only-constitution-changes-need-justin), for Justin's request of 2026-11-07 15:46 in topic 134088: \"There should be a dedicated job and topic for managing disk space on every machine. We should never get to this situation.\" Approved with the convergence caveat on record (round 6 findings fixed without a seventh round)."
tier: 2
origin: "Justin 2026-11-07 15:46 (topic 134088): \"There should be a dedicated job and topic for managing disk space on every machine. We should never get to this situation.\" Incident: the Mac Studio reached 46 GiB free of 926 (95% full) and the app refused an upload at the media disk floor. Feedback fb-5c298440-0a2, fb-eb2ddd57-97e, fb-a8e711c7-af7. The numeric thresholds are Echo's (the maintainer's) recommendation in the build brief, not Justin's words."
review-convergence: "2026-11-08T01:21:03.964Z"
review-iterations: 6
review-completed-at: "2026-11-08T01:21:03.964Z"
review-report: "docs/specs/reports/disk-steward-convergence.md"
cross-model-review: "codex-cli:gpt-5.5 (via direct codex exec; script degraded: error)"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 6
---

## 1. Problem

On 2026-11-07 the Mac Studio ran down to 46 GiB free of 926 GiB and the Instar app refused a media upload (`AppMediaStore` refuses below `max(5% of total, 2 GiB)` free). Nothing had warned anyone. Measured causes that day:

- Local Verify left 21 run checkouts behind (~21 GiB): `cleanup()` runs only on a run's own completion path, so a run cut short by a restart, update or crash keeps its checkout and nothing sweeps it (fb-eb2ddd57-97e).
- The worktree reaper can never reclaim anything: since PR #2432 its cleanliness check treats ANY ignored file as unsaved work, and every checkout has `node_modules` and `dist/` (Echo: 0 reclaimable of 126). A manual pass removed 34 merged clean worktrees (~20 GiB). Another 23 (~14 GiB) were held only by an old `.session.lock` (fb-a8e711c7-af7).
- Tool caches grew unwatched (npm cache 13 GiB, Xcode DerivedData).
- The only watch (a worktree-hygiene LaunchAgent) counts directories, not bytes.

A scheduled job cannot cover every machine: `JobScheduler` skips every job (even `perMachineIndependent`) while `state.readOnly`, and is built only on the awake machine.

The 2.0 desk/preview pipeline's backup and trial retention was the largest contributor that day; it has its own owner and is raised with the hub separately, so this spec does not change it. The steward's posts name the biggest folders, so that space stays visible.

## 2. Scope

This change is deliberately small. Two review rounds kept finding new failure modes in a broad cleaner (shared-cache coordination between agents on one Mac, lock retirement races, simulator and Homebrew data that is not truly regenerable), so it ships the parts that are safe by construction:

1. **DiskSteward** — a monitor inside every agent server on every machine: measure, forecast, post plainly in a "Disk space (all machines)" topic naming the machine; and, behind its own switch, clear two tool caches (npm cache over 5 GiB, Xcode DerivedData older than 24 h) in a child process.
2. **Worktree reaper fix** — a linked `node_modules` and a root `dist/` that provably holds only build output no longer count as unsaved work, in both the cleanliness check and the archive step; a checkout that anything else links into, or that a running process uses, is kept. The reaper keeps its own switch and schedule.
3. **Local Verify sweep** — each run, before it starts, removes run checkouts that are neither its own nor a kept failed run, with a non-forced git remove only.

Explicitly not changed here:
- Worktrees held by an old `.session.lock` stay kept. The lock records the server's pid and its heartbeat is never updated, so no reader can prove the session ended. The steward reports these worktrees and their size so the operator can see them. The lock fix is tracked as fb-f564e836-6ca.
- Simulators and Homebrew are not pruned (deleting a simulator device deletes its app data; `brew cleanup` deletes old kegs a running process may use).

## 3. DiskSteward

### 3.1 Measurement (in the server, cheap)

- Every `sampleIntervalMs` (default 15 min; first sample 2 min after boot): one `fs.statfsSync(agentHome)` → `free = bavail × bsize`, `total = blocks × bsize`, and `dev = fs.statSync(agentHome).dev`. The watched volume is the one holding the agent home (worktrees, Local Verify, state, and the media store under `.instar/`).
- Steward state lives in `<stateDir>/state/disk-steward/<machineId>.json`, written atomically: samples `{ t, free, total, recovered }` for 8 days (≤ 768 rows), and the controller state — level, critical flag, episode start, last post (time, level, stage), the due post if any, repeat stage, send-failure count and next retry time, last prune time and result, breaker count. A restart restores it: a restored level is not a rise and does not post. The whole `state/disk-steward/` folder is machine-local: listed in `FileClassifier`'s git-sync exclusions and registered as a machine-local write domain, so no machine ever reads another's run or cadence state. If a state write fails (a full disk), the steward keeps the state in memory and still runs the cycle; the prune input goes to the child on its command line, so a full disk cannot stop the heal from starting.
- An unparseable state file is replaced, logged once. A statfs failure skips the tick, records a degradation (`DiskSteward.measure`), and `GET /disk-steward` shows the last reading as `unmeasured` with its age. It never posts a guess.

### 3.2 Forecast

- Floor = `max(5% of total, 2 GiB)`, using `AppMediaStore`'s rule exported as `mediaDiskFloorBytes(total)` so the two cannot disagree.
- `recovered` on each sample is the space the steward's own last prune actually gave back: `clamp(statfs free after − free before, 0, pre-measured bytes removed)`. The fit uses `adjusted = free − Σ recovered`, so a prune neither looks like recovery nor, when APFS snapshots keep the blocks, like a sudden loss.
- Two least-squares fits of `adjusted`: last 24 h (≥ 12 samples over ≥ 6 h) and last 7 d (≥ 48 samples over ≥ 48 h). Too little data is `insufficient`, never zero growth. For each usable fit with a negative slope, `daysToFloor = (free − floor) / −slope`; the forecast is the smaller.

### 3.3 Levels

- `warnBelow = min(max(15% × total, 100 GiB), 30% × total)`, `escalateBelow = min(max(10% × total, 60 GiB), 20% × total)`. On disks ≥ 334 GiB the caps do not bind (Studio: warn under 138.9 GiB, escalate under 92.6 GiB).
- `escalate` when `free < escalateBelow`, or when `free < warnBelow` and forecast `< forecastEscalateDays` (3). `warn` when `free < warnBelow`. Else `ok`. A disk above `warnBelow` is always `ok`, whatever the forecast.
- `critical` (a flag on top of the level) when `free < floor`, or `free < warnBelow` and the forecast reaches the floor in under 1 day (a disk above the warn line is never urgent on the forecast alone, so `critical` never coexists with `ok`). The first entry into `critical` in an episode (an episode lasts until the level returns to `ok`) starts a cycle at once, with the extra prune and the gap exemption. A re-entry later in the same episode follows the 2 h critical cadence, so a jittery forecast cannot fire repeatedly.
- Entering a level or `critical` takes one sample. Leaving takes two consecutive samples, each branch with its own margin: leave `warn` when free ≥ `warnBelow` + 2% of total; leave `escalate` when free ≥ `escalateBelow` + 2% of total and (forecast ≥ 3 days, insufficient, or free ≥ `warnBelow` + 2% of total); leave `critical` when free ≥ floor + 2% of total and forecast ≥ 1 day or insufficient.

### 3.4 Cycle: heal, then decide, then post

On a rise (level or `critical`), and at each repeat time (§3.5):

1. If pruning is enabled and the last prune was ≥ 6 h ago (or this is the episode's first entry into `critical`), start the prune child (§3.6) and wait for its result, bounded by its deadline.
2. Take one fresh sample. If the disk is now clear of the warn line (free ≥ `warnBelow` + 2% of total) and not `critical` by either branch (free above the floor margin and forecast ≥ 1 day or insufficient), the heal worked: log it, post nothing, and let the level leave normally.
3. Otherwise mark a post due (§3.5), reporting what was cleared and what is left.

Where pruning is off (the fleet default), step 1 is a plan-only dry run, and the post offers the cleanup.

Self-heal declaration (Standard B). `remediation-actions`: npm cache clean bound to the measured cache root; DerivedData entry removal. Both are idempotent (an absent item is a no-op) and remove only tool-owned caches, so compensation is regeneration by the tool. `max-attempts`: one prune per 6 h (one extra on entering `critical`). `max-wall-clock`: 10 min per category, 30 min per run, enforced by the server killing the child's process group. `backoff`: the 6 h prune interval; failed sends back off 15 min → 30 min → 1 h → 2 h → 4 h → 6 h. `dedupe-key`: `disk-steward:<machineId>:<episodeStart>:<stage>`. `breaker`: three consecutive prunes each freeing < 1% of total skip pruning until the level returns to `ok`, and the post says cleanup is not helping; a due post unsent after 24 h is dropped (logged) and the next cadence post replaces it. `max-notification-latency`: `45m` from the rising sample; the post is marked due then even if the child is still running. `audit-location`: `logs/disk-steward.jsonl` (metadata only). `class`: `warn` and `escalate` are `recoverable`; `critical` is `agent-cannot-operate` and notifies on the same cycle as the heal. On the fleet, where pruning is off until promoted (§7), the heal step is the dry run and the post carries the remediation (the offer to clear), because this agent holds no deletion authority there.

### 3.5 Posts

**Who sends.** Only the lease holder sends to Telegram, for every machine. Each machine keeps its own cadence and marks its own post due; it never sends. The holder's steward, every tick:
- takes its own due post, and for each active peer (`getActiveMachines()` + `resolveMeshPeerSelection`, which applies `isPeerUrlAllowedForCredentials` to each candidate before the token is sent; 5 s; a peer with no admissible URL is listed as `url-rejected` with its refusals) reads `GET /disk-steward`;
- for each due post, renders the text itself from the numbers and category names in it (fixed template; no text from another machine is ever posted), sends it, and acknowledges with `POST <peer>/disk-steward/posted { postId, outcome }` (its own posts are acknowledged in-process). The machine clears or reschedules its due post on the acknowledgement.
- A peer the holder cannot reach is skipped that tick; its due post waits on the peer, which keeps its own state, so a lease move loses nothing: the new holder picks up whatever is still due.

**Topic.** System-topic key `agent-disk-topic` (`SYSTEM_TOPIC_STATE_KEYS.diskSpace`). The holder resolves it: `monitoring.diskSteward.topicId` → recorded state → `findTopicIdByName('Disk space (all machines)')` → `findOrCreateForumTopic('Disk space (all machines)', …, { origin: 'system', bounded: true })`, and writes the result (a config id included) to the key, so standbys adopt it and a machine that later becomes holder already has it. Both holder `ensureOwn` sites in `server.ts` include it. A multi-machine holder ensures it at boot; a single-machine agent only when its first post is due. Echo's config sets `topicId: 140571`.

**When** (per machine): a rise marks a post due at once; repeat every 24 h at `warn`, 6 h at `escalate`, 2 h while `critical`; one recovery post when an episode that posted ends; nothing for a first sample at `ok`. A minimum 1 h gap between posts for one machine, except that a rise to `escalate` or `critical` is never delayed by it. While the plan's reclaimable total is under 1% of total and free space has not dropped by 2% of the disk since the last post, each repeat doubles the interval at every level: `warn` up to 7 days, `escalate` and `critical` up to 24 h. A drop of 2% of the disk since the last post resets it, and a new rise (a level, or entering `critical`) still posts at once. (Amended 2026-11-12: a fixed 2 h critical repeat posted the same text for 4 days on the Laptop and the Studio while nothing could be cleared.)

**What.**

```
Mac Studio: 82 GiB free of 926 GiB (9%), down 14 GiB in the last day. At this rate it reaches the danger line (5%) in about 3 days.
I cleared 12 GiB just now: npm cache 9, Xcode build files 3.
Finished worktrees: 1 the worktree cleaner can remove (0.4 GiB); it is switched off on Mac Studio, and I can turn it on if you ask.
Kept on purpose: 171 worktrees other checkouts link into, 23 held by old session locks (14 GiB, fix tracked), 4 test-run folders Local Verify did not make (4 GiB, tracked).
Biggest folders: .instar/lanes 151 GiB, .worktrees-deps 92 GiB (2.0 pipeline retention, raised with its owner), .worktrees 61 GiB (sized 2 h ago).
```

- Machine name: `MachineIdentity` nickname, else `name`, else hostname.
- Folder and item names that come from a machine's measurement are posted only after cleaning: characters limited to letters, digits, `.`, `-`, `_` and `/`, at most 60 characters each, at most three per line, shown in code formatting. Everything else in the text is the holder's template and numbers.
- Every line carries its next step. The offer "To clear N GiB now, reply \"clear disk on <machine>\"" appears only when the plan has reclaimable bytes in the two cache categories (on development agents the automatic run usually just took them). The worktree line names the reaper's state: on and when its next pass runs, or off and that the agent can switch it on when asked (a config change on that machine, made by the agent with its usual tools; no new route). Kept items say why and, for locks, that the fix is tracked.
- "Cleared" is the pre-measured size of the removed items; the observed statfs change is logged beside it. When `tmutil listlocalsnapshots /` lists snapshots, one line says freed space may take a while to show.
- Worktree and test-run figures come from the child (§3.7), never from a live reaper evaluation on the server.

**Envelope and outcome.**
- Warn, escalate and recovery posts: new category `disk-steward` ("Disk space"), registered in `notificationCategories`, bound to `src/monitoring/DiskStewardPoster.ts` in `EMITTER_CATEGORIES` (`src/messaging/notificationStampers.ts`). It follows the operator's push choice (quiet by default; recorded in the quiet feed until chosen). For Echo, the push choice needs a fresh operator confirmation (the category push route accepts an operator message from the last 15 minutes, or a dashboard operator session): at deploy the agent asks in the topic, and the operator's reply sets it through that route. Until then warn posts are recorded, and critical posts deliver regardless.
- `critical` posts: `attention-item` + `significantClass: 'agent-cannot-operate'`, minted by a new factory `diskFloorEnvelope(machineId, episodeStart, stage)` in `NotificationSelectivityGate.ts` (the trusted module); only `DiskStewardPoster.ts` may import it: `scripts/lint-notification-selectivity.mjs` gains a narrow exception for `diskFloorEnvelope` in that one file, like the existing `verifiedJobEnvelope` exception for the scheduler. `sourceContext` carries machine, episode and repeat stage, so machines never dedupe each other and each 2 h repeat is its own episode.
- Outcome mapping: delivered, recorded quiet, `episode-dedup`, `episode-cap` and `significant-budget` all count as posted (the gate decided; resending would not change it). Critical posts take the gate's significant path: they push unless the shared significant budget (3 per 10 min for this class) is spent; then the gate's in-memory overflow summary may report them, and if it does not (a restart, `episode-cap`), the 2 h critical repeat is the durable path. A thrown send error is a failure: retry with the backoff in §3.4.
- After a thrown send failure, a critical retry uses the next repeat stage in its `sourceContext`, because the gate reserves an episode before delivery and would otherwise answer the retry with `episode-dedup`.
- Delivery is at least once: if the holder sends and stops before acknowledging, the next holder may send the same post again. A rare duplicate is accepted over a lost warning.
- An agent without Telegram posts nothing; `GET /disk-steward` and the degradation report are its surfaces.

**Path to act.** A reply "clear disk on <machine>" is handled by the topic's session calling `POST /disk-steward/prune` (§3.8). The manual run applies exactly the automatic category rules, so a requester gains no deletion authority beyond them; the run records the requesting session and topic.

### 3.6 Prune (child process)

**Switch.** `monitoring.diskSteward.prune.enabled`, `false` by default. The development-agent dark gate (`resolveDevAgentGate` / `devGatedFeatures`) is not used, because that registry excludes features that delete files; instead the switch is classified in `DARK_GATE_EXCLUSIONS` as destructive, and the update migration writes an explicit `true` on development agents that have no value set (before `applyDefaults` runs), so the rollout is the same and the value is visible and flippable in their config. `prune.dryRun` makes automatic runs plan-only. A manual request runs on any agent.

**Process and deadline.** `node dist/monitoring/diskStewardMain.js --run-id <runId> --input-json <json>`, spawned detached (own process group) under `nice -n 10`. The server owns the deadline. Before spawning it writes `state/disk-steward/run.json` `{ runId, inputPath, deadline, resultPath }`, then adds `{ pid, pgid, startTime }` once spawned. A run is live while any member of its process group exists (`kill(-pgid, 0)`), not just its leader. At the deadline the server kills the whole group (TERM, then KILL after 10 s). At boot it reads `run.json`. A recorded group is acted on only after its identity is corroborated: some member's command line (`ps`) contains the run's unique `runId` argument. Corroborated and alive → re-armed for its deadline (killed at once if past). An intent without a pid → find a process whose command line carries that `runId` and treat its group the same way. Uncorroborated (a reused pid or pgid after a reboot) → never killed; the record is marked stale and a degradation recorded. A finished result is collected. No new run starts while a corroborated group is alive. If `run.json` cannot be written (a full disk), the child still starts; it carries its own backstop deadline (exits at twice the category budget plus 15 minutes). Known limit: if the child dies while an npm subprocess it started survives, that subprocess no longer carries the run id and is not killed; it ends on its own when npm finishes. Inside the child, removals use the async `SafeFsExecutor.safeRm` one entry at a time and check the category budget between entries; external commands run with `execFile` (no shell) and their own timeout. The child writes its audit row and result file itself, so a run is recorded even if the server restarts. One run per agent at a time (`run.json` + in-process lock).

**Automatic runs** happen only when `free < warnBelow` (never on the forecast alone), at most every 6 h (or once on entering `critical`), as step 1 of §3.4.

**Categories.** A tool not installed is `skipped: not-installed`. A failed or unreadable process list means busy, and the category skips. A cache root on a different volume from the agent home (`st_dev` differs) is `skipped: other-volume`.

1. **npm cache** — root `R = npm config get cache` (recorded). If `<R>/_cacache` exceeds `prune.npmCacheMaxGiB` (5) and no process is installing or fetching, run `npm cache clean --force --cache <R>`. Busy = a process whose argv matches `\b(npm|pnpm|yarn)(\.cmd)?\s+(install|i|ci|add|update|exec|x)\b`, `\bnpx\b` or `npm-cli\.js\s+(install|i|ci|exec|x)\b`, excluding such processes running for over 30 min (long-lived `npm exec` parents of MCP servers, which are not fetching). The process list is read twice, right before the clean as well.
2. **Xcode DerivedData** (macOS; refused when the DerivedData folder is itself a symlink) — entries named the way Xcode names them (`<Name>-<28 lowercase letters>` or `*.noindex`) directly under `~/Library/Developer/Xcode/DerivedData/` whose newest mtime (entry, `Logs/Build`, `Index.noindex`) is over 24 h old, only when none of `xcodebuild`, `XCBBuildService`, `swift-build`, `Xcode`, `SourceKitService` runs (checked before each entry). Each entry passes the child's own containment check (`lstat`: not a symlink; realpath directly under the DerivedData folder's realpath) before `SafeFsExecutor.safeRm`.

**Accepted risk, stated plainly.** Neither npm nor Xcode takes part in any lock, so a build or install that starts in the seconds between the last process check and a deletion can fail and need a rerun. Nothing authored is lost: both are caches their tool rebuilds. The checks keep this window small; they do not close it.

**Several agents on one Mac.** Both caches are per user, and the Studio runs three agents. Each run takes `~/.instar/disk-steward/caches.lock` with `O_EXCL` (`{ pid, startTime, agent, deadline }`). The lock is an efficiency measure, not a safety one: two overlapping cleans of the same caches cause only redundant work and `ENOENT`s. A lock whose holder (pid with that start time) is gone is removed and retaken with `O_EXCL`; a run that cannot take it skips both categories with `another-agent-running`.

**Never touched**: worktrees, Local Verify checkouts, agent state, the operator's files, the 2.0 pipeline folders, anything outside the two roots. The child has no code path to them.

**Audit.** One `logs/disk-steward.jsonl` row per run: trigger (auto/manual + requesting session and topic), per category `{ planned, removedItems, bytesFreed, skipped?, error? }`, statfs before/after.

### 3.7 Sizes and the plan (child, cached)

When a post is due and the cache is older than 6 h, the child also measures, under `nice -n 19` within a 10 min budget: `du -sk` of each top-level entry of the agent home except `.worktrees` (entries listed by the child itself, so the command is the same on macOS and Linux); for each `.worktrees/*` checkout, the reaper's read-only evaluation (built in the child from `makeAgentWorktreeReaperDeps` with its remove step replaced by one that throws, so the child has no path to removing a worktree) and its size, cached by path + newest mtime; and the Local Verify `runs/` entries the sweep kept, with sizes. A timed-out measurement is saved as partial and shown as "at least". Nothing is sized or evaluated on the server's event loop.

### 3.7a Whole disk by owner (child, daily)

*Added 2026-11-12.* The agent-home sizes see only this agent's folder; on the Laptop on 2026-11-11 they named about 25 GiB of 746 GiB used, while other agents' checkouts and backup folders held most of the rest. So, at most once every 24 h (whenever a run starts and the last whole-disk result is older than that), the child also measures the top level of the user's home folder (read-only). Each entry is sized with `du -k -d 1`, which prints each child as it finishes, so a walk stopped by its timeout still reports the children it summed as "at least". No entry may take more than a quarter of the time left (at least 30 s): on the Studio on 2026-11-12 a first version spent its whole budget in one agent's checkout and measured 163 of 812 GiB. The walk takes up to 15 min and always ends 2 min before the server's kill deadline for the run (`runDeadlineAt` in the child input), so the run's result is never lost to the walk.
- **Owners.** Agents come from the machine's registry (`~/.instar/registry.json`, absolute paths only; `*-lifeline` entries are not separate owners). A home folder with an agent somewhere below it is opened one more level (at most three below home, so `~/.instar/agents/<name>` and `~/Projects/<name>` are reached); a folder that is or holds an agent belongs to that agent, and any other folder to its top-level home folder (`~/Projects`, `~/dawn-backups`). Links and folders on another volume are skipped.
- **Never opened, on macOS:** `Documents`, `Desktop`, `Downloads`, `Library`, `Pictures`, `Movies`, `Music` and `.Trash`. Their access belongs to the privacy system and is granted to the agents' shared process tree; reading them can raise a prompt or disturb that grant (see the TCC-protected path standard). Their bytes, the system's and any other user's are reported as `notOpenedBytes` = used − measured, so the line still adds up. On Linux nothing is excluded.
- **Result.** `{ at, partial, usedBytes, measuredBytes, notOpenedBytes, owners[≤8]: { owner, agent, bytes, paths[≤3] }, unfinished? }`, kept in state, served as `wholeDisk` on `GET /disk-steward` (null until the first run) and carried in the due post. A spent budget or an unreadable folder makes it partial and is listed in `unfinished` (home-relative, at most 5); for this agent's own folder the sizes measured in the same run (§3.7) stand in as a floor. Uncounted bytes fall into `notOpenedBytes`, and the post names the unfinished folders rather than calling them unopened (live run on the Studio, 2026-11-12: one agent's 105 GiB of installed packages could not be walked in its share of the time).
- **Post line.** "Whole disk, 746 GiB used: agent sagemind 79 GiB, `~/Projects` 62 GiB, …; 300 GiB is in folders I don't open (personal files, app data, the system) (measured 5 h ago)." Up to five owners; names pass `cleanName`; a malformed peer value renders no line.
- Nothing in this step deletes or writes anything. Acting on it (asking an owner to prune) stays with the agent and the operator.

### 3.8 Routes

- `GET /disk-steward` — `{ machine, level, critical, measured, freeBytes, totalBytes, thresholds, forecast, duePost, lastPost, prune: { enabled, dryRun, lastRun, running }, plan, sizes }`. `?scope=pool` adds `peers[]`, each peer's own answer fetched live (same checks as the holder's read); an unreachable peer is listed with its error. 503 when disabled.
- `POST /disk-steward/posted { postId, outcome }` — the holder's acknowledgement; 409 when the id is not this machine's current due post.
- `POST /disk-steward/prune` — `{ machineId?, dryRun?, post? }` → `202 { runId }`; `GET /disk-steward/prune/:runId` → the record. Another machine's id → forwarded once (after `isPeerUrlAllowedForCredentials`) with `machineId` kept and `X-Disk-Steward-Forwarded: 1`; a forwarded request runs only if `machineId` is the receiver's own id (else 409) and is never forwarded again. Unknown id → 404 with the known ids. A run in progress → 409 with its `runId`. A manual run marks a summary post due; a dry run only with `post: true`.
- Bearer-authenticated like every route.

### 3.9 Config

```json
"monitoring": { "diskSteward": {
  "enabled": true, "sampleIntervalMs": 900000, "topicId": null,
  "warnPercent": 15, "warnMinGiB": 100, "escalatePercent": 10, "escalateMinGiB": 60,
  "forecastEscalateDays": 3,
  "prune": { "dryRun": false, "minIntervalMs": 21600000, "npmCacheMaxGiB": 5 }
} }
```

Defaults land through `ConfigDefaults.ts` / `applyDefaults`, which `PostUpdateMigrator` runs for every agent, so existing agents get the block on update without overwriting set values. `prune.enabled` defaults to `false`; the migration writes `true` on development agents (see §3.6).

## 4. Worktree reaper fix

In `src/monitoring/agentWorktreeGit.ts`, one shared classifier `classifyIgnoredEntry(relPath, checkout)` used by both `isClean()` and `preserveGateRecords()`. Entries come from `ls-files --others --ignored --exclude-standard --directory`, which lists a folder once when all of it is ignored and file by file otherwise; the rules below apply by first path segment.

- `gate-record` — the existing rule; archived before removal.
- `regenerable`:
  - a `node_modules` **symlink** at any depth (`lstat`). `git worktree remove` removes it as a link and never follows it. A real `node_modules` **directory** stays `work`: nothing in the checkout proves it holds no hand edits.
  - root `dist` only when its every file maps back to compiled source, and all of them (including the build-script folders) fall inside one build window of 15 minutes, so an output edited by hand after the build keeps the checkout: the checkout's own `tsconfig.json` builds `rootDir` into `outDir: dist`, and each file is a compiler output (`x.js`, `x.d.ts`, their `.map`s, or the `.mjs`/`.cjs` forms) of a source file present in `rootDir`, or lives in one of the folders the repo's `build` script writes (`dist/data`, `dist/keys`, `dist/native`). Any other file (a hand-placed `dist/hotfix.js` or `dist/notes.txt`) means `work`. Measured on a real Studio worktree: all 9,293 files map. A root `dist` symlink is removed as a link.
  - there is no rule for `coverage/` (no Echo worktree has one), so it stays `work`.
- anything else — `work`: the checkout stays dirty, as today (a hand-made `notes/dist/` included).

`isInUse()` also keeps a checkout that anything else links into. Before each pass (and before each `GET /worktrees/agent-reaper` read), the reaper's new async `preparePass` walks, without blocking the event loop, each checkout's top levels (not inside `node_modules`), the agent home's top level, `.worktrees-deps/` and `.instar/lanes/` for symlinks, and resolves each one lexically (so a link whose target is itself a link counts: worktrees chain their `node_modules` through each other) and by realpath. Any checkout a link from outside it points into is in use. A folder this account owns but cannot read, or a walk that runs out of time (5 min), leaves the index unknown, and an unknown or not-yet-built index keeps every checkout. A folder owned by another account that this account cannot read is skipped and listed (no process running as this account can use links inside it). Measured on Echo: the walk takes about 90 s and finds 171 linked-into checkouts.

`isInUse()` also treats as in use any checkout appearing in a running process's command line (`ps -axww -o command=`, matched at token boundaries — absolute, realpath, or a `.worktrees/<slug>` token with any prefix such as a relative path or `~` — so `.worktrees/foo` never matches `.worktrees/foo-bar`), and any checkout when the working-folder scan (`lsof`) cannot run, so a server or test agent started as `node <checkout>/dist/...` from elsewhere keeps its checkout. A failed process scan means in use. `preserveGateRecords()` skips `regenerable` entries instead of throwing on them. Untracked files (including `.session.lock`) keep their current treatment. `REAPER_RESIDUE_DENYLIST` stays empty. The reaper's switch, schedule and per-pass cap are unchanged. Each pass builds its own link index (last-started wins, so an older walk finishing late never replaces a newer one).

**Expected yield, measured honestly.** On Echo's Studio (127 registered worktrees, 2026-11-07), most checkouts also carry other ignored leftovers this change does not classify — `.husky/_/`, generated `src/data/*` files, `.instar/audit/` logs, `.vitest/`, `logs/`, `data/` — and 50 have a real `node_modules` folder, so the reaper becomes able to remove only a handful today (the round-6 review counted 1 fully eligible). The change makes the rule correct and safe; the remaining leftover classes, each needing its own corroboration, are tracked as fb-4ee99a20-35b. Most of the steward's own reclaim on the Studio comes from the npm cache and DerivedData.

**Known limits of the link scan.** It walks this agent's worktrees, its home's top level, `.worktrees-deps/` and `.instar/lanes/`. A link into a checkout from anywhere else (another agent's home, a deeper folder inside a real `node_modules`) is not seen. On the Studio the round-6 review found none.

## 5. Local Verify sweep

New `sweepOrphanVerifyRuns(seams, p)` in `src/localVerify/orchestrator.ts`, called at the start of every run after the bare clone has been checked or re-made, inside the run child that `LocalVerifyService` has already serialized (one run in flight; a previous boot's run group is killed before a new run starts):

- For each entry of `p.runsDir` other than `p.runDir`: keep it if its literal path or its realpath matches the literal path or realpath of any `kept-failed.json` entry. Consider only entries the verifier made: a 12-hex run-id name AND registered in its bare clone (`git worktree list --porcelain`). Anything else in `runs/` (a hand-made copy, an entry orphaned by a re-made clone) is kept and listed. Also keep any entry a running process uses (its working folder inside it, via `lsof`, or its command line naming it, via `ps`); an unreadable process view keeps everything.
- Otherwise run `git worktree remove <dir>` (non-forced) through the existing seam, then `git worktree prune`. If git refuses (dirty, locked, initializing, or not registered after a re-made clone), keep the entry and list it with its size. Entries orphaned by a re-made clone are therefore kept for good and only reported; re-making the clone is rare (a crash mid-init). The recursive-delete fallback of the run's own `removeWorktree()` is not used here.
- The non-forced remove keeps any checkout git considers dirty; the name, registration and in-use checks keep anything the verifier did not make or that is open.
- While `kept-failed.json` exists and cannot be parsed, the sweep removes nothing and records a degradation (`LocalVerify.keptList`); `keepFailed()` leaves the unparseable file untouched instead of overwriting it. Sweeping resumes only once the file parses again (repaired or removed by hand). A failed run kept while the list was unreadable is kept but not listed, so once the list is repaired the next sweep can remove it: that run's diagnosis material is lost (test output only), and the log line written at the time names it.
- Log `{ removed[], kept[] }`; a failure never fails the verify. `.verify/diagnosis/` is not touched.
- Known limit: a file someone edits by hand inside a Local Verify run checkout is not protected beyond git's own dirtiness check (ignored files go with the checkout). Run checkouts are disposable test copies made by the verifier, not workspaces.

## 6. Agent awareness and migration

- CLAUDE.md template (`generateClaudeMd()`), with an idempotent `migrateClaudeMd()` addition guarded by content sniffing, and the reference docs: a "Disk Steward" entry with `GET /disk-steward[?scope=pool]`, and the trigger "someone asks about disk space, or replies 'clear disk on <machine>' in the Disk space topic → resolve the machine id from `GET /disk-steward?scope=pool`, call `POST /disk-steward/prune`, then report what was freed"; and "the operator asks to turn on the worktree cleaner on a machine → set `monitoring.agentWorktreeReaper` to `{ enabled: true, dryRun: false }` in that machine's config, restart it, and report its first pass". A Registry First row: "How full is each machine's disk?" → `GET /disk-steward?scope=pool`.
- The steward's prune, post and retry loops are registered in `SELF_ACTION_CONTROLLERS` (`src/testing/selfActionRegistry.ts`) with a class-closure declaration, and a convergence test bounds them under sustained pressure with the controller rebuilt from its state file mid-run.
- Capabilities and guard registry: `monitoring.diskSteward.enabled` and `monitoring.diskSteward.prune.enabled`. `prune.enabled` is listed in `DARK_GATE_EXCLUSIONS` (category destructive: it deletes the npm cache and Xcode build files).
- Mixed versions: the holder renders and sends every post itself, so a standby on a newer version than the holder simply waits until the holder has the steward; an older holder never reads `duePost`.

## Maturation plan

The watcher and posts (`monitoring.diskSteward.enabled`) ship on for every agent; they only measure and speak. The ladder below is for the deletion part, `monitoring.diskSteward.prune`.

- **test-agent-live:** the e2e test boots a throwaway agent whose HOME holds a fake npm cache over the limit and Xcode DerivedData entries (old, fresh, odd-named, symlinked), runs a real prune child, and checks only the old, Xcode-named entries and the npm cache were removed, the audit row and result were written, and a post was rendered.
- **dev-agent-live:** on for development agents through an explicit config value the update migration writes; Echo's Studio first, live, watched through `logs/disk-steward.jsonl` and the `fired`/`error` evidence rows.
- **fleet:** stays off on the fleet; a later spec flips the default once the graduation criterion holds.
- **graduation criterion:** 14 days of development-agent prune rows with at least 7 runs, zero prune errors, and zero safety-invariant violations (no removal outside the two roots, no removal while a build tool ran, checked from the audit rows).
- **dark-window:** at most 28 days from merge to the fleet decision; if the criterion is not met by then, the reason and a new date are recorded on the tracking item, never left dark silently.
- **ladder:** monitoring.diskSteward.prune

## Decision points touched

- Critical state (below the floor, or forecast to it under 1 day) — invariant; basis: external-constraint; evidence: at the floor AppMediaStore refuses uploads, so the agent stops working; it posts at once on the gate's significant path (pushed, or summarized when the shared significant budget is spent).
- Danger floor `max(5% of total, 2 GiB)` — invariant; basis: external-constraint; evidence: AppMediaStore.belowDiskFloor refuses uploads below it, and the steward imports that rule.
- Warn / escalate thresholds (15% or 100 GiB, 10% or 60 GiB, capped at 30% / 20%) — judgment-candidate: floor = the danger floor, which always produces a delivered post; arbiter = the operator through live config; the numbers only choose when to clean and speak, never what may be deleted.
- Forecast escalation (under 3 days, only below the warn line) — judgment-candidate: floor = it never starts a prune and never alerts a disk above the warn line; arbiter = the reader, who sees the growth numbers.
- Post cadence, gap and backoff — judgment-candidate: floor = a rise always marks a post due within 45 min and a critical post is never delayed; arbiter = the operator, who can read GET /disk-steward or ask in the topic.
- Hysteresis (two samples, 2% margin on the whole predicate) — judgment-candidate: floor = entering a level takes one sample, so a real drop is never delayed; arbiter = the cadence above.
- Auto-prune trigger (below the warn line only, every 6 h at most, breaker after three runs freeing under 1%) — judgment-candidate: floor = never on an ok disk or on the forecast alone, bounded by the per-category budgets; arbiter = the operator through the switch and the manual route.
- Prune categories (npm cache, DerivedData, nothing else) — invariant; basis: enumerable-domain; evidence: two tool-owned caches each regenerated by its tool (npm registry, Xcode build); any other path has no code path to deletion in the child.
- Category keep rules (busy or unreadable process list skips; DerivedData under 24 h kept; npm bound to the measured root; DerivedData realpath must stay under its folder) — invariant; basis: irreversible-consequence; evidence: deleting under a running build or outside the measured root cannot be undone.
- Manual prune by any authenticated session — judgment-candidate: floor = the manual run applies exactly the automatic category rules; arbiter = the operator, whose reply the session acts on, recorded in the audit row.
- Shared-cache lock across agents — judgment-candidate: floor = an overlap causes only redundant work, never extra deletion, since both runs apply the same rules to the same caches; arbiter = none needed beyond the lock's efficiency role.
- Prune switch default (off for everyone; the migration writes an explicit on for development agents) — judgment-candidate: floor = fleet agents still get every post and the manual offer; arbiter = the operator through the switch; promotion follows the Maturation plan on machine-checkable audit evidence.
- Reaper regenerable classes and keeps (node_modules symlinks only; root dist only when every file maps back to compiled source; any checkout linked into from outside it, or named in a running command line, kept; an unknown link index keeps all) — invariant; basis: irreversible-consequence; evidence: each class is corroborated by the checkout's own files rather than its name, and every unknown case, every real node_modules directory and every in-use checkout is kept.
- Local Verify sweep (non-forced git remove only, literal and realpath kept list, an unparseable list stops all sweeping) — invariant; basis: irreversible-consequence; evidence: git refuses to remove a dirty or locked checkout, so an edited former run is kept.
- Pool view (an unreachable peer is shown with its error) — invariant; basis: enumerable-domain; evidence: a live read either answered or did not; nothing is cached to age.

## Frontloaded Decisions

- Warnings on for every agent. On the fleet, warn and escalate posts follow the operator's push choice for the new "Disk space" category (quiet by default); critical posts deliver everywhere.
- A cache deletion racing a just-started build is an accepted risk (a rerun, never lost work).
- Multi-machine agents get the topic at boot; single-machine agents only on their first post. Echo uses topic 140571.
- Thresholds capped at 30% / 20% of total on small disks.
- The steward is a server-side monitor; standbys never send, the holder sends for them.
- Pruning covers npm cache and DerivedData only; worktrees stay with the reaper's own switch; old-lock worktrees and simulators/Homebrew are reported or left alone.
- The path to act is a reply in the topic, carried out by the topic's session; posts are delivered at least once.
- The manual route works on agents whose automatic switch is off.
- The 2.0 desk/preview pipeline's retention is not changed here.

## Open questions

*(none)*

## Multi-machine posture

- Samples, controller state, the prune and its audit describe one physical disk.
  machine-local-justification: hardware-bound-resource — free space, growth and the tool caches exist only on the disk they describe; replicating them would describe the wrong disk.
- Posting is one-voice: only the lease holder sends, rendering each machine's due post from its numbers and acknowledging it back; cadence state stays on each machine, so a lease move loses nothing. The topic id rides system-topic adoption, written by the holder (config id included).
- The pool view is proxied-on-read (`GET /disk-steward?scope=pool` asks each active machine live).
- A prune for another machine is forwarded once to that machine, which runs it.

## Testing

- Unit: thresholds with caps and the imported floor; fits (insufficient, flat, shrinking, sharp drop, a leak across a prune using observed recovery); per-branch hysteresis, including escalate clearing above the warn line with a stale steep forecast; `critical` entry starts a cycle at once; restart restores level without a post; cycle (heal to clear posts nothing, still low marks a post due, 45 min backstop); cadence, escalate/critical exempt from the gap, backoff; holder pull (own and peer due posts rendered from numbers, acknowledgement clears, unreachable peer waits, outcome mapping incl. episode-dedup); child: npm busy predicate (install/exec match, long-lived MCP npm exec excluded, second read), npm bound to the root, other-volume skip, DerivedData age, containment and symlink refusal, async removal checks the budget between entries; server kills the group at the deadline and re-arms after restart; caches lock (take, busy, stale holder); reaper classifier (dist mapped file by file, a hand-placed dist file keeps, nested dist keeps, node_modules symlink target survives, a real node_modules directory stays work at any depth, a nested node_modules symlink is regenerable, coverage keeps, unknown ignored stays dirty, a checkout named in a running command line is in use, inbound-link index incl. a chained link and a pipeline link, an own unreadable folder makes the index unknown, gate records still archived); Local Verify sweep (own run kept, non-run-id names and unregistered entries kept, a busy or unreadable process view keeps, kept-failed by realpath and literal path, an unparseable list stops all sweeping and keepFailed leaves it untouched, git refusal keeps and lists, no recursive fallback).
- Integration: routes over HTTP (503 disabled, 202 + record, 409 while running, posted acknowledgement 409 on a wrong id, pool with an unreachable peer, forward header stops re-forwarding); envelopes (disk-steward via DiskStewardPoster; critical via diskFloorEnvelope with per-machine, per-stage sourceContext).
- E2E: production init builds the steward; `GET /disk-steward` returns 200 with a real reading; the test-agent rung of §7.
- Named safety invariants: the child never deletes outside the two roots; the reaper keeps a checkout with any unknown ignored file or a real node_modules directory, and never touches a symlinked node_modules target; the Local Verify sweep never removes a kept failed run or a run git considers dirty.
- Tests run a few files at a time (the Studio is short on disk and busy); Local Verify runs the full suites.

## Rollback

- Warnings: `monitoring.diskSteward.enabled: false` and restart. Sent posts stay in Telegram; the state file and audit log can be deleted.
- Pruning: `prune.enabled: false`. What it removed is regenerated by npm and Xcode on next use.
- Reaper and Local Verify changes: revert the PR. Removed worktrees had their content in main; removed verify checkouts were orphans git agreed were clean.

## Acceptance

- On Echo's Studio after deploy: `GET /disk-steward` shows a real reading and topic 140571; `GET /worktrees/agent-reaper` shows a non-zero reclaimable count (0 of 126 before).
- The Studio is under its warn line now (about 104 GiB free), so the first cycle runs a prune and then posts in topic 140571, delivered (not only recorded), naming the machine.
- After the first Local Verify run on the new code, `.worktrees/.verify/runs/` holds only the current run, kept failed runs and entries git refused (listed with sizes).
