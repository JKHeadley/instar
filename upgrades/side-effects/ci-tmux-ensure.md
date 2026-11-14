# Side-Effects Review — bounded CI tmux setup

**Version / slug:** `ci-tmux-ensure`  
**Date:** `2026-11-01`  
**Author:** Echo  
**Second-pass reviewer:** Independent CI workflow safety reviewer — concurred after one fix

## Summary of the change

The three tmux setup steps in `.github/workflows/ci.yml` first check for the binary. They run apt only when it is absent, with a 180-second timeout and ten-second forced-stop grace period on update and install, then require `tmux -V` to succeed. This is a reversible CI workflow change; it does not change runtime code or test selection.

## Decision-point inventory

- Runner setup — changed for the unit matrix, integration, and E2E jobs.
- Test and merge authority — unchanged; a failed setup remains a red required check.

## 1. Over-block

If tmux is absent and package setup legitimately needs more than about 190 seconds per command, the job fails earlier than before. That threshold can be adjusted from CI evidence. A failure is explicit rather than a six-hour wait.

## 2. Under-block

An existing binary is accepted only after `tmux -V` succeeds. Tests and working-tree checks still run unchanged. No required status check is skipped.

## 3. Level-of-abstraction fit

The failure is in GitHub runner preparation, so the fix lives in the CI workflow. No agent runtime migration or API surface is involved.

## 4. Signal vs authority compliance

The setup step cannot green a PR. Full CI checks and the independent Local Verify result still gate merge.

## 5. Interactions

The three jobs each have independent runners, so each performs its own check. On runners with tmux installed, this avoids package network traffic. On runners without it, apt still installs tmux but with bounded waits. The separate parallel-tier change may start these jobs together and remains independently reviewable.

## 6. External surfaces

GitHub job step name changes from “Install tmux” to “Ensure tmux.” Required job names, branch protection, release package, and user-facing behavior do not change. A transient package outage may now produce a prompt red check that needs a rerun.

## 7. Multi-machine posture

These are GitHub-hosted jobs; Studio, Mini, and M5 local verifier slots and peer state are unaffected.

## 8. Rollback cost

A normal revert restores the old install step. No state or data migration is needed.

## Verification

Parse the workflow YAML, check that only the three setup steps changed, and run the repository's CI gates on the PR. The live PR run must show `tmux -V` followed by tests, or an explicit bounded setup failure. The three long-running historical jobs are evidence of the prior failure mode; they cannot retroactively benefit from this change.

## Second-pass review

**Reviewer:** Independent CI workflow safety reviewer

The reviewer concurred that required checks and test commands remain authoritative, and found that `timeout 180s` alone may wait indefinitely for a process that ignores SIGTERM. I added `--kill-after=10s` to both apt commands and made the documented upper bound approximately 190 seconds per command. Hosted-runner behavior remains to be confirmed by the PR run.
