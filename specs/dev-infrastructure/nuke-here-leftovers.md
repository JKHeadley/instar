---
title: "Nuke --here — close two leftover-artifact failure modes"
slug: "nuke-here-leftovers"
author: "echo"
eli16-overview: "nuke-here-leftovers.eli16.md"
review-convergence: "2026-05-21T18:45:00Z"
review-iterations: 1
review-completed-at: "2026-05-21T18:45:00Z"
review-report: "docs/specs/reports/nuke-here-leftovers-convergence.md"
approved: true
---

# Nuke --here — close two leftover-artifact failure modes

## Problem statement

End-to-end testing of `instar nuke --here` (v1.2.8, shipped via PR
#295) against a freshly-cloned `instar-codey` project revealed two
artifact-leak bugs:

1. **`.gitignore` not in the teardown set.** `instar init` writes a
   fresh `.gitignore` listing the per-machine state ignores
   (`.instar/state/`, machine signing keys, `.worktrees/`, etc).
   `nuke --here` removes everything else but leaves `.gitignore`
   behind. On a project that had no `.gitignore` before instar was
   installed, that's an orphaned instar-owned file.

2. **`.instar/` ghost-revival after deletion.** `SafeFsExecutor` and
   `SafeGitExecutor` both write to `.instar/audit/destructive-ops.jsonl`
   on every operation. `nuke --here` removes `.instar/` early in the
   teardown sequence; every subsequent destructive op
   (`.claude/` delete, shadow-file delete, etc) then recreates
   `.instar/audit/` to log its audit entry. The final on-disk state is
   an "empty" `.instar/` containing only `audit/destructive-ops.jsonl`
   — not the clean teardown the contract promises.

Both bugs were observed in a real test cycle on
`~/Documents/Projects/instar-codey/instar-codey/` after `init` +
`nuke --here --yes`.

## Proposed design

### Fix 1: `.gitignore` joins the identity-shadow classifier

`.gitignore` already fits the identity-shadow pattern: it can pre-exist
in a project, and instar's installer may write it fresh OR append to a
tracked-by-HEAD copy. The existing `classifyShadowFile` decision
function handles exactly this case (tracked-clean → keep,
tracked-modified → restore, untracked → delete). Adding `.gitignore`
to `PROJECT_LOCAL_IDENTITY_SHADOWS` reuses the decision without new
logic.

### Fix 2: reorder teardown + suppress audit on the final `.instar` delete

Two changes in the teardown loop:

1. **Order**: shadows first, then non-`.instar` always-remove, then
   `.instar` last. This keeps `.instar/audit/` alive during the bulk of
   the work so audit log writes have a valid destination, and lets the
   `.instar` delete be the actual final destructive op.

2. **Audit suppression on the final delete**: just before
   `safeRmSync('.instar')`, set `INSTAR_AUDIT_LOG_DISABLED=1` in
   `process.env`. The existing audit log function already honors this
   env var (per `src/core/SafeGitExecutor.ts:auditLogPath`). After the
   delete, restore the previous env state. This prevents the final
   `safeRmSync` from immediately recreating `.instar/audit/` to log its
   own success.

The agent dir is going away in the same breath, so the suppressed
audit entry for that single op has no downstream consumer — there's
no inconsistency cost.

### Why these are not separate decisions

Both bugs share a root cause: `nuke --here` was modeled as a series of
independent destructive ops, without acknowledging that `.instar/` is
itself the audit-log location for all the OTHER ops. The fix is a
single tightening of the teardown contract: identity-shadow files are
classified by git, and `.instar/` is treated as the last-thing-to-go
with audit suppression.

## Decision points touched

- Adds one entry (`.gitignore`) to the existing
  `PROJECT_LOCAL_IDENTITY_SHADOWS` list — no new classification logic.
- Adds one env-var-scoped audit-log suppression for one
  `safeRmSync` call. The env var (`INSTAR_AUDIT_LOG_DISABLED`) is the
  existing public switch in `SafeGitExecutor`. No new authority.
- Reorders the teardown sequence; no new operations introduced.

## Open questions

None. The fix exercises only existing primitives. Three new unit tests
pin the corrected behavior.

## Out of scope

- Other identity-shadow files we may discover in future installs
  (e.g., framework-specific config files). The classifier list is
  extensible; this PR adds only what testing exposed.
- A general audit-log redirection during `nuke --here` (writing to a
  temp file outside the deleted tree). The single-op suppression is
  sufficient given the order change; a redirect would touch more
  surface for no incremental win.
