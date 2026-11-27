# Approve a protected pull request from your phone, and see what it is

<!-- bump: patch -->

## What Changed

When one of the agent's pull requests changes a file only the owner may approve on GitHub, the Needs-you row now carries the pull request's title, which protected files it changes, a GitHub link to the changes and the exact version it is at. The dashboard's Development page builds its GitHub links from the merge watcher, so a slow statistics read no longer turns them off.

New, off by default (`github.ownerApproval.enabled`): the owner can approve such a pull request with Face ID in the Instar app. The agent records the approval in the owner's own signed-in GitHub browser profile and calls it done only when GitHub shows a new approval by the owner at exactly that version. Routes: `POST /mobile/permissions/challenge {action: "github-approval", target: "<n>", headSha}`, `POST /mobile/github/approvals/<n>/approve {headSha, challenge, presenceSig}` (answers within 25 seconds, or 202 and the result is read from `GET /mobile/github/approvals/<n>`). Only the agent's own pull requests whose changed files the owner owns can be approved this way; if an approval ever lands on a newer version, the pull request is put on hold at once.

## What to Tell Your User

- **Clear approval rows:** "When a change needs your approval on GitHub, you now see what it is and get a direct link to it, on your phone and on the dashboard."
- **Approve from your phone:** "Once it is switched on for your agent, you can approve such a change with Face ID in the app, and I confirm on GitHub that it landed on exactly the version you saw."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pull request details on approval rows | `GET /needs` items carry `githubUrl`, `prTitle`, `prSummary`, `headSha`, `approveAvailable` |
| Approve a code-owner pull request with Face ID | `POST /mobile/github/approvals/<n>/approve` (owner phone; `github.ownerApproval.enabled`) |

## Evidence

Unit tests for the approval service (availability, live owner-path precheck with last-match CODEOWNERS, GitHub-as-judge verification, wrong-head HOLD, restart reconciliation, secrets on stdin only, the RFC 6238 vector), the needs-row fields, the HTTP pipeline with real device and presence signatures, and an e2e alive test on the production server path. No real pull request was approved during testing.
