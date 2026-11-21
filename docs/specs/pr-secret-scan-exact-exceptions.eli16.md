# A real secret scan on every pull request, with exceptions for exact values only — Plain-English Overview

> The one-line version: every pull request now gets scanned for leaked secrets by gitleaks, and the only way to excuse a finding is to list that one exact value, never a folder or a file.

## The problem in one breath

The agent software repository had no dedicated secret scan. The only guard was one lint rule that looks for credential writes that bypass the secret store, which does not look for pasted tokens, keys or passwords in the code itself. On the morning of 21 November 2026 another session found that a secret scan with a folder-wide exception, meaning "ignore everything under this folder", let a planted fake token through, because the token happened to sit in an excused folder. A scan that can be switched off for whole folders is not a scan.

## What already exists

- **gitleaks** — a widely used open-source scanner that reads commits and reports strings shaped like API keys, tokens, private keys and passwords. It ships with a set of detection rules and accepts an exceptions file.
- **The credential-write lint** — one of the 55 lint steps, already run on every pull request and before every commit. It checks how code writes credentials, not whether a secret value is present.
- **Local Verify and the fast GitHub checks** — the test line and the lightweight pull request checks. Neither scans for secret values.

## What this adds

A new GitHub check called Secret Scan runs on every pull request to main and on every push to main. It downloads a pinned release of gitleaks, checks the download against a known checksum so a swapped binary fails rather than silently scanning with different rules, and scans only the commits the pull request adds. A finding fails the check and tells the author what to do: rotate the secret and remove it if it is real, or add the exact value to the exceptions file if it is a fixture or a placeholder.

The exceptions file, `.gitleaks.toml`, may list exact values only. Each entry matches one specific string and nothing else. A small checker, run first in the same workflow, refuses the file if it contains a path, folder, file, rule or commit exception, a pattern that could match more than one value, a disabled default rule set, or a duplicate. The checker also prints the correctly escaped line for a new exception, so authors do not have to escape values by hand.

The file starts with the 116 distinct values gitleaks already finds in the repository today. Every one was looked at: they are test fixtures, documentation placeholders, identifiers gitleaks misreads as keys, and public fingerprints in verification logs. None is a live secret.

## The safeguards

- **No wide exceptions, enforced in code.** The rule "exact values only" is checked by a script, not by review. A folder exception fails the pull request before gitleaks even runs.
- **Pinned scanner.** The gitleaks version and its checksum are in the workflow. Updating the scanner is a visible change to that file.
- **Scans what changed.** The scan covers the pull request's own commits, so an existing fixture elsewhere in the repository cannot block an unrelated change, and the exceptions file keeps today's fixtures from blocking edits to the files that hold them.
- **Fast.** Downloading and running gitleaks over a pull request's commits takes well under a minute, so this adds almost nothing to GitHub's queue.
- **Reversible.** Deleting the workflow file, the checker and the exceptions file restores the previous state; no agent state or data changes.

## What ships when

The check is active for every pull request as soon as this change lands on main. It is not a required status check in the repository rules, so it reports red without blocking a merge by itself; the agent's merge step treats a red check as a reason to stop.

## What you actually need to decide

Nothing. The Chief of Staff asked for this on 21 November 2026 after the folder-exception escape was found, with the exact-values-only rule as its condition.
