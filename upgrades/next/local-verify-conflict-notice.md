# Local verify: a PR that no longer merges into main says so

## What Changed

- `src/localVerify/LocalVerifyService.ts`: a verify that finds the PR head no longer merges into its base (`error:conflict`) is not re-run (the answer cannot change for the same two commits). The PR is listed under `conflicts` on `GET /local-verify`, and a new `onConflict` seam opens one notice per (PR, head) and resolves it when a new head is queued, a later verify of the PR is not a conflict, or the PR is closed. Open conflicts are rebuilt from the results journal at boot. Before, the PR left the queue silently while GitHub auto-merge waited on a check that could never pass (PR #2363, fb-7838de2d-178).
- `src/localVerify/statusProjection.ts`: the `instar/local-verify` status for such a head reads "no longer merges into main — rebase needed (base abc1234)" (reason `merge-conflict`) instead of a generic error label.
- `src/commands/server.ts` + `src/localVerify/localVerifyWiring.ts`: the notice is one agent-raised attention item, `local-verify:conflict:<pr>:<head7>`, closed (DONE) on resolve.
- CLAUDE.md template and migration: one line in the Local Verify section.

## What to Tell Your User

- If I'm the agent that develops Instar: when one of my pull requests can no longer be merged because another change touched the same lines, I now get one clear notice saying it needs a rebase, and the pull request page says so too. Before, it just sat there waiting.

## Summary of New Capabilities

| Capability | How to use |
|-----------|-----------|
| PRs that no longer merge are listed | `GET /local-verify` → `conflicts` |
| One attention item per conflicting PR head, closed by a rebase | automatic |

## Evidence

Unit `tests/unit/localVerify/conflictNotice.test.ts` (12) and integration `tests/integration/local-verify-conflict.test.ts` (2) pass, along with the existing `LocalVerifyService`, `statusProjection` and `local-verify-routes` suites.
