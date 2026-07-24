# Throughput GitHub runtime repair

## What Changed

The Throughput server now calls GitHub GraphQL directly with an explicit
agent-owned token instead of starting a bare `gh` subprocess. The remaining
server-side CLI consumers share one absolute-executable, explicit-token runtime,
including the guarded Green-PR merge child.

## What to Tell Your User

The Throughput tab can load real chart data when the agent has `GITHUB_TOKEN` or a
vault `github_token`, even when the server runs in the background with launchd's
restricted PATH. It will report authentication unavailable instead of silently
using another person's GitHub login.

## Summary of New Capabilities

- Uses direct authenticated GraphQL for Throughput.
- Fails closed on missing identity, incomplete Search pagination, or provider
  result ceilings.
- Uses real Pacific timezone boundaries in both standard and daylight time.
- Gives CI polling and Green-PR reads/actuation one shared explicit GitHub runtime.

## Evidence

The focused runtime, route, pagination, timezone, CI, and Green-PR suites pass 68
tests. TypeScript and repository lint pass. Independent security, integration, and
throughput reviews were folded into the converged design. Final release evidence
also requires post-deployment desktop and phone verification with real chart data.
