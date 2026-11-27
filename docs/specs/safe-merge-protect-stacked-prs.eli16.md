# Keep dependent pull requests open when their parent merges

A pull request can be built on another pull request's branch. It targets that branch so reviewers can see just the new work while the parent is still waiting to merge. When the parent merges, the old branch can be deleted. We observed GitHub close a dependent pull request when its base branch went away, leaving the team to republish it and rediscover it for verification.

Immediately before a parent merge, the merge tool now checks for open pull requests that use the parent's branch. It changes those requests to target main, keeping their commits and draft status. It confirms each change, leaves a note on each affected request, and checks the old branch again before merging. If GitHub cannot confirm that the dependent requests have moved, the parent merge waits. The normal verification and approval checks still apply to each child against its new base.
