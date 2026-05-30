---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "Please proceed as you best to see fit" — my judgment-call to ship lever E next per the post-mortem ordering I proposed)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Pipeline post-mortem lever E: `dangerous-command-guard.sh` now refuses
`gh pr merge` when any PR check is non-passing.**

Closes the 2026-05-27 PR #539 watch-exit-merge class — `gh run watch`
returns exit 0 on workflow completion regardless of conclusion, which
caused PR #539 to merge with red unit-test shards (cost a fix-forward
#540 + a ~16h fleet outage on instar-codey when the ABI-heal regression
hit production). The memory entry afterward
(`[feedback_never_merge_on_watch_exit_verify_checks]`) tried to prevent
recurrence via convention; this PR replaces that convention with a
structural gate.

The gate runs `gh pr checks <PR> --json name,state` before allowing the
merge and refuses if any check is in `FAILURE`, `PENDING`, `QUEUED`, or
similar non-passing state. `SKIPPED` / `SKIPPING` (e.g. Contract Tests
on non-tagged PRs) are explicitly OK. `gh pr merge --auto` — the
documented async safe path — is allowed through unchanged.

Pattern matching is bounded to command-start boundaries so commands that
merely mention `gh pr merge` in a string literal (`echo "fix gh pr merge
bug"`) do not trigger.

## What to Tell Your User

Nothing visible in normal operation. The agent now refuses to merge a PR
while any CI check is failing or pending — even with `--admin`. If you
want async-merge behavior (auto-fire when all checks pass), use
`gh pr merge --auto` and the gate will allow it through.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `gh pr merge` refused when any check is non-passing | Automatic. The Bash PreToolUse hook intercepts the command, runs `gh pr checks`, and blocks if anything is FAILURE / PENDING / QUEUED. |
| `gh pr merge --auto` allowed through | Use it as the safe async gate. Only fires when checks pass. Documented behavior of `gh` itself. |
| `--admin` does not bypass | The #539 incident shape itself: `gh pr merge --admin <num>` with red checks now blocks. |

## Evidence

- 10 new unit tests covering both writers (init.ts + PostUpdateMigrator)
  for content, plus eight runtime-behavior tests that spawn the rendered
  hook with a mocked `gh` binary on PATH (BLOCK on FAILURE, BLOCK on
  PENDING, ALLOW on SUCCESS, ALLOW on SKIPPED, ALLOW on `--auto`, IGNORE
  non-`gh pr merge` commands, BLOCK on `--admin` with red checks, BLOCK
  on no-PR-number with red current-branch PR).
- Migration-parity test from PR #545 still green — the new gate landed in
  BOTH writers in lockstep.
- `tsc --noEmit` clean.
- Side-effects review:
  `upgrades/side-effects/dangerous-command-guard-gh-pr-merge-gate.md`.
