# ELI16 PR gate reads the live PR — Plain-English Overview

## The problem in one breath

Every pull request on instar must carry a plain-English "ELI16" section in its description, and a GitHub check called `eli16` enforces that. The check read the description from the snapshot GitHub saved when the run started. If someone later fixed the description and then re-ran an OLD run, that run judged the OLD description again and turned red, even though the PR was now fine. That stale red can block a merge on any agent that waits for GitHub's checks (PR #2059 hit this).

## What already exists

Echo's own merge path already re-reads the live description before it merges, so Echo was not blocked by this. Agents that use the default GitHub-checks path were.

## What this adds

The check now asks GitHub for the PR as it is right now (title, description, author type) and judges that. It only falls back to the saved snapshot if GitHub can't be reached, and the log line says which one it used (`source=api` or `source=payload`).

## The new pieces

- One small function in the check script that reads the live PR, with a fallback to the snapshot.
- The workflow passes the PR number and a read-only token, and asks for read access to pull requests.
- Tests: a snapshot that fails plus a live description that passes now gives a pass and logs `source=api`. The fallback cases are covered too.

## The safeguards

The check never gets looser: it applies the same rule, just to the current text. If the live read fails, it behaves exactly as before. The token can only read. The live read happens only inside a GitHub Actions run, so when someone checks a description on their own machine, the check still judges the text they gave it.

## What ships when

All of it in one PR. Nothing changes for end users; this is CI for instar's own repo.

## What you actually need to decide

Nothing. This is a small CI fix inside an approved proposal (EVO-026).
