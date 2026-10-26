# Merge line accepts the agent's own PRs by author; a restart without a new message resumes in-flight work

## What Changed

- `src/monitoring/greenPrLogic.ts` → new `agentOwnership()`: a PR is the agent's own when its branch is in the agent namespace OR it was opened by `expectedGhLogin` on a same-repository head; a fork is refused before either rule. `classifyCandidate`, the watcher's gather / hand-off / verify requests / red-PR watchdog / namespace-mismatch signal, and `holdEligible` all use it. Before, any branch not starting with `echo/` was skipped silently, so verified PRs on `fix/`, `chore/`, `feat/`, `docs/` branches never merged.
- The `gh pr list` projection requests `author` and `isCrossRepository`. A listed PR still refused is audited once per head (`skipped:not-agent-owned`) and exposed as `notAgentOwnedCount` / `notAgentOwned` on `GET /green-pr-automerge`.
- `src/core/handoffContinuation.ts` + `spawnSessionForTopic`: a respawn with no new user message (a model/framework switch, a triage restart) no longer says "wait silently". The new session answers an unanswered latest message, resumes work the conversation shows as unfinished (after checking a later stop and whether it already happened), sees the topic's open commitments tagged resumable / waiting on the user, and waits quietly only when nothing is in flight. It is told not to mention the switch.
- CLAUDE.md Green-PR section: one line on which PRs count as the agent's own (migrated via the existing section re-sync, marker `notAgentOwnedCount`).

## What to Tell Your User

- If I'm the agent that develops Instar: my finished pull requests now get merged automatically even when their branch name doesn't start with my name, as long as I opened them from this repository. Anything I still skip shows up on the merge status page instead of being silently ignored.
- When I'm restarted on a different model or after getting stuck, I now pick up whatever I was in the middle of, instead of waiting for you to message me again. I won't announce the restart.

## Summary of New Capabilities

| Capability | How to use |
|-----------|-----------|
| Own PRs on any branch prefix are merge candidates | automatic; check `GET /green-pr-automerge` → `notAgentOwnedCount` |
| Restarted sessions resume in-flight work | automatic on a no-message respawn |

## Evidence

Unit (`merge-line-author-eligibility`, `handoff-continuation`, wiring, migrator), integration (`green-pr-automerge-routes`), and e2e (`merge-line-author-eligibility-lifecycle`, production wiring, 200 with an own `chore/` PR as a candidate and a fork in `notAgentOwned`) all pass.
