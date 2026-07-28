# Throughput GitHub Runtime Repair — Plain-English Overview

> The one-line version: the Throughput chart and its neighboring GitHub jobs now use an explicit agent-owned GitHub identity and no longer depend on the Mac's login shell or somebody else's GitHub session.

## The problem in one breath

The Throughput tab was present, but its server request failed every time in production. The server starts in the background with a smaller command search path than an interactive terminal, so it could not find the Homebrew-installed GitHub program. Worse, if it did find the program, it could silently act as whichever person last signed into GitHub on that Mac.

## What already exists

- **The Throughput chart** — shows merged work, speed, quality, output, and a composite score.
- **The agent secret vault** — can hold a `github_token` without placing it in source code.
- **The Green-PR safety ladder** — checks eligibility and delegates the final operation to the guarded merge script.
- **The CI failure poller** — reads failed GitHub runs for the failure-learning loop.

## What this adds

Throughput now talks directly to GitHub's structured API. It uses only a token explicitly supplied to the server or stored in the agent's vault. If neither exists, the route says that GitHub authentication is unavailable and stops; it does not borrow the Mac owner's login.

The two jobs that still need the GitHub command-line program share one resolver. That resolver finds the Homebrew binary by absolute path, attaches the explicit agent token, and passes the same identity into the guarded merge child. It briefly caches the answer so periodic jobs do not repeatedly unlock the vault.

## The safeguards

**Prevents the wrong identity from being used.** There is no lookup of the GitHub CLI's global login and no unauthenticated fallback. Both token variables are set explicitly for every remaining child process.

**Prevents plausible but incomplete charts.** GitHub Search reports how many matches exist. The server verifies that number, refuses windows beyond the provider's 1,000-result ceiling, and refuses if pagination returns fewer rows than promised.

**Keeps calendar days honest.** Daily buckets use the real Los Angeles timezone, including daylight-saving changes, instead of assuming the coast is always seven hours behind UTC.

**Keeps autonomous merge authority unchanged.** The repair supplies a trustworthy runtime identity; it does not weaken protected-path checks, CI checks, head pinning, leases, or the final guarded merge script.

## What ships when

This is one repair release because partial shipment would leave a known identity hole. Code, tests, review artifacts, and release notes land together. The merge is not the final done claim: after deployment, Echo must load the real Throughput chart at desktop and phone widths and confirm live chart data.

## What you actually need to decide

The approved shape is: direct authenticated GraphQL for Throughput, one explicit authenticated CLI runtime for the two unavoidable CLI consumers, and fail-closed behavior whenever identity or data completeness cannot be proven.
