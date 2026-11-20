# Side-Effects Review — owned-repository registry (read-only) + disk notices reach a person

**Version / slug:** `no-data-loss-repo-registry`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Increment 1 of `docs/specs/no-data-loss-on-machine-death.md` (§1.1–1.4, §1.7, the `owned-repo` kind, and §6.2). Tier 2 (converged, approved spec). On 2026-11-20 the Instar Apple and Android app sources were local-only repositories with no remote and were lost with the Mac Studio; nothing listed them.

1. **Owned-repository registry** (`src/monitoring/ownedRepos/`): every repository the agent creates or works in on a machine, found by registration at birth (a new `setRepoBirthObserver` signal on `SafeGitExecutor` after a successful `init`/`clone`), session evidence (hook-event working directories and file paths, queued, 20 drained per tick) and a budgeted scan (agent home, project-map roots, declared roots; at a repository root it asks git for untracked and ignored folders and runs a bounded descent, 60 s / 200,000 entries per tick, durable resume cursor). Each record: class (owned / candidate; another agent's home is skipped), remotes (host + account only), single-copy commits and branches (on a local branch, not reached by any off-machine remote-tracking ref), oldest age, uncommitted work. Read-only: every git call is `SafeGitExecutor.readStream` (no optional locks, no fsmonitor, read-tier source-tree opt-in for rev-parse/remote/log/status/ls-files only).
2. **`GET /repos[?scope=pool]`** (`src/server/ownedRepoRoutes.ts`): this machine, or every machine (live 5 s; else from its replicated `owned-repo` records; else named `unknown`).
3. **`owned-repo` WS2 kind** (`src/core/OwnedRepoReplicatedStore.ts`, `CoherenceJournal` tables, server registration, `stateSync.ownedRepo` forced on with the feature): disclosure-minimized replicas (buckets, no URL, no branch names, no timestamps), emitted only on a change in a replicated field, at once in the unsafe direction.
4. **Needs-you + console**: new source `repos` in `dashboard/console/needs-model.js` (one row per machine per kind: `no-remote`, `unpushed`, `unknown`; tone `bad`), new page `#/capacity/repos` that leads with the need cards (each with an "Ask the agent" link).
5. **Disk notices reach a person (§6.2)**: `NotificationSelectivityGate` gains `DEFAULT_PUSH_CATEGORIES = {disk-steward}` (pushed unless the owner explicitly set it false); `DiskStewardPoster` returns `not-delivered` (not `posted`) for a quiet hold; `DiskSteward.applyAck` treats `not-delivered` like a failure for the clock (retry on backoff, no repeat-clock reset) but without the degradation report; the `/disk-steward/posted` route accepts it, with a fallback to `failed` for an older peer; the daily quiet summary runs on any day a disk post was held quiet even with the digest off; a post made while the owner quieted disk notices carries a line saying so.

Switch: `noDataLoss.repos.enabled` (development-agent gate: live on Echo, dark on the fleet). Files: the new modules above, `server.ts` (`wireOwnedRepos`, kind registration, stateSync flag), `AgentServer.ts`, `routes.ts`, `CoherenceJournal.ts`, `ReplicatedStoreReconcilerWiring.ts`, `SafeGitExecutor.ts`, `NotificationSelectivityGate.ts`, `DiskSteward.ts`, `DiskStewardPoster.ts`, `diskSteward/wiring.ts`, `diskStewardRoutes.ts`, `needsRoutes.ts`, `CapabilityIndex.ts`, `devGatedFeatures.ts`, the console files, `state-coherence-registry.json`, `feature-ladders.json`, awareness entry `no-data-loss.md`.

Size and effort: ~24 files, ~1,500 LOC (about half tests). No extra spec rounds (the spec was already converged); one commit attempt planned. The spec's ladder line was split onto two lines (the parenthetical moved down) so the ladder-coverage test can read the id; no spec content changed.

## Decision-point inventory

- `NotificationSelectivityGate.decide` — **modify** — `disk-steward` now pushes by default (`categoryPushes`); an explicit owner `false` still records it quietly. Budgets (3 per category per 10 min, 10 global) still apply.
- `NotificationSelectivityGate.tickDigest` — **modify** — runs on a day with a quiet disk post even when the digest is off.
- `DiskSteward.applyAck` — **modify** — new `not-delivered` outcome: no clock reset, retry on the send backoff, no degradation report.
- Owned-repository defects (`defectsFor`) — **add** — a signal: a Needs-you row. It blocks nothing.
- `SafeGitExecutor` — **pass-through + signal** — a post-success observer for `init`/`clone`; it cannot change, delay or fail the git command.

---

## 1. Over-block

No block/allow surface in the registry. For the gate: a disk post that the owner never chose to quiet is now pushed; it is not blocked. Nothing previously delivered is now held.

---

## 2. Under-block

- "Off this machine" is a remote-tracking ref as last fetched; the registry never fetches. A branch deleted on the remote but still in `refs/remotes/` reads as copied. Increment 2's homing verifies with the receiver's own answer (spec §1.5).
- A commit reachable only from a detached worktree `HEAD` or a stash is not counted as single-copy in this increment; homing (increment 2) adds the recovery refs for those.
- A repository outside the agent home, the project-map roots and declared roots is found only by session evidence or registration at birth (by design: §1.3 never walks the whole home folder).
- A disk post quieted by the owner still reaches no person until the daily summary; the spec keeps the owner's explicit choice.

---

## 3. Level-of-abstraction fit

The registry is a detector feeding the existing Needs-you list (the owner-facing surface) and the replicated-record substrate; it does not build its own notification path. Git reads use the one funnel (`SafeGitExecutor.readStream`), discovery reuses the hook-event stream, and replication uses the generic `ReplicatedRecordEmitter` / `ReplicatedPeerStreamReader`. The disk fix is in the gate that already decides push-or-quiet, rather than a bypass in the poster.

---

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface (registry, routes, observer).

The registry emits Needs-you rows and records; the gate change widens delivery for one category only (an owner's explicit `false` still wins), so no brittle check gains blocking authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The grace window (24 h, 1 h at risk) and the `unknown` windows are judgment defaults within floors declared in the spec's Defaults table and `## Decision points touched` ("Disk posts exempt from quiet-by-default" is listed there with its floor and arbiter). No new static heuristic at an undeclared competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** the gate's significant-class path for a critical disk post (`diskFloorEnvelope`) is unchanged and still runs first; the routine disk post now takes `category-opt-in`-equivalent push.
- **Double-fire:** disk posts are one-voice through the lease holder (unchanged). The registry's Needs-you rows are computed from one pool read; every machine computes the same list, and a peer's answer can only carry defects about itself (filtered by machineId).
- **Races:** `tick()` is single-flight (`busy` flag). The registry state file is written atomically (tmp + rename). The scan reads git with `GIT_OPTIONAL_LOCKS=0`, so it never contends for `index.lock` with sessions working in the same checkout.
- **Feedback loops:** the registry's own state and audit log live under `.instar/` (ignored), and peer copies / drill / temp are never discovered. Session evidence from a linked worktree maps to its main repository, so a session working in a worktree does not create a second record or a second inspection.
- **SafeGitExecutor observer:** runs after a successful command; a throwing observer is swallowed. Local-verify clones, feedback-attempt clones, bare repositories and clones of a local path are not registered.
- **Older peers:** an older peer refuses `not-delivered` on `/disk-steward/posted`; the holder then acknowledges `failed` (same clock behavior).

---

## 6. External surfaces

- New owner-only route `GET /repos` (bearer). New console page `#/capacity/repos` and a Needs-you source; phones get the rows through `/mobile/needs` (owner only; team viewers never see owner sources).
- Telegram: routine disk posts that were quiet by default are now pushed to the Disk topic (bounded by the existing per-category and global push budgets). This is the intended fix (post-mortem item 11).
- Persistent state: `.instar/state/owned-repos/<machine>.json`, `logs/no-data-loss.jsonl` (16 MB × 4), and `owned-repo` journal records. All registered in the state coherence registry with retention.
- No GitHub or network calls: nothing fetches, pushes or creates a repository.
- **Operator surface:** every defect row opens the Repositories page, whose first screen is the need card with an "Ask the agent to copy it off the machine" link. No operator-facing approval or PIN action is added.

---

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: the need cards (marked `data-operator-need="repos"`) are the first content after the headline, each with its ask link; the per-machine lists are folded below (the first-screen test renders the page and checks it).
2. **Zero raw internals?** Yes: paths are shown home-relative (`~/...`), remotes as host/account; repository ids, record keys and hashes are never shown.
3. **Destructive actions de-emphasized?** There are no destructive actions on the page.
4. **Plain language + phone width?** Lines read like "No copy anywhere else (no remote) · 2 branches only here." The page reuses the console's existing card, need-card and list-section classes, which stack at phone width.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated + proxied-on-read.** Each machine's repository list is replicated as the `owned-repo` WS2 kind (state changes only, disclosure-minimized), and `GET /repos?scope=pool` reads every machine live, falling back to its replicated records, else naming it `unknown`. Machine-local by design: the scan resume cursor, candidate queue and exact counts (machine-local-justification: hardware-bound-resource — they index one disk's paths). User-facing notices: the registry emits none itself; its rows surface through the Needs-you list, which is one list read from any machine. Disk posts stay one-voice through the lease holder. No URLs are generated beyond console hash links, which are machine-independent.

**Status surfaces:** `GET /repos` (this machine) and `GET /repos?scope=pool` (whole agent; a dark machine is `unknown` or "from what it last shared"). `/capabilities` gains the `ownedRepos` entry.

---

## 8. Rollback cost

Pure code plus additive state. `noDataLoss.repos.enabled: false` stops the registry and the Needs-you source reads it as off (nothing waiting); its state file and audit log stay and are inert. Journal records already emitted are inert data on peers. The disk change reverts with the code; setting `push.categories['disk-steward']: false` restores quiet disk posts without a release.

---

## Conclusion

The review kept the design read-only and moved all git reads into the `SafeGitExecutor` read funnel (an earlier draft used a raw child process; the destructive-op lint caught it, and `worktree list` / `rev-list` / `for-each-ref` were replaced with plain file reads and `log`, so no verb outside the read-tier source-tree list is needed). Clear to ship once the second pass concurs.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concern**

Blocking:

- **Session-evidence discovery saturates and its overflow is silent** (`src/monitoring/ownedRepos/OwnedRepoRegistry.ts:183-190`, `:217-223`). `noteSessionPath` deduplicates only by exact path inside the queue. It enqueues every hook-event `file_path`, including paths inside repositories already registered. The queue holds 500 and the tick drains 20 every 15 min (80 an hour). A busy agent touches far more distinct files than that inside its own home, so on Echo the queue stays full and almost every new path counts only toward `candidateOverflow`. A repository outside the scan roots, where session evidence is the only discovery path, then depends on luck. Spec §1.3 says "overflow is reported as `unknown`", but `candidateOverflow` appears only in `status()` and never in `defectsFor`, so "unknown is never healthy" is broken silently. Small fix: drop a path at enqueue when it sits under a known `state.repos` root (a cheap prefix check), dedupe by enclosing directory, and add overflow to the `unknown` defect (or reset the counter each tick and count overflow as unknown). Add a unit test that fills the queue with paths inside the home and then checks that a new outside repository is still discovered.

Non-blocking:

- Scan-queue truncation can mark an uncovered pass "complete" (`OwnedRepoRegistry.ts:258`). `splice(0, …)` drops from the front of a LIFO queue, which is where the roots and the earliest directories sit, and records nothing. A later `done` sets `lastCompletedPassAt`. This is unlikely below 50k pending directories, but when it happens it should go to `unreadable` / `unknown` rather than vanish.
- The pool read silently leaves out a machine with no URL (`src/commands/server.ts:4726`). It builds peers from `_resolvePeerUrls`, which filters out `url == null`, so the `no-known-url` branch at `src/server/ownedRepoRoutes.ts:71` never runs. A registered machine with no admissible rope is omitted instead of being named `unknown`, which contradicts the artifact's §7 and the route comment "never silently left out". Use `_listPoolMachines` (as the /guards pool view does).
- Inspection can starve on a scan tick (`OwnedRepoRegistry.ts:203-204`). `scanStep` and `inspectDue` share one 60 s deadline and the scan runs first, so a tick that starts a new pass can spend the whole budget before anything is inspected. This fails loud (`unknown` after a day), not quiet, and the Studio's real run (22 s) shows it is fine on Echo today.
- The grace check is per repository, not per branch (`OwnedRepoRegistry.ts:338-342`, `:494-496`). `pastGrace` uses the oldest single-copy commit in the repository, so the `unpushed` count includes branches still inside their grace window. The row is still correctly one per machine per kind.
- A peer copy is left behind when a repoId changes (`OwnedRepoRegistry.ts:319`). When an empty repository gets its first commit, its repoId changes from the minted id to the root-commit id. The old key is never sent a `gone` update, so peers keep a stale duplicate until retention removes it. The `emitted` map also keeps the old key.
- The replicated `remotes[].name` is not checked for `@`, `/` or whitespace (`src/core/OwnedRepoReplicatedStore.ts:68-71`) the way host and account are. Remote names are user-chosen, so the risk is low.
- The birth observer reads `opts.cwd`, not a pre-verb `-C` (`src/core/SafeGitExecutor.ts`, `repoBirthPath`). A wrong path does no harm because `addRepo` checks that it exists. The observer runs only after success, swallows its own throw, and only adds a `close` listener on spawn, so no git command's behavior changes. It does add a synchronous `persist()` of the state file to a sync `execSync` caller's path, which costs only latency.
- Disk-gate checks pass: `categoryPushes` widens only `disk-steward`, which only `DiskStewardPoster` produces (`notificationStampers.ts:21`). An explicit owner `false` is written by `NotificationPreferences.apply` and respected. Per-category, global and significant budgets are unchanged.
- `not-delivered` is bounded, not a storm. Retries follow 15/30/60/120/240/360 min and the post is dropped at 24 h, which is about 8 quiet records per routine post when the owner has quieted disk notices (previously 1). A critical post still takes the significant path, which pushes whatever the owner chose, and stays under the 3-per-10-min significant budget. The older-peer `failed` fallback is harmless.
- With the digest off, `tickDigest` now computes `summarySince` every minute (an O(rows) scan, and `digestLast` is not advanced on quiet-free days). On a quiet-disk day it also sends a summary to an owner who turned the digest off. The spec asks for this (§6.2), but the owner-facing text should say why it came.
- Event loop and locks: every git call is an async `readStream` with `GIT_OPTIONAL_LOCKS=0` and `core.fsmonitor=false`, and worktrees are listed by reading files. Nothing takes `index.lock` in Echo's live checkout. The remaining sync work is `existsSync`/`lstatSync`, plus one `JSON.stringify` + write of the state file per tick (up to about 50k queue items and 20k known paths), which is acceptable.
- Unit tests re-run by the reviewer: owned-repo-registry, notification-disk-push-default, diskSteward, diskStewardPoster: 42/42 pass.

**Author's resolution (iteration after the concern):**

- Blocking concern fixed: `noteSessionPath` now deduplicates by enclosing directory, resolves the enclosing repository at once, and queues only a NEW root (a path inside a known repository or one of its worktrees adds nothing). An overflow records `candidateOverflowAt`, and `defectsFor` turns an overflow in the last day into the `unknown` defect. New unit test: 2,000 paths inside the home queue nothing, and a new repository outside is still found on the next tick; plus an overflow test on both sides of the one-day window.
- Scan-queue truncation now drops the newest (deepest) folders, never the roots, and a pass that dropped any is not marked complete (its roots stay unknown until a whole pass finishes).
- The pool read now also lists pool machines with no known URL (from `_listPoolMachines`), so they are named unknown or read from their records, never left out.
- A repoId change (minted → root-commit id) now sends a `gone` record for the old key.
- Replicated remote names are now checked like hosts and accounts.
- The off-digest daily summary now says why it came ("A disk space notice was held quiet today...").
- Left as is, by design: the per-repository grace check (the row stays one per machine per kind; homing in increment 2 works per branch), and the shared scan/inspect budget (fails loud as unknown, 22 s on the Studio).

**Re-check by the same reviewer: concur**

---

## Evidence pointers

- Unit: `tests/unit/owned-repo-registry.test.ts` (fixture shaped like Echo's home: `apps/instar-ios` and `apps/instar-android` found under a folded untracked `apps/`, nested repositories under untracked and ignored folders, worktree and node_modules pruning, classes, birth and session evidence, grace boundary both sides, unknown windows, replica schema and forgery refusal, birth-path parsing); `tests/unit/notification-disk-push-default.test.ts`; `tests/unit/diskSteward.test.ts` and `tests/unit/diskStewardPoster.test.ts` (quiet = not delivered; older peer fallback; owner-quiet line); `tests/unit/console-needs-first-screen.test.ts` (the Repositories page leads with the need); `tests/unit/CoherenceJournal.test.ts`, `capabilities-discoverability.test.ts`, `feature-ladders-coverage.test.ts`.
- Integration: `tests/integration/owned-repo-routes.test.ts` (503 off, 401, this machine, pool with live / replicated / unknown peers, forged peer defect dropped, Needs-you rows from the same answer).
- E2E: `tests/e2e/owned-repos-alive.test.ts` (production builder behind the real AgentServer: 200 not 503, a repository created through SafeGitExecutor registered at birth, dev-agent gate both sides).
- Full unit suite: 72,233 passed; two failures, then resolved or triaged: `no-silent-fallbacks` (the pool read's unreachable-peer catch now carries its `@silent-fallback-ok` reason; passes), and `telegram-origin/sqlite-addon-hold` (a 90 s heavy-store worker test that also fails with this change stashed under the Studio's current load; untouched by this change).
- Real run on the Mac Studio (read-only, 22 s): 4 repositories; Echo's home has 1,042 branches (2,936 commits) with no copy anywhere else, oldest 93 days, which is one `unpushed` Needs-you row; `apps/instar-ios` and `apps/instar-android` now have a GitHub remote.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `guard`
- **`guardEvidence`:** `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the only self-triggered action changed is the disk-steward post retry. A quiet hold (not-delivered) now takes the same path as a failed send, which the registered disk-steward controller already drives to its bound (send backoff 15 min to 6 h, each post dropped after 24 h, the next waiting a full repeat window). The owned-repository registry adds a fixed 15-minute read-only tick with a single-flight guard and a 60 s budget; it sends nothing and raises no notice itself. }`
