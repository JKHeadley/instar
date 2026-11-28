# The public health check no longer includes problem details

<!-- bump: patch -->

## What Changed

SEC-130. `GET /health` is public. It used to return `degradationSummary` (the written notes for recent problems, which are built from runtime values such as local paths, account ids and session names) and `llmReliability` to any caller. Both are now returned only to a caller with a valid bearer token. The public answer keeps `status`, `uptime`, the `degradations` count and the gate route versions, and the `degraded` status still counts both signals.

The built-in health-check job's prompt text now reads `/health` with the agent's token as well, so a health check that runs as a prompt still sees the details. An agent-awareness note's `/health` example shows the token header too.

## What to Tell Your User

- **A quieter public health check**: "My public health check now only says whether I'm OK. The details of what went wrong are only shown to you and my own machines."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Problem details on /health for signed-in callers only | Automatic |

## Evidence

- `tests/unit/health-auth-gating.test.ts` (new case, fails on main): an anonymous and a wrong-token /health has the status and count but no degradation text and no LLM reliability; the bearer read has the text.
- `tests/unit/health-llm-reliability-authed.test.ts` (new, fails on main): with a real feature-metrics ledger, `llmReliability` is only in the bearer answer.
- `tests/e2e/health-detail-authed-alive.test.ts` (new): the same on the real AgentServer.
