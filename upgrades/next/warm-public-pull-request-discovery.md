# Keep the public pull request inventory ready

<!-- bump: patch -->

## What Changed

On an explicitly enrolled development installation, the server starts fetching the public Instar pull request inventory when it opens. Work and Chief of Staff share that inventory. The first authorized lookup can wait for a healthy initial scan. Once earlier observations are available, the lookup can return them promptly and shows when they were checked.

The installation keeps a rolling record of the requests it has charged so a restart does not reset its allowance. The record does not contain pull request content, queries, or credentials.

## What to Tell Your User

The first time you search for earlier work after the server starts, Work can wait for the public pull request inventory to finish loading. It stays responsive while the search runs and tells you when the evidence is older or unavailable.

## Rollout

Enrollment requires the exact development machine identity, installed state directory, an active instance lock, an initialized local budget, and an explicit enabled setting. Pausing warming returns the installation to the earlier request-triggered path when its budget record is present and valid. The operational allowance and provider throttling still apply. Wider rollout depends on verifying GitHub traffic and cold and warm searches on the nominated development installation.

## Summary of New Capabilities

An explicitly nominated development installation can warm the existing public pull request inventory at startup and refresh it within a durable usage budget.
