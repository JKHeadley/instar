# Side-Effects Review — Disk Steward measures the whole disk by owner, once a day

**Version / slug:** `disk-steward-whole-disk`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1: one new read-only module (`src/monitoring/diskSteward/wholeDisk.ts`), wiring in the prune child (`diskStewardMain.ts`), the runner (`pruneRunner.ts`), the steward (`DiskSteward.ts`), a `du -k -d 1` seam and parser in `pruneCategories.ts`, one post line in `DiskStewardPoster.ts`, awareness text in `templates.ts` and `PostUpdateMigrator.ts`, spec §3.7a. Tests: 15 new unit cases, steward and route assertions. A revert undoes it; the new `wholeDisk` field in persisted state is ignored by older builds.

The agent-home sizes named about 25 GiB of 746 GiB used on the Laptop (2026-11-11). Once a day, inside the existing detached prune child, the steward now sizes the top level of the home folder, names agent owners from `~/.instar/registry.json`, and reports the rest by top-level folder. On macOS it never opens Documents, Desktop, Downloads, Library, Pictures, Movies, Music or .Trash; their bytes are reported as not opened. Each folder gets at most a quarter of the remaining time; a stopped walk reports "at least" what it counted and the folder is named as unfinished; the walk ends 2 min before the server kill deadline.

Effort: one commit, amended once after a live read-only run on the Studio found that one folder could use the whole budget (163 of 812 GiB counted; 254 GiB after the cap). This artifact, the release note and the decision record are added after the fact because the worktree had no commit hooks (raw `git worktree add`); the merge line refused the first PR of the stack on `decision-audit` and `release-fragment`.

## Decision-point inventory

- When to request the whole-disk walk (`wantsWholeDisk`, 24 h) — add — piggybacks on runs the steward already starts.
- Which folders are opened (`MAC_NOT_OPENED`, symlinks, other volumes, depth 3) — add — read-only traversal rules.
- Per-folder time cap and run-deadline budget — add.
- Cleanup categories, thresholds, levels, cadence — pass-through, unchanged.

---

## 1. Over-block

No block/allow surface: nothing is refused or deleted. The exclusion list can leave real usage uncounted (an agent placed under ~/Documents, against the TCC standard); those bytes appear as "not opened", so the total still adds up.

---

## 2. Under-block

A folder too big to walk in its share (this agent's own `.worktrees-deps`, about 105 GiB of installed packages) is reported as a lower bound and named as unfinished; for this agent's own folder, the sizes measured in the same run are a floor. Other agents' homes have no floor. Hard links counted in two folders are counted twice (separate `du` runs); the figure is approximate, as the post says "about".

---

## 3. Level-of-abstraction fit

Right layer: sizing already runs in the detached prune child under `nice`, never on the server event loop (§3.7). This reuses its seams and its budget model and feeds the existing post; no new process, job or route.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It produces a measurement (a signal) carried in the status route and the post. It holds no authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The excluded-folder list is a safety rule for macOS privacy folders (deterministic by design, named in the TCC-protected path standard); the time cap is a resource bound.

---

## 5. Interactions

- Run deadline: the walk takes at most 15 min and stops 2 min before the server kills the run, so the run result (cleanup and sizes) is never lost to the walk.
- The 6 h folder sizes (§3.7) are unchanged and still run first.
- The dry-run shortcut that skips a child run now also requires the whole-disk result to be fresh, so at most one extra child run a day.
- Disk I/O: a daily walk of the home folder under `nice -n 10` (the child's own priority) with `du`; on the Studio it took 524 s.

---

## 6. External surfaces

Disk posts gain one line ("Whole disk, 746 GiB used: agent sagemind 79 GiB, `~/Projects` 62 GiB, ...; 300 GiB is in folders I don't open ..."). `GET /disk-steward` gains `wholeDisk` (null until the first run). Names pass `cleanName`; a malformed peer value renders no line.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not an operator-surface file (no dashboard, approval page or form). The post line was checked in the poster tests at the Telegram text level.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine measures its own disk, keeps the result in its own steward state, and carries it in its own due post; the lease holder renders peers' posts as data. `?scope=pool` returns each peer's own `wholeDisk` through the existing live peer read. **Status surfaces:** `GET /disk-steward` adds `wholeDisk`.

---

## 8. Rollback cost

Revert the commit. The persisted `wholeDisk` field is ignored by older code; no data or config repair.

## Conclusion

Safe to ship as Tier 1: read-only, bounded in time, privacy folders never opened, and honest about what it could not count.

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle or messaging block/allow decision is touched.

## Evidence pointers

- `tests/unit/diskSteward-wholeDisk.test.ts` (15 pass), `tests/unit/diskSteward.test.ts` (12 pass), `tests/unit/diskStewardPoster.test.ts` (6), `tests/unit/diskSteward-pruneCategories.test.ts` (13), `tests/integration/disk-steward-routes.test.ts` (6 pass).
- Live read-only run on the Studio, 2026-11-12: 254 of 813 GiB counted in 524 s after the per-folder cap (163 GiB before it).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered action added (the walk runs inside an existing run and sends nothing on its own) — not applicable.
