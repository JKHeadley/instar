# Side effects: the public health check no longer includes problem details (SEC-130)

In plain words: `/health` is public. Its written problem notes and its LLM reliability breakdown are now only in the answer to a signed-in caller.

Tier 1. Size: 1 source file (5 lines), 2 new unit cases (one in a new file), 1 new e2e test.

## What changes for running agents
- `GET /health` without a valid bearer token no longer has `degradationSummary` or `llmReliability`. Both move into the existing `isAuthed` block, next to `degradationFeatures`.
- Unchanged for everyone: `status` (still `degraded` when there are recent degradations or LLM reliability is not ok), `uptime`, `uptimeHuman`, the `degradations` count, `gateRouteVersion` and `gateRouteMinimumVersion`.
- Unchanged for signed-in callers: they get both fields as before. When no `authToken` is configured, every caller counts as signed in (`bearerMatches`), so local setups without a token see no change.

## Who reads these fields
- The built-in health-check job script sends the bearer token and already fails a run that comes back without the signed-in fields.
- The dashboard sends its token on every `/health` read, and no dashboard page reads either field.
- The peer health read used for the pool (`serverHealthFromResponse`) does not read either field.
- The mobile health summary (`healthIssues.ts`) is computed server-side.

## Signal vs authority
Read-side disclosure only. It grants nothing and blocks nothing; the degraded signal stays public.

## Rollback
Revert the commit. No state change.

## Tests
- `tests/unit/health-auth-gating.test.ts`: 5 pass, 1 new (fails on main). Anonymous and wrong-token reads have the status and count but no `degradationSummary`, no `llmReliability`, and none of the note text; the bearer read has the notes.
- `tests/e2e/health-detail-authed-alive.test.ts` (new): the same against the real AgentServer. Not run on the M5, per the machine rule.
- Also pass: `server`, `middleware`, `mobile-health-issues`, `job-scripts/health-check`.
- `tests/unit/health-llm-reliability-authed.test.ts` (new, fails on main): a real FeatureMetricsLedger with a failing component behind the real route and a configured token. Anonymous and wrong-token reads say `degraded` but carry no `llmReliability` and no component name; the bearer read carries the component.

## Follow-up (not in this PR)
The health-check job's prompt body (its rollback and narrator path) reads `/health` without the bearer token, so a health check run as a prompt rather than as its script misses the notes that are now signed-in only. Tracked as commitment CMT-022 on the M5 (m_a804869356): its own tier-1 PR with a migration step, opened by 2026-11-24 17:00 PST.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given only the diff and the problem statement), 2026-11-21. Verdict: concur, no blocking findings. It confirmed that nothing else in the public answer carries text built from degradation events (`bootReadiness` keeps `previousRestart` signed-in only), that the pool variant needs sign-in and does not forward these fields, that the job script, the mobile health route and the dashboard all sign in, and that the degraded status is computed before the split. Non-blocking notes: `llmReliability` had no test that wires the ledger (fixed: new test with a real ledger), the health-check prompt path (CMT-022), and the shared reporter leaking across tests (fixed: both new tests reset it).

## Repair after Local Verify (2026-11-23)
The full run failed `tests/e2e/health-detail-authed-alive.test.ts`. The test boots the real server with a stand-in session manager that had no `getCachedRunningSessions`, and the health route calls that first, so every `/health` read in the test errored before reaching the checks. The stand-in now has it, the same way the other end-to-end tests that read `/health` set it up (for example `internal-llm-component-reliability-lifecycle`). The route change is unchanged. The end-to-end file is not run by hand on the M5 (standing rule); Local Verify runs it. The branch was also brought up to date with main.
