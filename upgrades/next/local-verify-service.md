## What Changed

- **local-verify: the server can run the full test suite on a pull request's merge with `main` and keep the result** (spec `docs/specs/local-verify-merge-authority.md` §2, piece 2 of 4). New `src/localVerify/` (inventory and lanes, report evaluation, a parser-based skip/removal ratchet, the harness-changing classifier, the run orchestrator and its child entry, `LocalVerifyService`) and routes `POST /local-verify` (`{"pr":N}` only), `GET /local-verify`, `GET /local-verify/record`. Each run uses a private bare clone under `<agentHome>/.worktrees/.verify/`, `merge-tree` + `commit-tree` of base and head, `npm ci`, the build, the `npm run lint` list and the three test lanes with `--allowOnly=false`, under per-step deadlines. Results go to a durable journal that survives restarts. Only PRs from the agent's or the operator's GitHub login, from this repository, are verified. `SafeGitExecutor` (`localVerifyCloneOk`) and `SafeFsExecutor` (`localVerifyScopeOk`) gain carve-outs scoped to `.worktrees/.verify/`. Off by default (`monitoring.localVerify.enabled`); 503 with no instar source checkout; 409 on a standby. Nothing reads a record yet: posting the pass/fail mark and the merge-tool changes are the next pieces.

## What to Tell Your User

Nothing changes for you yet. This is the part of the "stop waiting on GitHub" work that lets me run the whole test suite myself on exactly the code a change would merge. It's switched off until the rest is built and you approve the switch.

## Summary of New Capabilities

- `POST /local-verify`, `GET /local-verify`, `GET /local-verify/record` (instar source checkouts only, off by default).

## Evidence

- Unit: `tests/unit/localVerify/` (inventory, lane report, skip ratchet, harness classifier, record, orchestrator with fake seams, service queue/retry/journal/orphan protocol, the git carve-out against real git, routes). Includes a real-git regression for the false directory-rename conflict found on the first real run (PR 2247).
- Integration: `tests/integration/local-verify-routes.test.ts` (503, standby 409, body validation, 403, queue → record → 200).
- E2E: `tests/e2e/local-verify-lifecycle.test.ts` (built through `buildLocalVerifyService`, booted, 200; each inert reason → 503).
