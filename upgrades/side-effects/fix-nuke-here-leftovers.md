# Side-effects review — Nuke --here leftover-artifact fixes

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER on two specific paths.
- `.gitignore` survived nuke entirely (orphaned instar artifact).
- `.instar/` resurrected itself via audit-log writes immediately after
  delete, leaving an empty `.instar/audit/` directory behind.

After: precisely targeted. `.gitignore` joins the existing identity-
shadow classifier (same three-way disposition: keep / restore /
delete). `.instar/` is now the last destructive op, with audit logging
suppressed for that single call so it doesn't recreate itself. No
over-block: the keep-pre-existing-`.gitignore` path means a project
that had its own `.gitignore` before instar was installed gets that
file preserved.

## 2. Level-of-abstraction fit

Fix 1 adds one string to an existing array
(`PROJECT_LOCAL_IDENTITY_SHADOWS`); no new classifier, no new
disposition. The existing `classifyShadowFile` already handles
`.gitignore` correctly.

Fix 2 partitions an existing array (`PROJECT_LOCAL_ALWAYS_REMOVE`)
into "everything except `.instar`" and "`.instar`". The audit
suppression uses an existing public env var
(`INSTAR_AUDIT_LOG_DISABLED`) documented in
`src/core/SafeGitExecutor.ts:auditLogPath`. No new authority, no new
API surface.

## 3. Signal vs Authority compliance

- The git-tracked-vs-untracked decision for `.gitignore` delegates
  exactly as it does for other shadow files: `git ls-files
  --error-unmatch` + `git status --porcelain` are the AUTHORITY.
- The audit-log suppression honors the existing
  `INSTAR_AUDIT_LOG_DISABLED` env contract — the env var IS the
  documented signal for "skip audit." No new signal invented.

## 4. Interactions with adjacent systems

- **`SafeFsExecutor.safeRmSync` / `SafeGitExecutor.execSync` audit
  paths** — unchanged. They continue to write to
  `<cwd>/.instar/audit/destructive-ops.jsonl` whenever
  `INSTAR_AUDIT_LOG_DISABLED` is not set. The only suppression is
  inside `nukeHere`, around the final `.instar` delete, and is
  scoped to that single op.

- **`classifyShadowFile` callers** — none other than `nukeHere`. The
  function's signature is unchanged.

- **Other CLI commands that touch `.gitignore`** — `instar init`
  writes it, `instar setup` does not touch it. No reader of
  `.gitignore` depends on it being absent. Removing it during nuke
  has no cascading effect.

- **Reinstall flow** — `instar init` regenerates `.gitignore` from
  scratch. The fix re-aligns the install/uninstall contract:
  whatever `init` writes, `nuke --here` removes.

## 5. Rollback cost

Trivial. One array-element addition and one reorder + env-var
suppress block in `src/commands/nuke.ts`. Three new unit tests.
`git revert` restores the prior leaky behavior.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- `nuke <name>` (standalone form) untouched.
- `nuke --here` consumers see strictly more-correct behavior: no
  orphaned `.gitignore`, no ghost `.instar/`.
- A project that had `.gitignore` tracked in git before instar was
  installed gets it preserved (the new identity-shadow rule) —
  strictly better than the v1.2.8 behavior of leaving instar's
  rewritten version behind. No legitimate caller depends on the
  buggy v1.2.8 leftover state.
- No config changes, no template changes, no hook changes, no
  migration work needed (CLI-only surface).

## 7. Authorization / Trust posture

No new authority. The audit-log suppression is scoped to one syscall
inside one function; the env var is restored in a `finally` block so
the rest of the process retains the prior audit-log state. The
shadow classifier already delegates the keep/restore/delete decision
to git, not to instar.

## Outcome

Ship. Closes the two leftover-artifact failure modes uncovered by
end-to-end testing on `instar-codey`. Three unit tests pin the
corrected behavior. The fix exercises only existing primitives;
zero new abstraction surface.
