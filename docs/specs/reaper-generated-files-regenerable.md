---
title: "The worktree reaper archives the repo's own generated files instead of keeping the whole checkout"
slug: "reaper-generated-files-regenerable"
author: "echo (machine stewardship, topic 144503)"
tier: 2
parent-principle: "Capacity Safety — No Unbounded Self-Action (Bounded Blast Radius)"
parent-principle-fit: "The agent-home worktree reaper (docs/specs/agent-worktree-reaper.md) exists to reclaim stale checkouts, but on the Studio it can reclaim almost none: 151 of the 210 worktrees it keeps as 'uncommitted changes' are clean by git status and are held only by files the repo's own build and lint steps generate. The agent home gains about 86 worktrees a day, and the Studio lost about 4 GB/h of free space on 2026-11-18."
eli16-overview: "docs/specs/reaper-generated-files-regenerable.eli16.md"
review-convergence: "2026-11-19T03:02:07.616Z"
review-iterations: 4
review-completed-at: "2026-11-19T03:02:07.616Z"
review-report: "docs/specs/reports/reaper-generated-files-regenerable-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# The worktree reaper recognises the repo's own generated files

## Problem statement

`AgentWorktreeReaper` keeps a worktree when `isClean` is false (`src/monitoring/agentWorktreeGit.ts:584-596`). `isClean` counts every tracked change, every untracked file and every git-ignored file as work. The one exception is the classes in `classifyIgnoredEntry` (line 127):
- the commit gate's own records;
- a symlinked `node_modules`;
- a root `dist/` that `distIsBuildOutput` proves came from the checkout's own build.

That rule was set by `worktree-reaper-untracked-blindspot` and it is right: an ignored file can hold unique bytes.

Measured on the Studio, 2026-11-18 18:20 PT (`GET /worktrees/agent-reaper`, 278 of 444 worktrees evaluated, about 174 GB apparent):

| verdict reason | count |
|---|---|
| uncommitted-changes | 210 |
| in-use | 37 |
| detached-or-unknown-branch | 25 |
| unmerged | 5 |
| merged-clean-idle (reap-eligible) | 1 |

A plain `git status --porcelain` on the 210 found:
- 151 with no tracked or untracked change;
- 21 with changes only under `.instar`;
- 38 with real changes.

In a sample of 40 of the clean ones, the ignored entries that keep each one were these, with how many of the 40 contain each:
- `src/data/standards-registry.md`, `src/data/standards-registry.meta.json`, `src/data/standards-guard-index.json` and `src/data/standards-guard-index.meta.json`, written by `scripts/generate-standards-registry-asset.mjs` in `npm run build` (32);
- `.husky/_/`, written by husky 9's install in `npm run prepare` (30);
- `.instar/standards-coverage.json`, written by `scripts/standards-coverage.mjs` (30);
- `.instar/audit/` (32), the per-checkout `destructive-ops.jsonl` and `credential-resolution.jsonl` audit trails that SafeGitExecutor and SafeFsExecutor append to;
- `.instar/dup-build-cache.json`, written by `scripts/lib/duplicate-build-check.mjs` (6);
- `logs/` (6) and `src/data/builtin-manifest.json` (2).

The audit trails are not build output, so they are not treated like the others (see "Audit trails" below).

## Proposed design

Two treatments, chosen per file by what can actually be proven. A file is `regenerable` only when its whole content provably exists in a commit. In this change, that is only the registry copy. Every other listed file is archived byte for byte before a checkout is removed, which is the path gate records already take (`preserveGateRecords`, `agentWorktreeGit.ts:261-303`). Nothing unique can be lost either way.

### 1. Proven regenerable (no archive)

- **`src/data/standards-registry.md`** when its git blob hash (`git hash-object --no-filters`) equals `git rev-parse HEAD:docs/STANDARDS-REGISTRY.md`. The generator writes a verbatim byte copy (`scripts/generate-standards-registry-asset.mjs`), so a match proves the exact bytes are in a commit. That holds whoever calls the classifier and whatever index flags are set. Measured on the Studio: 240 of 245 copies are byte-equal to their tracked source. The rest stay `work`.

### 2. Archived residue (copied and verified before removal)

A closed list. Each entry is named in code with the step that writes it:
- `src/data/standards-registry.meta.json`, `src/data/standards-guard-index.json` and `src/data/standards-guard-index.meta.json` (`scripts/generate-standards-registry-asset.mjs`);
- `src/data/builtin-manifest.json` (`scripts/generate-builtin-manifest.cjs`);
- `.instar/standards-coverage.json` (`scripts/standards-coverage.mjs`), `.instar/dup-build-cache.json` (`scripts/lib/duplicate-build-check.mjs`), `.instar/docs-coverage.json` and `.instar/docs-coverage.md` (`scripts/docs-coverage.mjs`);
- the children of `.husky/_/` (husky's install, in `npm run prepare`: hook stubs, `h`, `husky.sh`, `.gitignore`; about 1 KB each). They are archived, not proven, so the rule does not depend on the husky version;
- the children of `.instar/audit/` named `<name>.jsonl` or `<name>.jsonl.1`. These are the per-checkout audit trails that SafeGitExecutor and SafeFsExecutor append to when their process's working folder is that checkout (`SafeGitExecutor.ts:1014-1021`).

Each entry must be a regular file, never a symlink. `isClean` treats `archived-residue` like `gate-record`: it does not make the checkout dirty.

### 3. Folder entries

`git ls-files --others --ignored --directory` reports a wholly ignored folder as a single entry (`ignoredArgs`, `agentWorktreeGit.ts:253`). A listed folder (`.husky/_/`, `.instar/audit/`) is therefore read exactly one level deep:
- the folder itself must not be a symlink;
- every child must be a regular file that meets its rule above;
- any other child (a subfolder, a link, a name not on the rule) makes the whole folder `work`.

The archive step copies the children. `preserveGateRecords`, which today accepts only `gate-record` and `regenerable` (line 276), also accepts `archived-residue`.

### 4. The archive step

The archive is the existing `<agent home>/.instar/instar-dev-decisions-archive/<worktree>/`, using the existing collision handling: identical bytes are overwritten, different bytes get a hash suffix (lines 288-290). Changes:
- the copy streams in bounded memory to a temporary name in the archive folder. The source hash is taken from the same read that writes it. The copy is then hashed, compared, and renamed into place. A failed or mismatched copy is unlinked, so no partial file is left looking archived;
- **final re-check before removal:** immediately before `git worktree remove`, the reaper re-lists the checkout's full residue (the same enumeration and classification as before), re-hashes every file, and then reads the process lists fresh. That means calling `cwdRootsFn()` and `commandLinesFn()` directly (`agentWorktreeGit.ts:472, 483`) rather than `isInUse`, whose scans are memoized for 10 s (473-479, 492-498). The re-check sits between `preserveGateRecords` and the `worktree remove` call in `removeWorktree` (646-655). A throw there keeps the checkout through the reaper's existing failure path (`AgentWorktreeReaper.ts:356-366`). The checkout is kept if any of these hold: the new manifest differs from the archived one in any way (a file added, removed, renamed, replaced or changed type); any file changed size or hash since its copy; or any process now has the checkout as its working folder. A file then holds bytes the archive does not. This closes the window between archive and removal down to the same instant the existing gate-record path already accepts. It is also why the gate-record unlinks run before the residue archive, not after;
- before archiving a checkout, the reaper checks (`statfs`) that the archive's volume has more free space than the residue's size. This is the physical limit: the copy must fit. Removal then frees far more than the copy uses (a few hundred MB against about 1.6 MB). If the copy would not fit, the checkout is kept. This check runs only in the archive step, never in classification, so the dry-run count does not move with free space;
- any copy or verify failure keeps the checkout, as today.

Removal does not write into the target's audit trail. The reaper's executors log to their own process's working folder, the agent home, not to the checkout being removed (`SafeGitExecutor.ts:1014-1021`). If `INSTAR_AUDIT_LOG_DIR` is set and points inside the checkout being removed, the checkout is kept. A writer present at the final re-check is caught by it. A process outside the checkout that writes into it in the instant between the re-check and `git worktree remove` is not caught. That residual is accepted (see below).

### 5. Archive growth

The archive is never pruned by this change, in line with "Archiving May Never Mean Deleting". Measured on the Studio across all 444 current worktrees (2026-11-18):
- the archived-residue files total about 71 MB of generated files plus 635 MB of audit trails;
- the largest audit file is 16.8 MB;
- that is about 1.6 MB per worktree. The eligible worktrees have a symlinked `node_modules`, so each frees a few hundred MB by apparent size (`du`). That is still more than a hundred times the residue it archives. The real reclaim is measured with `df` before and after, and reported that way to the Chief of Staff.

The reaper report gains the archive's current total size. In dry-run it also gains projected numbers per eligible worktree and in total: the residue bytes that would be archived and the apparent bytes that would be reclaimed. Worktrees kept for a real `node_modules` and those with a symlinked one are counted separately. That gives the Chief of Staff the projected cost and gain before live removal is decided.

### 6. Unchanged

Everything else ignored stays `work`, including `logs/` and a real `node_modules`. Tracked and untracked changes keep the checkout as today.

This change only alters which worktrees the dry-run report lists as eligible. The reaper stays `dryRun: true`. Turning on real removal is a separate decision, made with the new report's numbers (Chief of Staff, msg 366ce3fe).

## Decision points touched

- **Whether an ignored entry is regenerable, archived residue or work.** — invariant. basis: irreversible-consequence; evidence: the classification gates `git worktree remove`, which cannot be undone. `regenerable` requires git-level proof that the content is in a commit; in this change only the registry copy qualifies. The existing `dist/` rule (`distIsBuildOutput`, a timestamp-window heuristic) is unchanged and out of scope; this invariant covers only the new classes. `archived-residue` requires the closed path list and a regular file, and its bytes are preserved before removal. Anything else stays `work`, the fail-closed floor of the existing reaper spec.
- **Whether archiving a checkout may proceed against free space.** — invariant. basis: external-constraint; evidence: the copy must physically fit on the archive's volume (`statfs` free bytes greater than the residue's size). Without that, the write fails part-way and the checkout is kept anyway; checking first makes the outcome explicit.
- **Whether a removal proceeds when an archive copy fails to verify.** — invariant. basis: irreversible-consequence; evidence: a failed or mismatched copy means bytes would be lost with the checkout, so the checkout is kept. This is the rule `preserveGateRecords` already applies to gate records (`agentWorktreeGit.ts:298`).

## Frontloaded Decisions

- **Live removal stays off.** The reaper remains `dryRun: true`. The Chief of Staff decides on live removal after seeing the new report (msg 366ce3fe).
- **Prove only where proof is complete; otherwise archive.** Only the registry copy is proven, against the HEAD blob. Everything else is preserved byte for byte, including the husky shims and the audit trails the Chief of Staff's approval named.
- **`logs/` stays work.** It is not on the list. Logs can be large and have no single writer.

## Multi-machine posture

`machine-local-justification: hardware-bound-resource`. The reaper classifies worktrees on this machine's own disk, and the archive is written to this machine's agent home, as gate records already are. Each machine runs its own reaper over its own checkouts.

## Expected effect

Of the 151 checkouts that are clean by git status, 28 still hold a real `node_modules` folder and stay `work`. So at most about 123 can become eligible, and only those whose branch is merged. The post-install report gives the real count.

This clears part of the backlog. It does not stop the daily growth by itself. Session worktrees created since PR 3346 carry a real `node_modules` folder (about 727 MB apparent, possibly APFS-cloned), which correctly stays `work`. Per-worktree reclaim for the eligible ones is smaller than the average: their `node_modules` is a symlink, so a few hundred MB apparent. What is not part of this change:
- worktrees holding a real `node_modules`;
- moving per-run writers (the session audit trail, generator outputs) out of checkouts.

The next stewardship change is the disk-steward busy-check fix (fb-eb8372d8-043). The ongoing growth is watched through the Chief of Staff's 60 GB tripwire.

## Testing

Unit tests, on both sides of each rule:
- registry copy whose blob hash equals `HEAD:docs/STANDARDS-REGISTRY.md` → `regenerable`; one byte different → `work`;
- `.husky/_/` children from a real husky install → `archived-residue`; a subfolder inside it, or the folder as a symlink → `work`;
- final re-check: a residue file appended after its copy → kept; a new audit file created after the archive (manifest addition) → kept; a rotation that renames `x.jsonl` to `x.jsonl.1` after the archive → kept; a process started in the checkout after evaluation → kept;
- each archived-residue path as a regular file → `archived-residue`; as a symlink or under a deeper folder → `work`; an unlisted path (`logs/x`, `src/data/other.json`) → `work`;
- `.instar/audit/` reported as a folder entry: all children matching → archived; one non-matching child or a subfolder → `work`;
- `isClean` with only proven-regenerable and archived residue plus gate records → clean; adding any other ignored file → dirty;
- archive step: children copied and verified, streaming; a forced mismatch keeps the checkout; the free-space floor refusal keeps the checkout; `preserveGateRecords` accepts the new class;
- the report carries the archive size and the dry-run projections;
- an integration test runs the full remove path on a temporary checkout and asserts that nothing is written into that checkout's `.instar/audit/` (the executors' audit-path behaviour, including `INSTAR_AUDIT_LOG_DIR`).

Integration: a real `git worktree` with a husky install and generated files is reported eligible when merged.

Evidence for the claim: re-run the Studio report after install and record the new eligible count and the archive size.

## Accepted residual

An outside process could change a residue file between that file's last observation in the final re-check and the deletion by `git worktree remove`. The bytes written in that window would be lost. The process scan runs after the hashing, which narrows the window for a process that starts during the re-check. The existing gate-record path has the same kind of window today (preserve, then remove). Closing it fully would need a lock that every writer honours, and no such lock exists for the checkout's ignored files. The window runs from each file's last hash to the end of one `git worktree remove` call. The only listed files written by outside processes are the audit trails, and those come from processes whose working folder is the checkout, which the uncached in-use check refuses.

## Accepted conformance flags

- **Judgment Within Floors: closed path list and one-level depth.** Accepted. The list and the depth are the fail-closed floor for an irreversible `git worktree remove`. Anything not on the list is kept, which is the safe direction and today's behaviour. The list holds exactly the paths measured holding clean worktrees on the Studio (Problem statement). A path is added only with the same evidence: a named writer and a measurement, never a judgment made at deletion time. Archiving more broadly would preserve bytes too, but it would turn the archive into a copy of whatever happens to sit in a checkout.

## Removal stays dry-run, and what covers the gap

The reaper keeps `dryRun: true` after this change. The Chief of Staff accepted that explicitly (msg 366ce3fe, 2026-11-18 18:23 PT): real removal waits for the new report's numbers.

Until then, the named fallback for the Studio's disk is the Chief of Staff's 60 GB tripwire (msg 67f2d72c, 18:35 PT), owned by echo-machine-stewardship:
- `.instar/stewardship/disk-tripwire.sh` checks free space every 5 minutes;
- if free space drops under 60 GB before this change or the busy-check fix (fb-eb8372d8-043) lands, the Chief of Staff and I pick a safe manual step together.

The bound is the live-removal decision, which I bring to the Chief of Staff with the post-install report. That decision must also settle one cost named here. With removal live, each removal runs the final re-check's fresh process scans (`lsof` and `ps`, synchronous, each allowed up to 15 s, `agentWorktreeGit.ts:460, 486`) on the main thread. The existing `maxReapsPerPass` cap is 20 (`AgentWorktreeReaper.ts:76, 341`). Live removal is not turned on until those scans run off the main thread or the per-pass cap is lowered, with the measured scan time.

## Maturation plan

- **test-agent-live:** a throwaway agent home with real `git worktree`s covering these cases:
  - merged, holding only generated residue and husky shims: reported eligible, with projected residue bytes;
  - the same, plus an unlisted ignored file: kept;
  - a real `node_modules`: kept;
  - a registry copy with one byte changed: kept;
  - `.instar/audit/` holding a subfolder: kept.

  The archive and final re-check path runs once with removal enabled on the throwaway only: residue is archived and verified, an append after the copy keeps the checkout, and nothing is written into the target's `.instar/audit/`.
- **dev-agent-live:** on Echo after install, in dry-run. Read `GET /worktrees/agent-reaper` on the Studio and record the eligible count, the projected archive bytes and the projected reclaim.
- **fleet:** the classification change reaches every agent in its existing dry-run reaper state, report only. Live removal on any agent follows the existing `monitoring.agentWorktreeReaper` ladder and the Chief of Staff's live-removal decision.
- **graduation criterion:** a maturation-board judgment weighing the Studio's dry-run numbers and the throwaway rung. The counts are inputs to that judgment, not gates.
- **dark-window:** if the Studio report has not been read by 2026-12-02, the board entry records why and a new date.
- **ladder:** monitoring.agentWorktreeReaper

## Rollout

The change ships in dry-run (the reaper's existing state). After install, read `GET /worktrees/agent-reaper` on the Studio and bring the eligible count and size to the Chief of Staff for the live-removal decision.
