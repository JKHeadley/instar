# A real secret scan runs on every pull request; exceptions are exact values only

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

A new GitHub check, Secret Scan (`.github/workflows/secret-scan.yml`), runs on every pull request to main and every push to main. It downloads gitleaks 8.30.1, verifies the archive's sha256, and scans the commits the change adds (`base..head`) with `.gitleaks.toml`, redacting output and failing on a finding.

`.gitleaks.toml` extends the default gitleaks rules with an allowlist of exact values only: each entry is one anchored, escaped literal. `scripts/lint-gitleaks-allowlist-exact.mjs` runs first in the workflow and refuses any `paths`, `commits`, `stopwords`, `targetRules`, custom `[[rules]]`, a second allowlist, a non-literal regex, a duplicate, or `useDefault` off; `--entry <file>` prints the line for a new value. The file starts with the 116 values already in the repository, each checked to be a fixture, placeholder, misread identifier or public fingerprint.

Why: the repository had no secret scan, and on 2026-11-21 a folder-wide exception elsewhere let a planted fake token through. Asked for by the Chief of Staff with the exact-values-only condition.

## Evidence

- `tests/unit/secret-scan-exact-allowlist.test.ts` (new, 11): the escaper matches one value only; the checker refuses path, commit, stopword, rule, non-literal and duplicate exceptions and accepts exact values; the committed config is clean; the workflow pins version and checksum, runs the checker first, scans `base..head`, redacts and fails on a finding.
- gitleaks 8.30.1 over the tree with the config: no leaks. Over a fresh commit with a generated token: 1 leak, exit 1. Over a fresh commit with a listed fixture: no leaks.
