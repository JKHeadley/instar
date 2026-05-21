# Convergence Report — Nuke --here leftover-artifact fixes

## ELI10 Overview

Yesterday's release added "uninstall instar from this project folder"
as a one-command operation. Test-driving it on a fresh project this
morning uncovered two pieces uninstall forgot:

1. The `.gitignore` instar writes during install — left orphaned.
2. The `.instar/` folder itself — deleted, but the very next logging
   line rewrote a tiny audit file back into `.instar/audit/`,
   resurrecting the folder.

Both are small but they break the "after uninstall, the project looks
like it did before instar" promise.

This PR closes both. `.gitignore` joins the existing identity-shadow
rule (keep if it was committed before instar, restore from git if
instar modified it, delete if instar created it). `.instar/` is now
the final destructive operation in uninstall, with audit logging
silenced for that single call so the directory doesn't write itself
back into existence.

The fix is small, reuses existing primitives, and adds three unit
tests pinning the corrected behavior.

## Original vs Converged

There was no "original" weak version — the fix went straight to the
right shape because both bugs share the same root cause (uninstall
modeled as independent ops, ignoring that `.instar/` is itself the
audit-log location for the OTHER ops).

The only alternative considered and rejected: redirecting the audit
log to a temp file during uninstall. That would touch more surface
(every audit-writing op gets a new env path), and the single-op
suppression on the final `.instar` delete is sufficient given the
order change. Out of scope.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self                  | 0 (fix matches root cause) | none |

The fix derives directly from end-to-end test observation. Each piece
of the diagnosis was confirmed against the runtime behavior:
`.gitignore` was on disk after `nuke --here`; `.instar/audit/
destructive-ops.jsonl` was on disk after `nuke --here`; the audit
log path was confirmed at
`src/core/SafeGitExecutor.ts:auditLogPath`.

## Full Findings Catalog

**Finding 1 — `.gitignore` survives uninstall.**
- Severity: medium (functional gap, not data loss).
- Resolution: add `.gitignore` to `PROJECT_LOCAL_IDENTITY_SHADOWS`.
  The existing `classifyShadowFile` decision (keep / restore /
  delete) already handles this file's three pre-existing states
  without modification.

**Finding 2 — `.instar/` ghost-revived via audit log.**
- Severity: medium (functional gap, leaves orphan dir).
- Resolution: reorder teardown so `.instar/` is last, and suppress
  audit logging for that single `safeRmSync` via the existing
  `INSTAR_AUDIT_LOG_DISABLED=1` env contract. Restore previous env
  state in a `finally` block.

## Convergence verdict

Converged at iteration 1. The fix exercises existing primitives only;
no new abstraction or authority. Three new unit tests pin the
corrected behavior. Spec is ready.
