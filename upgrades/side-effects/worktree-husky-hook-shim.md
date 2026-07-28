# Side-Effects Review — Worktree creation activates Husky hooks

**Version / slug:** `worktree-husky-hook-shim`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `instar-codey second-pass checklist`

## Summary of the change

This change makes `instar worktree create` ensure the generated Husky
pre-commit shim exists and is executable in each newly-created Instar worktree.
If the tracked Husky pre-commit script and package prepare script are present
but the generated shim is missing, the manager runs the prepare step in the new
worktree and verifies the shim afterward. If activation fails, worktree creation
fails instead of returning an ungated checkout.

## Decision-point inventory

- `createWorktree` — modify — calls hook activation after git identity is set
  and before returning the new worktree.
- `ensureHuskyHooksActive` — add — detects project Husky configuration, runs
  prepare when needed, and fails closed if the shim remains missing.
- `hasRunnableHookShim` — add — small predicate for unit coverage and activation
  verification.
- Worktree integration fixture — modify — simulates Husky prepare and asserts a
  created worktree has the runnable shim.

---

## 1. Over-block

Worktree creation can now fail if a project has a tracked Husky pre-commit
script and package prepare script but prepare is broken. That is intentional:
returning a checkout that looks protected while commits bypass the gate is the
failure class this change fixes.

Repositories without a tracked Husky pre-commit script are skipped. This keeps
the convention repo-specific rather than imposing Husky on unrelated checkouts.

## 2. Under-block

The check proves the generated shim exists and is executable, not that every
hook command inside the tracked script will pass. That is the correct boundary
for worktree creation: it guarantees Git can invoke the hook, while the hook
itself owns later lint, trace, and migration checks.

## 3. Level-of-abstraction fit

The manager owns the structural properties of a newly-created agent worktree:
location, identity, audit ledger, and now hook availability. Keeping this in the
manager means CLI callers, wrapper callers, and tests share one enforcement
path.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Not applicable to conversational/product judgment — this is structural
  local hook activation for developer worktrees.

## 5. Interactions

- **Shadowing:** This does not replace the pre-commit hook. It only ensures the
  generated dispatch shim exists so Git can call the tracked hook.
- **Double-fire:** Prepare runs once during worktree creation only when the shim
  is missing. Existing runnable shims are left alone.
- **Races:** Concurrent creation of different worktrees runs prepare in separate
  directories, so no shared shim file is mutated.
- **Feedback loops:** The activation step runs before any user commit, so it
  closes the "remember to install hooks" loop at the source.

## 6. External surfaces

Agents and developers using the built-in worktree command receive a checkout
whose pre-commit gate is actually runnable. If hook activation fails, they get a
clear creation error instead of a silently ungated worktree.

## 7. Rollback cost

Rollback is a code and test revert. Existing worktrees keep whatever local hook
state they already have.

## Conclusion

The diagnosis showed that hook configuration can be present while Husky's
ignored generated shim is absent. This change makes worktree creation repair
and verify that local generated state, turning the gate from remembered setup
into structure.

---

## Second-pass review (if required)

**Reviewer:** instar-codey second-pass checklist
**Independent read of the artifact:** concur

The second pass agrees that the fail-closed behavior is appropriate for the
official Instar worktree command and that the activation boundary is narrow.

---

## Evidence pointers

- `tests/unit/InstarWorktreeManager.test.ts`
- `tests/integration/instar-worktree-create.test.ts`
