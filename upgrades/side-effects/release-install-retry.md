# Release Installation Retry Side Effects

## Summary
Tier 1: narrow, reversible workflow repair. The Linux publisher's npm ci step gets three total attempts with 15 and 30 second waits. Five source and documentation files; one independent review round, no spec convergence required for Tier 1. Built from fresh origin/main, version 1.3.1989, remote https://github.com/JKHeadley/instar.git. One commit attempt planned.

## Decision-point inventory
Modify dependency-install success handling in .github/workflows/publish.yml. The existing npm result remains authoritative; only two recovery attempts are added. No publishing or account-authority decision changes.

## 1. Over-block
No newly rejected inputs. A consistently failing install still stops the release; permanent failures take two extra attempts and 45 seconds of backoff.

## 2. Under-block
Persistent network failures still stop the release. Installation lifecycle scripts may execute three times; npm ci restores the dependency tree each time. This does not retry build, npm publish or the smoke test.

## 3. Level-of-abstraction fit
The workflow owns its dependency preparation. An inline loop avoids a new downloaded action and preserves the existing command and lockfile.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. No new heuristic authority: the command's concrete success or failure controls continuation, with the final failure status preserved. Warnings name the attempt and delay.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Three is an execution bound, not a classification of source or user intent.

## 5. Interactions
The existing workflow concurrency group remains in force. The loop precedes the build and all publishing steps. No shared state, parallel retry or feedback loop is added. npm's own request retries remain possible within each npm ci execution.

## 6. External surfaces
The registry may receive up to three installations per failed release preparation. Workflow logs expose failures and waits. Provenance and publishing permissions are unchanged.

## 7. Multi-machine posture
GitHub-hosted release job only, by design. No agent-local or replicated state is introduced; all machines consume the same published package.

## 8. Rollback cost
Revert the workflow change. No data migration, credential changes or local machine repair.

## Verification and independent review
Five focused tests passed. Tests parse the actual workflow and execute its Bash block under -e -o pipefail, covering success on attempts one, two and three, exhausted failure and final status preservation, plus wiring before build and unchanged publication. Independent reviewer retry_review concurred and separately exercised all four behavior cases. Complete Local Verify is required before merging.
