# Side-effects review — dangerous-command-guard gh-pr-merge gate

## What changed

`dangerous-command-guard.sh` (PreToolUse hook on the Bash tool) gains a new
gate block that refuses `gh pr merge` invocations when any PR check is
non-passing.

- The gate runs `gh pr checks <num> --json name,state` (uses the current
  branch's PR if no number is given on the command).
- A check is "ok" iff its state is `SUCCESS`, `SKIPPED`, `SKIPPING`, or
  `NEUTRAL`. Anything else (`FAILURE`, `PENDING`, `QUEUED`, etc.) is
  non-passing.
- `gh pr merge --auto` is allowed through — it's the documented async safe
  path that only fires when checks pass.
- All other shapes (`gh pr merge <num> --squash`, `gh pr merge --admin
  <num>`, no-flag) are gated.
- Pattern match is bounded to command-start boundary (`^`, `;`, `&&`, `||`,
  `|`, `(`, or whitespace), so commands that merely mention "gh pr merge"
  in a string literal (e.g. `echo "fix gh pr merge bug"`) do not trigger.

The gate lives inline in `dangerous-command-guard.sh`, matching the existing
safety-gate pattern (catastrophic / deployment-coherence / risky-commands
blocks). Same content is duplicated in `src/commands/init.ts` (fresh-init
copy) and `src/core/PostUpdateMigrator.ts` `getDangerousCommandGuard()`
(auto-update copy), per the existing parity allowlist in
`migration-parity-hooks.test.ts`.

## Why

This closes the **2026-05-27 PR #539 watch-exit-merge class**. Justin merged
PR #539 (the better-sqlite3 ABI heal) on the back of `gh run watch` returning
exit 0. But `gh run watch` returns 0 on workflow COMPLETION regardless of
conclusion. The PR's branch-protection checks were RED (Type Check + 2 unit
shards failing), and merging on the false-positive watch exit cost:
- A fix-forward (#540) for the green-up of the same change.
- A ~16-hour fleet outage on instar-codey when the ABI-heal regression hit
  production.
- A memory entry (`[feedback_never_merge_on_watch_exit_verify_checks]`)
  warning against the pattern in the future, which is exactly the
  "structure > willpower" antipattern this PR replaces.

Per the post-mortem (PR #545), this is lever E: smallest of the remaining
levers, closes the most embarrassing class. Pure structural enforcement —
no relying on the agent to remember to check.

## Risk surface

- **`gh pr merge --auto` is allowed.** This is the documented async safe
  path — async, fires only when checks pass, idempotent. Allowing it does
  not weaken the gate.
- **Pattern-bounded.** The command-start anchor (`(^|[;&|(\s])`) prevents
  false-positives on string literals, comments, or commands that happen to
  contain the literal phrase.
- **No-PR fallback.** If no PR number is in the command line, the gate
  consults `gh pr view --json number` to resolve the current branch's PR.
  If that fails (e.g. not in a git repo, or no PR exists), the gate
  exits silently — allowing the command. This is the documented behavior
  of `gh pr merge` itself when no PR exists; we don't add new failure
  modes.
- **Skipped-checks tolerance.** `SKIPPED` / `SKIPPING` checks (e.g.
  Contract Tests on non-tagged PRs) are explicitly OK. The most common
  intentionally-skipped case in our pipeline.
- **Default-on for new and existing agents.** New agents get it via fresh
  init; existing agents get it via PostUpdateMigrator's always-overwrite
  rewrite of `dangerous-command-guard.sh` on every auto-update tick.

## Bug surfaces eliminated

- A future "merged on a red CI shard because watch exited 0" incident is
  structurally impossible from the dangerous-command-guard surface.
- `gh pr merge --admin` with red checks is also blocked (the #539 incident
  shape itself).
- `gh pr merge` with PENDING checks (e.g. immediately after a push, before
  CI has fired) is blocked — the agent must wait, OR use `--auto`.

## Migration footprint

`dangerous-command-guard.sh` is on the always-overwrite list (per
`PostUpdateMigrator.migrateHooks`). Existing agents pick up the new gate on
the next auto-update tick — typically within ~30 min of release. No config
schema change, no per-agent migration.

## Testing

- Unit: `tests/unit/dangerous-command-guard-gh-pr-merge-gate.test.ts` — 10
  tests. Two surface checks (both guard writers contain the gate block) +
  eight behavioral checks (spawn the rendered hook with a mocked `gh`
  binary on PATH, verify BLOCK on FAILURE / PENDING, ALLOW on SUCCESS /
  SKIPPED, ALLOW on `--auto`, IGNORE non-`gh pr merge` commands, BLOCK on
  `--admin` with red checks, BLOCK on no-PR-number with red current-branch
  PR).
- `tests/unit/migration-parity-hooks.test.ts` (from PR #545) still green:
  the new gate landed in BOTH writers in lockstep, so no new gap surfaces.
- `tsc --noEmit` clean.

## Follow-ups

- The other post-mortem levers from PR #545's "What Changed" still pending:
  B (real-world-state fixture tests — biggest, separate conversation), D
  (silent-failure ban lint — small, similar shape to PR #542's
  secret-externalization lint).
