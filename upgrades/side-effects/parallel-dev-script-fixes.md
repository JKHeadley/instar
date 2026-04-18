# Side-effects review — parallel-dev script fixes (migration + ruleset install)

**Scope**: Fix two bugs in the parallel-dev ops scripts that surfaced during
live Day-2 rollout on `JKHeadley/instar`:

1. `scripts/migrate-incident-2026-04-17.mjs` — refused when the incident-snapshot
   stash had moved from `@{0}` to a later index (legitimate, since other sessions
   had pushed newer stashes on top).
2. `scripts/gh-ruleset-install.mjs` — (a) `gh api --field` stringified nested
   JSON so GitHub rejected every ruleset body; (b) `evaluate` mode is an
   Enterprise-only feature, and the `file_path_restriction` rule is also
   Enterprise-only — on Team/Pro/public plans the install blew up instead of
   degrading.

**Files touched**:
- `scripts/migrate-incident-2026-04-17.mjs` — stash scan by label, not position
- `scripts/gh-ruleset-install.mjs` — stdin-piped JSON body + `--mode disabled`
  support + `--skip-trust-root` flag for non-Enterprise plans

**Under-block**: none. Both changes make scripts MORE tolerant of real-world
state while preserving the safety intent.

- Migration: the real invariant is "the incident-snapshot still exists and has
  not been altered" — position in the stash list is irrelevant to that. Scanning
  for the label preserves the integrity check without the brittle assumption.
- Ruleset install: stdin-piped JSON is the only way to POST nested ruleset
  bodies; `--field` was broken from day one. `--skip-trust-root` is additive —
  existing `--mode active` calls keep trying to install the K4 ruleset (which
  works on Enterprise); it's only skipped when the operator explicitly opts out.

**Over-block**: none.

**Level-of-abstraction fit**: Both fixes are tightly scoped to the one-line (or
one-helper) failure. `ghApi()` stays the single call site, the migration's
`verifyStash()` still returns the same `{ok,skipped,reason}` shape.

**Signal vs authority**: no authority change. Both scripts remain operator-run
tools that mutate external state (keychain / GitHub rulesets) only when the
operator invokes them. No gate is added or removed.

**Interactions**:
- `scripts/gh-ruleset-install.mjs` is on the K4 trust-root file list. Until
  that ruleset is installed, the file can be modified without 2-approval.
  After: modifying this script requires 2 approvals. That's OK — script
  lifecycle is rare and the 4-eyes gate is appropriate for it.
- The migration `.NEW` private-key file is still written as before. Operators
  remain responsible for registering it into the keychain (no change in that
  path).

**External surfaces**:
- No new CLI, no new endpoint, no new external dep.
- `gh-ruleset-install.mjs` usage string changes to add `disabled` to mode list
  and document `--skip-trust-root` flag.

**Rollback cost**: trivial — revert the edits; no on-disk state to undo. The
only externally-observable effect of running the scripts (installed rulesets,
keychain entries, sentinel file) is orthogonal to the script edits themselves.

**Tests**: both scripts parse (`node --check`). Live-tested on
`JKHeadley/instar`:
- Migration: sentinel written, stash@{1} correctly identified as the
  incident-snapshot.
- Ruleset install: branch ruleset (id 15247386) + tag ruleset (id 15247391)
  installed in active mode. Trust-root ruleset deliberately skipped — this
  repo is non-Enterprise so `file_path_restriction` is not available.

**Decision-point inventory**:
1. Stash scan (vs require-at-@{0}) — chosen because position instability is
   the common real-world state; altering contents would still fail.
2. stdin-piped JSON (vs `--field`) — the only way to POST typed nested bodies
   via `gh api`. `--field` is for flat query-style params.
3. `--skip-trust-root` flag (vs hard-coded plan detection) — keeps the script
   deterministic and operator-auditable; plan detection is surprisingly
   brittle in gh's responses.
4. Default mode `'active'` (vs previous `'evaluate'`) — since `evaluate` only
   works on Enterprise, it was a misleading default. `active` is the safe
   default for plans that actually reach the script.
