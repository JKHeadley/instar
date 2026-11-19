---
title: "The worktree reaper recognises a node_modules install that a lockfile can rebuild"
slug: "reaper-node-modules-regenerable"
author: "echo (machine stewardship, topic 144503)"
tier: 2
parent-principle: "Capacity Safety — No Unbounded Self-Action (Bounded Blast Radius)"
parent-principle-fit: "Worktrees holding a real node_modules (about 0.7 GB each, about 13 new a day on the Studio) are never reclaimed, so the agent's own disk use grows without a working bound. A content proof against a rebuilt reference lets the reaper reclaim them without losing anything."
eli16-overview: "docs/specs/reaper-node-modules-regenerable.eli16.md"
review-convergence: "2026-11-19T05:25:58.230Z"
review-iterations: 6
review-completed-at: "2026-11-19T05:25:58.230Z"
review-report: "docs/specs/reports/reaper-node-modules-regenerable-convergence.md"
cross-model-review: "ran"
approved: true
approved-by: "echo-chief-of-staff (msg 8282ada7, 2026-11-18 21:27 PT)"
---

# The worktree reaper recognises a node_modules install that a lockfile can rebuild

## Problem statement

The agent-home worktree reaper keeps any checkout with a real `node_modules` folder as `work` (`classifyIgnoredEntry`, `agentWorktreeGit.ts`): "nothing in the checkout proves it holds no hand edits". The rule is right, because a real folder could hold edits. But it also keeps every such checkout forever.

Measured on the Studio, 2026-11-18 20:55-21:05 PT:
- **How many.** 62 agent-home worktrees hold a real `node_modules`, and 281 hold a symlink. Of the 74 worktrees created in the previous 24 h, 13 hold a real one.
- **What they are.** 59 of the 62 are npm installs, carrying npm's hidden lockfile `node_modules/.package-lock.json`. One is a pnpm install, and two are other or partial folders.
- **Size.** One install is about 726 MB, 16,317 files.
- **Hashing cost.** Hashing all its files takes about 4 s when the files are warm in cache.
- **Timestamps prove nothing.** Installs from the same lockfile differ in modification time on about 16,000 files. Content is the only usable proof.
- **Content nearly matches.** Pairs of installs with the same lockfile differ in content in only 15 files: a vitest results cache, plus the compiled outputs of two native packages (`cpu-features`, `ssh2`).
- **A reference can be rebuilt offline.** `npm ci --ignore-scripts --offline` from a worktree's own `package.json` and `package-lock.json` rebuilt a matching install in 28 s from the npm cache. It differed from the worktree only in files written by dependency install scripts, about 53 MB.
- **Most script outputs are deterministic.** With dependency install scripts run, the difference fell to 15 files, 1.38 MB, all inside packages whose lockfile entry has `hasInstallScript: true` or in `.vite/`.

**These are real installs, not clones.** The agent home has no `node_modules` of its own, so `InstarWorktreeManager`'s clone source is absent and it falls back to a symlink (`InstarWorktreeManager.ts:887-903`). The real folders come from `npm ci` runs inside worktrees, which that file's own comment counts as about 0.64 GB each. Two installs from the same lockfile differ in modification time on about 16,000 files. APFS clones (`cp -cR`) keep their source's timestamps, as a clone measured here did (oldest file dated 03-13). So these are independent extractions, and each one costs its full size.

So an install can be proven rebuildable by content, apart from the files its dependencies' install scripts write.

**The creation side is a separate lever.** Stopping sessions from installing a full copy at all, by giving them the link and refusing a local `npm ci`, would remove the growth at its source. That does not reclaim the 62 that exist, so it complements this spec rather than replacing it. It is filed to the feedback queue as fb-05ffd85c-a83.

## Proposed design

### 1. Where it runs

The comparison is one function, used by both the reaper's dry-run evaluation worker and its live reclaim child (spec `reaper-removal-out-of-process`), so the dry-run report shows the same verdicts live removal would act on.

Reference builds run in a separate niced child, the **reference builder**, started by the reaper in both modes:
- at most one build per pass, and never while a reclaim run is active;
- each build has its own 6-minute timeout, killed by process group;
- a build needs free space of at least 3 GB (`statfs`) before it starts;
- builds are outside the reclaim run's 900 s deadline.

Checkouts are hashed at most `maxReapsPerPass` per pass, rotating oldest-checked first. Checkouts not yet checked are reported as `unchecked`, never as `work`.

### 2. Precondition: every link into a real `node_modules` is found

Until now, a real `node_modules` was always `work`, so nothing had to find the links into one. That changes here. On the Studio, 10 checkouts under `.instar/worktrees/` link their `node_modules` into `.worktrees/<name>/node_modules` (verified 21:10 PT). `buildInboundLinkIndex` walks only `worktreesDir`, the agent home's top level, `.worktrees-deps` and `.instar/lanes` (`agentWorktreeGit.ts:311-316`), so it misses all ten.

This change adds one check per worktree in `git -C <projectDir> worktree list --porcelain` that is not already inside an existing walk (`.worktrees/` or `.instar/lanes/`): its root `node_modules`, read with `lstat` and `readlink`. That covers `.instar/worktrees/*` and any other folder git knows. On the Studio that is 176 extra roots, about 176 system calls.

A full depth-3 walk of those roots took 44.5 s (5.2 million entries), which together with the existing walks (about 172 s) would crowd the index's 300 s limit. So the extra roots get only the root check, which covers where instar's tools make links (below). The existing walks stay as they are.

An index that times out is reported as `link-index-timeout` in the report, separately from per-checkout verdicts, because it keeps every checkout.

A walk that times out still makes the index `null`, which keeps everything (`agentWorktreeGit.ts:316`). A checkout whose `node_modules` any found link resolves into is `in-use`, exactly as today.

**Where links are made.** Instar's own tools make these links only at a checkout's root `node_modules`: `InstarWorktreeManager.maybeShareNodeModules` and the feedback executor's dependency folders. So the walk, pruned at `node_modules`, finds every link they make.

A link someone makes by hand inside another checkout's `node_modules` (for example `node_modules/pkg` pointing into a candidate) is not found. That residual is accepted. It is not made by any instar tool, and it would point into a checkout already merged and idle.

Links from outside every listed root and walked folder are not found either: `/tmp`, scratchpads, and sibling agent homes. A search of those to depth 5 on 2026-11-18 found none pointing at a candidate checkout. The only ones found were Local Verify fixtures pointing into `.worktrees/.verify/`, which is never a candidate. This is an accepted, stated residual, and a test pins it: a fixture link outside every root is documented as not protecting its target.

Measured: `git worktree list --porcelain` lists 465 roots, including 162 of the 164 `.instar/worktrees/*` folders. The two it misses have no `node_modules` link. It also lists the `echo-wt-*` homes, `.claude/worktrees/*`, `.instar/lanes/*` and `.instar/tmp/*`.

The `.worktrees/.feedback-deps/*` installs stay link targets, never candidates, because only an evaluated direct child of `worktreesDir` is ever renamed.

**Deep links found after the index.** `.worktrees-deps` and `.instar/lanes` are walked fully when the index is built. Their full walk took 13.6 s and 158 s here, too long to repeat per removal. At removal time, the child re-reads every link the index found there (one `readlink` each, about 6,800), plus the root links below. A new deep link made in those two folders after the index was built, within the same pass (at most about an hour), is an accepted residual. Links there are made when a lane or dependency folder is set up, and they point at that folder's own installs, not at an idle merged checkout.

**A fresh check at removal time.** The index is built at the start of a pass. Immediately before the rename, the reclaim child re-reads the root `node_modules` link of every worktree in a fresh `git worktree list --porcelain`, plus the existing walk roots at depth 1. That is one `lstat` and one `readlink` per worktree, about 450 on the Studio. Any link resolving into this candidate keeps it. A link created after the index therefore still keeps its target.

### 3. The reference manifest, one per key, with no install scripts

The key is the sha256 of the checkout's `package.json` and `package-lock.json`, plus npm's major version. A reference is built only for a key needed by a checkout that is otherwise eligible: clean, merged or closed by the rules, not in use, and held back only by its `node_modules`. The reference builder:
1. copies those two files into a fresh scratch folder under the reaper's state directory, and deletes the `scripts` field from the scratch `package.json`, so the root package's own scripts cannot run under any npm version;
2. runs `nice -n 10 npm ci --ignore-scripts --offline --no-audit --no-fund`. No install script of any package runs, so no package code runs and nothing is downloaded outside npm's cache. The build is aborted if the scratch folder grows past 2 GB, about 3 times the measured install;
3. hashes every file (relative path to sha256, executable bit and symlink target), writes the manifest atomically (temp file, then rename), and deletes the scratch install. On a failure, timeout or kill, the scratch folder is deleted too. A builder that starts first deletes any leftover scratch from a killed earlier build.

npm's own generated metadata, `node_modules/.package-lock.json`, is excluded from the manifest's comparison, because its bytes differ per install. It must exist, as a sign of an npm install. The checkout's copy is always archived as script residue, so a hand edit to it is kept byte for byte.

**Pinned sources, checked.** Before a build, each lockfile package entry that is installed on disk must be pinned in one of two ways:
- registry with integrity: `resolved` from `https://registry.npmjs.org/` and an `integrity` hash;
- git at a full commit, from a known host: `resolved` is `git+ssh://git@github.com/…#<40-hex commit>` or the `https` form. A git source on any other host is unsupported, because npm clones it directly even offline (pacote `lib/git.js:267-268`).

An entry that is not installed (an optional platform package for another OS, such as `sqlite-vec-linux-arm64`) is ignored. Any other installed entry is **unsupported**: `file:`, `link:`, a remote tarball URL, or git without a full commit. Its presence makes the whole checkout `work` (reason `unsupported-source`), because the scratch build could not reproduce it, and so no proof is attempted. Measured on a real lockfile: 568 of 570 entries are registry with integrity, one is a git dependency pinned to a commit (`libsignal`), and one is an uninstalled optional package.

Every other file in the manifest is an exact file from a registry package pinned by integrity.

**Why the build stays offline.** Offline, a GitHub-hosted git dependency that is not in the cache fails with `NotCachedError`, and pacote does not fall back to `git clone` (npm 11.11.0, `pacote/lib/git.js:247-261`). The registry is never contacted. Offline is therefore part of the no-code-runs guarantee, not just a speed choice.

**The inner install inherits the setting.** pacote packs a git dependency that has install-type scripts by running an inner `npm install --force` (`lib/git.js:160-193`). Its flags (`fetcher.js:104-121`) carry `--offline` but not `--ignore-scripts`. So the reference build sets `npm_config_ignore_scripts=true` and `npm_config_offline=true` in its environment as well as on the command line. The inner install inherits them, and no script of the git dependency or its dependencies runs.

The cost: after the disk steward prunes the npm cache, keys read `reference-unavailable` (reason `npm-cache-missing`) until sessions' own installs refill it. That usually happens within a day, since sessions keep running `npm ci`. Regenerating them depends on the public npm registry, as every fresh clone of the repository already does. Pruning the local npm cache does not change that. No package version this lockfile names can be republished with different bytes, because the integrity pin would refuse it.

**What stays on disk, capped (Chief of Staff condition, msg 8282ada7).** The scratch reference install (about 0.73 GB) is deleted as soon as its manifest is written, and only one exists at a time. What is kept:
- **Manifests.** Each is about 16,000 lines, about 1.5 MB.
- **A hard cap of 30 manifests.** The Studio has about 15 distinct lockfile keys among its real installs.
- **Cleanup by need.** A manifest whose key no remaining checkout uses is deleted at the next pass. When the cap is reached, the least recently used manifest whose key no checkout needs goes first. If every kept manifest is still needed, no new one is built that pass, and the checkout reads `unchecked`.

The report shows:
- the number and total size of kept manifests;
- the scratch high-water mark;
- the residue store's size.

These numbers go into the dry-run report for the turn-on decision.

**Brakes on failed builds.** If a build fails or times out, no manifest is written and every checkout with that key reads `reference-unavailable`. An offline build that fails for missing cache entries fails within seconds, so the key is retried once a day, and at once when its inputs change. Each failure's cause is reported. Other failures (timeout, build error) back off 1, 2 and 4 days and then weekly. The builder never goes online. A manifest not used for 14 days is dropped, since a rebuild costs about 30 s.

### 4. The comparison

**Classification order.** Each file under `node_modules` is first assigned to its owning package (the deepest `node_modules/<name>` or `node_modules/@scope/<name>` folder on its path), and that package's lockfile entry. Then:
1. A checkout with any installed **unsupported** entry was already kept (`unsupported-source`). A file of a **git dependency pinned to a commit** is script residue, whatever its content, so the proof never rests on a git source.
2. A file outside any package (root metadata such as `.package-lock.json`, or `.vite/` and `.cache/`) is script residue.
3. A file of a pinned package that is in the manifest must match it. The one exception is the `bin/` rule for a `hasInstallScript` package. A mismatch otherwise means `work`.
4. A file of a pinned package that is not in the manifest is script residue only if the package has `hasInstallScript: true`, and `work` otherwise.

The rest of this section states the same rules as checks.

A checkout's root `node_modules` passes (verdict `node-modules-residue`) only when every check holds:
- **It is an npm install.** `node_modules/.package-lock.json` exists; anything else (pnpm, partial) stays `work`.
- **No links out.** Every symlink inside resolves inside `node_modules` (npm's `.bin` links).
- **Nothing missing.** The checkout's file list includes every file in the manifest. A missing file could be a deliberate deletion, so it means `work`.
- **Matching files match by content.** Each file in the manifest has the same sha256 and executable bit.
- **Tarball files are unchanged.** A file that is in the manifest must match it exactly. The one exception: an executable file under a `bin/` folder of a `hasInstallScript` package, where install scripts put platform binaries. The measured case is `esbuild/bin/esbuild`. Any other changed tarball file, including in a package with install scripts, means `work`. So a debug edit to a package's JavaScript keeps the checkout.
- **Extra files are script output.** A file not in the manifest must lie inside a package whose lockfile entry has `hasInstallScript: true`, or under `node_modules/.vite/` or `node_modules/.cache/`. These, plus the `bin/` exception above, are **script residue**.

**Script residue goes to a shared, content-addressed store** (`<archiveDir>/cas/<sha256>`). Each file is copied there once by content, using PR 3480's chunked temp-then-rename copy verified by hash.

A per-checkout residue manifest records, for each path, its entry type, sha256, mode bits and, for a symlink, its literal target. The manifest is written atomically and fsynced, after every blob it names is fsynced and after every directory a new blob or the manifest was renamed into is fsynced too, so the names themselves survive a power loss. Its sha256 goes into the reclaim child's `archived <attemptId> <manifest-sha256>` row (spec `reaper-removal-out-of-process`). Only after that row is durable may the `renaming` row and the rename follow. So a crash after the rename always leaves a complete, verified residue record, even though the next run then deletes the trash. Identical bytes across checkouts are stored once: the `cloudflared` binary (about 40 MB), `esbuild` and `better-sqlite3` builds are the same in every install of one lockfile. Non-deterministic native output (the `cpu-features` and `ssh2` objects, about 1.4 MB per install) is unique, stored per checkout. Nothing is ever deleted from the store, in line with PR 3480's archive rule.

Its growth is the unique residue only. That is about 1.4 MB per checkout, plus about 50 MB per new lockfile or dependency version. The store's size is in the report. Archiving needs free space above the disk steward's floor plus the bytes to copy, or the checkout stays.

**How it fits the classify flow.** `classifyIgnoredEntry` is synchronous and runs from several places (`isClean`, `projectReclaim`, `preserveGateRecords`, `recheckResidueManifest`, around `agentWorktreeGit.ts:963`). So the comparison does not run inside it. The `node_modules` verdict is computed once per checkout per pass, by whoever evaluates that pass:
- in dry-run, the evaluation worker;
- when live, the reclaim child, which in live mode does all evaluation (spec `reaper-removal-out-of-process` §1).

Either writes the verdict, its full-tree stat signature and the pass id to a durable snapshot file (atomic, fsynced). Within the pass, `classifyIgnoredEntry` reads the memo for that checkout and pass, without re-walking. A new pass recomputes it.

**Hashing is bracketed by stats.** Each file is opened once. It is `fstat`ed, read and hashed, then `fstat`ed again through the same descriptor, and the path is `lstat`ed and must name the same inode. Any difference in size, `mtime_ns`, `ctime_ns` or inode means the checkout is `work`. The signature recorded is that verified stat. So an edit made during hashing can never pair an old hash with a new signature.

**The eligibility predicate.** The reference builder and the comparison run only for a checkout that passes `isCleanExceptRootNodeModules`. That is `isClean` with exactly one entry skipped, the root `node_modules` folder when it is a real directory. The checkout must also be merged or closed by the rules, and not in use. The predicate is named and tested, so "otherwise eligible" is not circular. `classifyIgnoredEntry` reads that memo for a root `node_modules` entry. With no memo it answers `work`, as today.

**Verdict mapping.** A real root `node_modules` that passes is never `regenerable`, because it always has residue (at least its `.package-lock.json`). It is the new class `node-modules-residue`:
- `listArchivable` expands it into its residue files and archives them like `archived-residue`. Today `listArchivable` skips `regenerable` entries (`:413`);
- `isClean` accepts it;
- every other outcome (`work`, `unchecked`, `reference-unavailable`, `residue-over-floor`) maps to `work` in `classifyIgnoredEntry`, so the checkout is kept.

### 5. The final re-check covers every file

At hash time, the comparison records `(inode, size, mtime_ns, ctime_ns)` for every entry under `node_modules`. Just before the rename to trash, the reclaim child re-lists the tree and re-`lstat`s every entry, which takes about 0.4 s. A changed or added entry means the checkout is kept, as does a removed one.

**Then, after the rename, once more** (and durably). The re-stat takes about 1.5 s, so an entry checked early could change while later ones are still being checked. After the rename, nothing new can open a file at the old path. The child then re-stats the renamed tree in trash against the same signature. This happens before the `git worktree prune` step, so git's record of the checkout is still intact. If anything differs, the child renames the folder back to its original path, provided that path is still free, writes `kept <attemptId> changed-during-removal`, and keeps the checkout. If the original path is taken, it leaves the folder in trash and reports it as `trash-held`, which is never deleted automatically. What remains is a writer that already had a file open and writes within the milliseconds after this second check, the same residual as PR 3480's.

The passed check is recorded as a fsynced `verified <attemptId>` row. Prune and the trash delete happen only after it. For an attempt on a checkout with a real `node_modules`, recovery deletes its trash folder only when the attempt has `verified`, whatever other rows it has. That covers a kill between the filesystem rename and the `renamed` row too.

On recovery, a trash folder whose attempt has `renamed` but no `verified` (a kill between the rename and the check) is not deleted. It is re-stated against the saved signature. If it matches, it gets `verified` and cleanup proceeds. If it does not, it is renamed back when its original path is free, or held as `trash-held`.

The guard's trash scope therefore also allows one restore direction: from inside the trash root back to the exact original path recorded in the attempt's `renaming` row. That path must be a direct child of `worktreesDir` that does not exist. Measured on a 19,013-entry install: the re-stat took 1.53 s cold, and deleting the folder from trash took 4.1 s.

Timestamps cannot prove that two installs match, but they reliably detect a change to one install after it was hashed. A writer that changes an entry after this final re-stat, in the few milliseconds before the rename, is the same accepted residual race as PR 3480's. The content-addressed residue is re-verified by hash, as in PR 3480. After that, the existing fresh in-use scans run, then the rename.

**Effect on the reclaim run's time.** With the re-stat, the residue copy and the trash delete, removing a checkout with a real `node_modules` takes about 10 s, against about 3 s for one without. In live mode, the child also hashes the checkout (about 4 s warm), so the total is about 14 s. The reclaim child's time-left rule uses 5 times the measured time for the kind of checkout it is about to remove: about 70 s here, 15 s otherwise. Its deadline is unchanged at 900 s. A run therefore removes fewer of these checkouts, about 4 in its removal budget. That is fail-safe, and the 62 on the Studio drain in about 16 hourly runs.

### 6. Report

Per checkout with a real `node_modules`:
- a verdict: `node-modules-residue` (passes), `work`, `unchecked`, `reference-unavailable` or `residue-over-floor`;
- its residue bytes;
- its allocated bytes (`st_blocks`), an upper bound on what removal frees. No clone sharing was found among these installs, but a shared block would be counted in both.

Totals:
- checkouts held only by their `node_modules`;
- the bytes they would free;
- the store's size.

In live mode, each removal row also records the folder's allocated blocks before the delete, and the `statfs` free-space change across it. The free-space change is labelled an estimate, since other activity on the disk moves it too.

## Decision points touched

- **Whether a real `node_modules` counts as regenerable.** — invariant. basis: irreversible-consequence; evidence: removal deletes the folder; it counts only when every file's sha256 equals a reference rebuilt offline from the same `package.json` and `package-lock.json`, or is archived residue inside a package with `hasInstallScript: true` (or in `.vite/`/`.cache/`) verified in the archive; anything else, any missing reference or any error keeps the checkout.
- **Script residue: archive or keep.** — invariant. basis: irreversible-consequence; evidence: every residue file is copied to the content-addressed store and verified by hash before removal. When the free space would fall below the disk steward's floor plus the bytes to copy, the checkout is kept (`residue-over-floor`). No fixed size cap.
- **Reference build limits (one per pass, 6-minute timeout, 3 GB free floor, daily retry, 3 failures, 14-day retention).** — judgment-candidate. Floor: a missing, failed or timed-out reference keeps every checkout with that key; a dropped manifest is rebuilt on next need. Arbiter: the reaper report's `reference-unavailable` counts and the run records. Derived from measurements: the offline install took 28 s (the timeout is about 13 times that, for a loaded machine), the install is about 0.73 GB (the floor is about 4 times that), and a rebuild is cheap (retention only bounds stale manifests). All are re-tuned at the maturation review.

## Frontloaded Decisions

- **npm installs only.** One pnpm install and two partial folders stay `work`. pnpm's store layout needs its own proof, and it is 1 of 62.
- **No install scripts run in the reference build.** The reference uses `--ignore-scripts`, and every file a script would write is archived instead, deduplicated by content. That is more disk (about 1.4 MB per checkout plus about 50 MB per dependency version), but no package code runs with the agent's access.
- **A standing mechanism, not a one-shot clean-up.** Two reasons. Sessions keep making real installs, about 13 a day, until the creation-side fix (fb-05ffd85c-a83) lands. Even then, a session that tests a dependency change needs its own install. And a one-off clean-up by hand is the kind of workaround the Chief of Staff declined for this disk problem (msg 67f2d72c). Replacing matching files in place with APFS clones of a shared copy is not done here: it edits live checkouts rather than reclaiming finished ones.
- **Removal stays decided separately.** This change adds a verdict. It removes nothing on its own: removal follows `monitoring.agentWorktreeReaper.dryRun`, which stays true until the Chief of Staff's turn-on decision.

## Multi-machine posture

`machine-local-justification: hardware-bound-resource`. Each machine reclaims its own checkouts on its own disk, using its own npm cache, so each builds its own reference manifests.

## Testing

- **Unit, comparison.** A fixture install is built from a tiny lockfile in a temp dir, with one package marked `hasInstallScript`. Cases:
  - an exact match is `node-modules-residue`;
  - one changed byte in a package without install scripts is `work`;
  - a missing file is `work`;
  - an extra file inside the scripted package, an executable changed under its `bin/`, or a file under `.vite/` is residue;
  - a changed shipped `.js` file inside the scripted package is `work`;
  - an installed `file:` dependency makes the checkout `work` (`unsupported-source`);
  - every file of a git dependency pinned to a commit is residue;
  - a symlink out of `node_modules` is `work`;
  - no `.package-lock.json` is `work`;
  - a pnpm layout is `work`.
- **Unit, residue store.**
  - The residue manifest records entry type, mode and symlink target, and a restore from it reproduces an executable and a link exactly.
  - Blobs, manifest and their directories are fsynced and the manifest digest is in the `archived` row before any rename, shown by a crash injected right after the rename: the residue restores after the next run deletes the trash.
  - Two checkouts with the same residue bytes store them once.
  - A copy is verified by hash before it counts.
  - Too little free space gives `residue-over-floor`.
  - Nothing is ever deleted from the store.
- **Unit, the final re-check.** After hashing:
  - an edit to a previously matching file keeps the checkout;
  - an added file outside the residue paths keeps it;
  - a removed file keeps it;
  - an unchanged tree passes in under 1 s for a fixture of 16,000 entries.
- **Unit, reference builder.**
  - The build runs with `--ignore-scripts` and the scratch `package.json` has no `scripts`, shown by a fixture package and a root postinstall that would each write a marker file; neither marker is written.
  - The build is aborted past 2 GB of scratch, and scratch is deleted after a failure, a timeout or a kill, and at the next build's start.
  - A key failing for missing cache entries is retried daily, other failures back off, and an input change retries at once. The cause is in the report.
  - `.package-lock.json` is excluded from the comparison but archived, and a one-byte edit to it restores byte for byte from the store.
  - A reference is built only for an otherwise-eligible checkout.
  - A failed or timed-out build writes no manifest and gives `reference-unavailable`.
  - Non-cache failures back off 1, 2 and 4 days, then weekly (per §3).
  - At most one build runs per pass, never during a reclaim run, and none below the 3 GB floor.
  - The manifest is written atomically and its key includes npm's major version.
  - A manifest unused for 14 days is dropped.
- **Unit, fresh link check at removal.** A root `node_modules` link into the candidate created after the index was built keeps the candidate.
- **Unit, hashing bracket.** A file modified between the first `fstat` and the read (injected) makes the checkout `work`. A path swapped to another inode makes it `work`.
- **Unit, pinned sources.**
  - A `file:` dependency, a remote tarball and a git branch each give `unsupported-source`.
  - An uninstalled optional entry is ignored.
  - A git dependency pinned to a commit has its files archived, not trusted.
  - An offline reference build of a fixture git dependency (served from a local cache entry) whose `prepare` and `postinstall` scripts write markers leaves no marker, because the inner install inherits `npm_config_ignore_scripts`.
  - A git source on an unknown host gives `unsupported-source`, and no clone is attempted.
- **Unit, verdict mapping.** An exact match whose only residue is an edited `.package-lock.json` is `node-modules-residue`. It is archived, its edit restores byte for byte, and `unchecked`, `reference-unavailable` and `residue-over-floor` all keep the checkout.
- **Unit, classification order.** A matching file of a git dependency is residue, not discarded.
- **Unit, widened link check.** A root `node_modules` link from a `git worktree list` root outside the walks protects its target. An index timeout is reported as `link-index-timeout`.
- **Unit, crash after rename.** A late edit followed by a kill right after the rename, both before and after the `renamed` row is written: the next run finds no `verified`, re-stats, and renames back or holds the folder. Nothing is deleted.
- **Unit, post-rename check.** A change injected after the pre-rename re-stat renames the folder back and keeps it. If the path is taken, the folder is `trash-held` and never deleted.
- **Unit, deep links.** A link recorded in the index under `.instar/lanes` whose target changed to the candidate keeps it.
- **Unit, `isCleanExceptRootNodeModules`.** Only the real root `node_modules` is skipped. Anything else untracked keeps the checkout.
- **Unit, link index.** A checkout outside `.worktrees`, registered with git, whose `node_modules` links into a candidate's real `node_modules`, makes that candidate `in-use`. A walk timeout keeps everything.
- **Unit, bin exception.** A changed executable under `<scripted package>/bin/` is residue. A changed `.js` file in the same package is `work`.
- **Unit, classify memo.** With no memo, `classifyIgnoredEntry` gives `work` for a real `node_modules`. With one, it gives the memoized verdict. A changed stat signature invalidates the memo.
- **Unit, the dry-run report.**
  - With an empty manifest cache, the first pass reports `unchecked` and starts one build.
  - A later pass reports verdicts.
  - Checkouts rotate, oldest-checked first.
- **Integration.** A throwaway agent home with a real worktree installed by `npm ci` from the shared npm cache, run through the reclaim child with live removal on the throwaway only. It checks that:
  - the worktree is reclaimed;
  - its script residue is in the store and verified;
  - the bytes freed are recorded;
  - a hand-edited file inside `node_modules` keeps the worktree.

## Maturation plan

- **test-agent-live:** the integration case above on a throwaway agent home.
- **dev-agent-live:** on Echo. The verdict and counts appear in the reaper's dry-run report, and live removal follows the Chief of Staff's turn-on decision for `reaper-removal-out-of-process`.
- **fleet:** the verdict ships with the reaper's `dryRun: true` default on every agent until the ladder review.
- **graduation criterion:** over 14 days of live dev-agent runs, every machine-checkable floor must hold:
  - zero removals of a checkout whose `node_modules` failed the content check;
  - zero residue archive verify failures that still removed;
  - `reference-unavailable` stays under 20% of checkouts with a real `node_modules`.

  Above those floors, a maturation-board judgment weighs the reports.
- **dark-window:** if live removal is not decided by 2026-12-09, the board entry records why and a new date.
- **ladder:** monitoring.agentWorktreeReaper

## Rollout

Ship with the reaper's `dryRun: true`. After install, the Studio's report shows how many real-`node_modules` checkouts would be reclaimed and the bytes freed. Those numbers go to the Chief of Staff with the turn-on ask for `reaper-removal-out-of-process`.
