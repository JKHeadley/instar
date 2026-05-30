# vNEXT — plain English overview

## What this change is

Yesterday Justin merged a pull request (PR #539) on the back of a
GitHub CLI command exit code that looked successful. The catch: that
command (`gh run watch`) returns "success" when the workflow is FINISHED,
regardless of whether the tests passed or failed. The workflow had
finished with red unit-test shards. The merge went through anyway. We
spent the next 16 hours dealing with the resulting fleet outage and
shipped a follow-up PR (#540) to fix the damage.

We wrote a memory note afterward saying "don't merge on watch exit;
verify with `gh pr checks` first." That's a willpower fix — it works
until the next time someone forgets, which will happen.

This PR replaces the willpower fix with a structural one: the agent's
dangerous-command-guard hook now intercepts any `gh pr merge` command,
queries the PR's check status via `gh pr checks`, and refuses to run
the merge if anything is failing or pending. The agent literally
cannot run a bad merge command from the Bash tool — the hook blocks
it.

## What already exists

- `dangerous-command-guard.sh` — a PreToolUse hook on Bash that already
  refuses catastrophic commands (`rm -rf /`, `mkfs.`, etc.) and risky
  commands (`git push --force`, etc.) under safety.level 1.
- `gh pr checks` — the CLI command that returns the live state of all
  branch-protection checks on a PR.

## What's new

- A new block in `dangerous-command-guard.sh` that fires when
  `gh pr merge` is detected at a command boundary.
- The block calls `gh pr checks <num> --json name,state` and refuses
  the merge if any state is `FAILURE`, `PENDING`, `QUEUED`, or similar.
- `SUCCESS`, `SKIPPED`, and `SKIPPING` are explicitly OK — those are
  the intentional pass / intentional-skip states.
- `gh pr merge --auto` (the documented async safe path) is allowed
  through unchanged. That command only fires when checks pass; it's
  the right way to do an "I'm done, merge when ready" workflow.
- 10 unit tests, including realistic scenarios — the actual hook is
  spawned with a mocked `gh` binary on PATH so the behavior is
  end-to-end tested, not just static-analyzed.

## What you need to decide

Nothing. Pure structural enforcement. Existing agents get the new gate
on the next auto-update tick (every ~30 min).

## How to verify it worked after deploy

In Bash, try to invoke `gh pr merge <num>` against a PR that has any
pending or failing check. The agent will see a BLOCKED message in
stderr with the list of non-passing checks. Try the same command with
`--auto` appended — it goes through cleanly (because `--auto` is the
documented safe path).

## Why this matters more than it might look

This is the third post-mortem fix landing today (after #545 and #550).
Each one closes a class — not just one incident. The PR #539 class is
arguably the most embarrassing of the three, because the human
component of the loop (the agent or a human picking the merge command)
had been advised to verify checks first and didn't — willpower failed.
Structural enforcement closes that loop. The agent will not be ABLE
to merge a red PR from Bash, even on autopilot, even with `--admin`.
