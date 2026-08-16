---
name: ci-fix
description: Check instar CI health and fix any failing tests by addressing the root cause — never apply band-aids
metadata:
  user_invocable: "true"
---

# /ci-fix — CI Health Check & Root-Cause Fixer

## Purpose

Monitor the instar CI pipeline on GitHub Actions. When tests fail, investigate and fix the **root cause** in the source code — never just patch the test to make it pass.

## CRITICAL PRINCIPLE

**Fix the code, not the test.** If a test asserts `maxSessions` should be 3 and the production default changed to 10, the fix is NOT to change the test assertion to 10 — the fix is to understand WHY the default changed, whether the test expectation was wrong, and update whichever side is actually incorrect. Tests exist to catch real bugs. Making a test pass by weakening its assertion is worse than leaving it red.

Specifically:
- If a test expectation doesn't match runtime behavior, investigate which side is the source of truth
- If the production code changed intentionally, update the test to match the new intended behavior
- If the production code changed unintentionally (regression), fix the production code
- If a test is testing the wrong thing entirely, fix the test — but document WHY it was wrong
- NEVER disable, skip, or delete a failing test without explicit user approval
- NEVER use `.skip()`, `xit()`, or `xdescribe()` to hide failures
- NEVER weaken assertions (e.g., changing `.toBe(specific)` to `.toBeTruthy()`) to make tests pass

## Steps

### 1. Check CI Status

```bash
cd /Users/justin/Documents/Projects/instar
gh run list --limit 3 --json status,conclusion,name,createdAt,headBranch,databaseId
```

If all recent runs are passing, report success and stop.

### 2. Get Failure Details

For each failing run:
```bash
gh run view <RUN_ID> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
gh run view <RUN_ID> --log-failed 2>/dev/null | tail -200
```

### 3. Identify Root Cause

For each failing test:
1. Read the failing test file to understand what it's testing
2. Read the production code it's testing
3. Check git log for recent changes that may have caused the failure
4. Determine: is the test wrong, or is the production code wrong?

### 4. Fix the Root Cause

- Make the fix in `/Users/justin/Documents/Projects/instar/`
- Run the specific failing test locally to verify:
  ```bash
  cd /Users/justin/Documents/Projects/instar
  npx vitest run <test-file> --reporter=verbose
  ```
- If the fix touches production code, also run the full test suite:
  ```bash
  npm run test:push
  ```

### 5. Commit and Push

- Commit with a clear message explaining the root cause
- Push to trigger CI
- Monitor the new CI run to confirm it passes

### 6. Report

- If fixes were applied: report what was broken, the root cause, and what was fixed
- If CI was already green: report healthy status
- If a fix requires user decision (ambiguous root cause): queue an attention item and message the user

## Skip Ledger

Use the skip ledger to avoid re-investigating failures that are already being worked on:
- Workload ID: `ci-fix`
- Item ID: `run-<RUN_ID>` for each CI run investigated

## Handoff Notes

Write findings to `.instar/state/job-handoff-ci-monitor.md` so the next run knows:
- What was last investigated
- What fixes are pending push
- What's waiting for CI confirmation
