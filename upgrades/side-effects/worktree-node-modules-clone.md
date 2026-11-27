# Side-Effects Review — worktree node_modules: copy-on-write clone on macOS

**Version / slug:** `worktree-node-modules-clone`
**Date:** `2026-11-17`
**Author:** `echo (machine stewardship, topic 144503)`
**Second-pass reviewer:** `not required (Tier 1: no block/allow surface; failure falls back to existing behavior)`

## Summary of the change

`src/core/InstarWorktreeManager.ts`: `maybeSymlinkNodeModules` becomes `maybeShareNodeModules(instarRepo, worktreePath, mode)`. New option `nodeModulesShareMode` ('clone' | 'symlink'; default clone on darwin, symlink elsewhere) and result field `nodeModulesShared` ('clone' | 'symlink' | null). Clone = `/bin/cp -cR source staging` then `rename(staging, target)`; on any failure the staging folder is removed via SafeFsExecutor and the old symlink is made. `src/commands/worktree.ts`: prints the clone line, keeps the shared-tree warning for symlinks. Tests: the integration sharing test pins symlink mode; a new integration test covers clone mode (own folder, removing it leaves the source intact, no staging leftovers; non-darwin accepts the fallback). Measured motivation (Mac Studio, 2026-11-17): `npm ci` inside a worktree whose node_modules is a symlink empties the link target (npm 11.11.0, reproduced in a scratch dir); 34 of the last day's worktrees carried their own full install (avg 0.64 GB) and 49 linked into sibling worktrees; a clone of a 16,317-file node_modules took 18.7 s at load ~30 with no measurable disk cost. Tier 1. Size: 3 files, about 90 lines. Effort: one review round.

## Decision-point inventory

- `maybeShareNodeModules` — modify — clone vs symlink vs nothing for a new worktree's node_modules. Not a block/allow decision.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Residual: worktrees created before this change keep their symlinks; branches with changed dependencies still need their own install (now into their own folder, which is the point).

---

## 3. Level-of-abstraction fit

Right layer: the one function that decides how a new worktree receives node_modules. Cloning uses the OS primitive (clonefile via `cp -c`) rather than re-implementing a copy.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point: clone-or-fall-back is a capability check (the OS either clones or it does not).

---

## 5. Interactions

- **Shadowing:** hook activation (`ensureHuskyHooksActive`) runs after sharing and finds `.bin/husky` in the clone as it did through the link.
- **Double-fire:** none.
- **Races:** the staging name carries pid + time; rename is atomic on one volume; `existsSync(target)` is still checked first.
- **Feedback loops:** none. The worktree reaper's inbound-link check sees fewer links, so fewer checkouts are pinned by siblings (intended).

---

## 6. External surfaces

- Other agents on the same machine: less disk and no cross-worktree dependency wipes.
- Install base: macOS creates take up to ~20 s longer on a loaded machine; Linux unchanged.
- External systems: none. Persistent state: the worktree ledger entry is unchanged.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard, approval page or form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — worktrees and their dependency folders are per-machine files. No notices, no durable shared state, no URLs, no status surfaces changed.

---

## 8. Rollback cost

- **Hot-fix release:** revert; or per call `nodeModulesShareMode: 'symlink'`.
- **Data migration:** none. Existing clones are ordinary folders.
- **Agent state repair:** none.
- **User visibility during rollback:** none.

## Conclusion

Safe Tier-1 change that removes a cross-worktree data-loss hazard and a large disk leak, with the old behavior as the automatic fallback.

## Second-pass review (if required)

Not required.

## Evidence pointers

- Scratch reproduction: `npm ci` (npm 11.11.0) with `node_modules -> ../shared/node_modules` left `shared/node_modules` empty and removed the link.
- `tests/unit/InstarWorktreeManager.test.ts`: 56 passed; guard files no-silent-fallbacks + no-empty-catch-blocks passed. Integration file runs in Local Verify (no local integration runs on the Studio).
