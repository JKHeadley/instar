# ELI16 — The PR watcher explains when its branch prefix cannot match

The green-PR watcher looks only at pull requests authored by the authenticated
GitHub account, then narrows that list to branches owned by one agent prefix.
Until now that prefix was silently borrowed from the project name. An agent
named `instar-codey` that consistently creates `agent/...` branches would see
open PRs, reject every one, and report the same result as an empty repository.
An empty expected GitHub login made it inert for a second silent reason.

The branch prefix is now an explicit optional setting, separate from project
identity. Existing installations retain their project-name fallback. When an
authored open-PR list is non-empty but every branch falls outside the configured
prefix, the watcher records a mismatch episode, raises its existing aggregate
attention signal, exposes examples in status, and a manual tick returns
`namespace-mismatch`. Missing GitHub identity now refuses watcher startup with
a named configuration issue. This change does not enable the watcher or grant
merge authority; the existing PIN-gated enablement decision remains unchanged.
