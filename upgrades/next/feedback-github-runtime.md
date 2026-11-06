# Feedback workers keep their own GitHub sign-in

## What Changed
Feedback sorting and fix delivery now use the agent’s explicit GitHub credential for repository reads, trusted publishing, merge checks, cancelling automatic merges and release lookup. A server no longer falls back to a stale machine-wide GitHub login. Credential rotation is picked up by the existing bounded runtime cache. The sandbox and independent review rules are unchanged.

## What to Tell Your User
Feedback workers can keep working after their GitHub credential is refreshed. Routine fixes still pass independent review before merging.

## Summary of New Capabilities
- Feedback’s existing GitHub operations consistently use the agent’s own credential, including after server restart.

## Evidence
Unit: tests/unit/feedback-factory/execute-github-runtime.test.ts. HTTP: tests/integration/feedback-github-runtime-routes.test.ts. Production startup/restart: tests/e2e/feedback-github-runtime-alive.test.ts.
