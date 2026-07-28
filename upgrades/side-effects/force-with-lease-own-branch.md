# Side-Effects Review — dangerous-command-guard allows force-with-lease to own branch

**Version / slug:** `force-with-lease-own-branch`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `required (safety-hook relaxation)`

## Summary of the change

The `dangerous-command-guard.sh` PreToolUse hook blocks risky git commands. Its
risky-pattern list includes `"git push --force"` and `"git push -f"`. Because the
match is a case-insensitive substring, `git push --force-with-lease` ALSO matches
`git push --force` and gets blocked — even though `--force-with-lease` is the
*safe* force-push (it refuses to overwrite work the local clone hasn't seen).

This is a recurring friction: a dev session resolving its OWN PR (rebase/amend →
push) needs `--force-with-lease` to its feature/PR branch, and the guard blocks
it. Codey hit it mid-cycle (framework-issue `52fa8663`).

The fix adds a narrow carve-out BEFORE the risky-pattern loop:

```
FORCE_WITH_LEASE_OWN_BRANCH=0
if <command contains "git push ... --force-with-lease">; then
  if <command explicitly names a protected branch: main|master|develop|release*>; then
    FORCE_WITH_LEASE_OWN_BRANCH=0   # keep blocking
  else
    FORCE_WITH_LEASE_OWN_BRANCH=1   # allow the safe case
  fi
fi
```

Inside the loop, when `FORCE_WITH_LEASE_OWN_BRANCH=1` and the matched pattern is a
force-push pattern, the loop `continue`s (skips the block). All OTHER risky
patterns (`git reset --hard`, `git clean -fd`, DB-destruction, plain `--force`)
are untouched.

The change is applied identically to BOTH canonical deploy sources —
`PostUpdateMigrator.getDangerousCommandGuard()` (existing agents, always-overwrite
on every migration) and the inline copy in `src/commands/init.ts` (fresh init) —
plus the vestigial reference copy at `src/templates/hooks/dangerous-command-guard.sh`
(not on any runtime deploy path, kept consistent to avoid a future stale-source trap).

## Decision-point inventory

One decision point, two conditions:
1. **Is it force-with-lease?** `git +push[^|;&]*--force-with-lease` (the safe variant).
   If not present → no carve-out, normal blocking applies.
2. **Does it explicitly target a protected branch?** A standalone `main`/`master`/
   `develop`/`release*` token (word-boundary anchored: preceded by space/`:`/`/`/start,
   followed by space/`:`/end). If yes → keep blocking. If no → allow.

## 1. Over-block (what does this still block that it should?)

- **Plain `git push --force` / `git push -f`** (no `--force-with-lease`): still
  blocked — `FORCE_WITH_LEASE_OWN_BRANCH` stays 0, the force pattern matches, no
  carve-out. ✅ (test: "BLOCKS plain git push --force", "BLOCKS git push -f")
- **`--force-with-lease` to an explicit protected branch** (`... origin main`,
  `... master`): still blocked — the protected-token regex sets the flag back to 0.
  ✅ (tests: "BLOCKS force-with-lease that explicitly targets main/master")
- **Every non-force risky pattern** (`git reset --hard`, `git clean -fd`, DROP/
  TRUNCATE/DELETE, `rm -rf .`): untouched — the carve-out only `continue`s for
  patterns matching `git push (--force|-f)`. ✅ (test: "still BLOCKS git reset --hard")

## 2. Under-block (what does it now allow that it didn't?)

ONLY `git push --force-with-lease` to a NON-protected branch (the agent's own
feature/PR branch). This is genuinely safe:
- `--force-with-lease` will not clobber commits the local ref hasn't observed (it
  fails loudly if the remote moved underneath you), so it cannot silently destroy
  a collaborator's work the way bare `--force` can.
- A feature/PR branch is not shared history; force-updating it after a rebase/amend
  is the normal, expected workflow.

**Residual edge — `git push --force-with-lease` while checked out ON main with no
branch named** (the command string contains no protected token, so the flag is 1).
This is double-protected and not a real risk:
1. Instar agents work in feature-branch worktrees per the Worktree Convention —
   they are never checked out on main.
2. `main` carries remote branch protection on the canonical repo, which rejects
   any force-push regardless of what the local guard allows.
The local guard is defense-in-depth, not the only line; this edge requires
defeating BOTH the convention and remote branch protection.

## 3. Blast radius

- `src/core/PostUpdateMigrator.ts` (`getDangerousCommandGuard()`) — redeploys the
  hook to every agent on next migration (always-overwrite path, line ~1832). No
  new migration method required: the existing always-overwrite is the delivery.
- `src/commands/init.ts` — fresh-init copy.
- `src/templates/hooks/dangerous-command-guard.sh` — vestigial reference, kept in sync.
- `tests/unit/dangerous-command-guard-force-with-lease.test.ts` — new (10 tests).
- No API, schema, config, or behavior change beyond the one guard decision.
- The pre-existing gh-pr-merge gate and coherence-gate blocks in the same hook are
  untouched (regression test `dangerous-command-guard-gh-pr-merge-gate.test.ts`
  re-run green).

## 4. Reversibility

Fully reversible: revert the carve-out block in the three sources; the next
migration redeploys the prior hook. No state, no persisted format, no migration
flag. Verified: `tsc --noEmit` clean; 10/10 new tests pass; the existing guard
test suite stays green.
