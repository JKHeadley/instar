# Side-Effects Review — eli16 PR gate judges the live PR, not the frozen payload

**Version / slug:** `eli16-gate-live-pr-body`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent general-purpose subagent (fresh context, given the code)`

## Summary of the change

Tier 1, 3 code files (+ these artifacts), about 60 lines of script, 6 lines of workflow, 120 lines of tests. Effort: no spec review rounds (Tier 1, narrow fix under approved EVO-026), first commit attempt. `scripts/eli16-pr-description-check.mjs` gains `resolvePrFields()`, which re-reads the PR from `GET /repos/{repo}/pulls/{number}` with the run's token and returns its title/body/user.type (`source=api`), falling back to the PR_BODY/PR_TITLE/PR_AUTHOR_TYPE payload env only when the read is impossible or fails (`source=payload`, with the reason logged). `.github/workflows/eli16-pr-gate.yml` passes `PR_NUMBER` and `GITHUB_TOKEN` and adds `pull-requests: read`. The pass/fail rule (`checkPrDescriptionEli16`) is unchanged.

Optional item 2 of the brief (a hint in safe-merge's refusal when a later same-SHA eli16 run passed) was considered and not built: safe-merge already keeps the latest-COMPLETED run per check name (`latestCheckRows` orders by `completedAt`), and with this fix any re-run judges the live body, so the stale-red source the hint would describe is removed at its root. Adding text for a case that can no longer arise would be dead surface.

## Decision-point inventory

- `eli16` CI check (`.github/workflows/eli16-pr-gate.yml`) — modify — same rule, input is now the live PR instead of the event snapshot.

---

## 1. Over-block

No new over-block. The previous over-block (a stale red on a re-run after the body was fixed) is what this removes. A PR whose live body is good now passes regardless of which run is re-run.

## 2. Under-block

If the API read fails, the check judges the payload as before, so the old stale-red can still occur in that degraded case; it is visible in the log as `source=payload`. A body edited to REMOVE the overview after a green run is now caught by any re-run (previously a re-run would re-judge the old good body); the `edited` trigger already caught it on edit.

## 3. Level-of-abstraction fit

Right layer: the check itself chooses what to judge. Doing the read in the script (not as a separate `gh` step) keeps it unit-testable and reuses the same pure rule. safe-merge's local floor already does an equivalent fresh read; this aligns the Actions floor with it.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

The check's authority (a required CI context) is unchanged; only its input source changes to the authoritative current state.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Live-over-snapshot is an invariant (judge the current artifact).

## 5. Interactions

`scripts/safe-merge.mjs` imports only the pure `checkPrDescriptionEli16` (unchanged); `tests/unit/pull-request-template-gates.test.ts` does the same, and `tests/unit/merge-runner.test.ts` only names the script file. `src/commands/devPreflight.ts` runs the CLI with its own environment merged in; the live read happens only when `GITHUB_ACTIONS=true`, so a local `dev:preflight --body <file>` always judges the file it was given, even in a shell that carries PR_NUMBER/GITHUB_TOKEN (raised by the second-pass reviewer, fixed). safe-merge's local floor (`runLocalBodyChecks`) does its own fresh read and is unaffected. The floor-drift canary pins the workflow path and context name `eli16`; neither changes.

## 6. External surfaces

One extra GitHub API GET per eli16 run, with the run's own token (read-only scope). Fork PRs get a read-only token too, which can read public PRs. No change for end users or other agents' runtimes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface. The CI log gains one `source=` line.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: runs on GitHub's runners, no agent state.

## 8. Rollback cost

Revert the PR. No state, no migration.

## Conclusion

Safe to ship: same rule, fresher input, unchanged fallback.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, fresh context, given the diff and the code (not this artifact's conclusion), 2026-11-11 01:12 PST.

Concur with the review. Verified the API call, auth, `pull-requests: read`, fork-PR read-only tokens, re-runs getting a fresh token, digits-only PR number, top-level await inside the CLI `if`, that the fallback cannot loosen the gate, that no body or token is logged, and that both new tests fail on the old code. Two minor notes, both addressed: (1) `devPreflight.ts` merges the surrounding env, so a shell with PR_NUMBER/GITHUB_REPOSITORY/GITHUB_TOKEN would have judged the live PR instead of the local body file. Fixed by reading live only when `GITHUB_ACTIONS=true`, with a test. (2) §5 named a non-existent `scripts/merge-runner` and omitted devPreflight. Corrected.

## Evidence pointers

`npx vitest run tests/unit/eli16-pr-description-check.test.ts` → 17/17 pass (the not-in-Actions case is added to the fallback test), including the CLI run against a local API server logging `source=api` and exiting 0 with a failing payload body.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
