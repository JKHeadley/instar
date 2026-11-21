# Side-Effects Review — a real secret scan on pull requests, exceptions for exact values only

**Version / slug:** `pr-secret-scan-exact-exceptions`
**Date:** `2026-11-21`
**Author:** `echo (session echo-increasing-throughput)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. Four new files, no runtime source changed: `.github/workflows/secret-scan.yml` (a Secret Scan job on every pull request to main and push to main: pinned gitleaks 8.30.1 with sha256 check, scanning `base..head` with `.gitleaks.toml`), `.gitleaks.toml` (default rules plus an allowlist of 116 exact values, one anchored escaped literal each), `scripts/lint-gitleaks-allowlist-exact.mjs` (refuses any path, folder, rule, commit, stopword or non-literal exception; prints the line for a new exact value), and `tests/unit/secret-scan-exact-allowlist.test.ts` (11 tests). Effort: one review round, one commit attempt.

## Decision-point inventory

- `Secret Scan GitHub check` — add — fails a pull request when gitleaks finds a secret-shaped string in its commits that is not an exact-value exception. Not an agent decision point: it gates a GitHub check on code, not agent behaviour.
- `lint-gitleaks-allowlist-exact` — add — fails the same check when the exceptions file is widened beyond exact values.

---

## 1. Over-block

A new test fixture or documentation placeholder shaped like a key fails the check until its exact value is added to `.gitleaks.toml`. That is the intended cost; the failing step prints the one command that produces the line. Values already in the repository (116) are listed, verified by a full-tree scan returning no leaks.

---

## 2. Under-block

- gitleaks finds secret-shaped strings; a secret that matches none of its default rules (an unusual format with low entropy) passes. This is the same ceiling every rule-based scanner has.
- The scan covers the pull request's commits only; a secret already on main is not re-reported. The push-to-main run covers merge commits as they land.
- A real secret that an author deliberately adds to the exceptions file passes. The exact-value rule means that excuses one value, visibly, in a reviewed file, rather than a whole folder.

---

## 3. Level-of-abstraction fit

Right layer: a repository-level GitHub check with its own config, like the existing eli16 and decision-audit gates. The exact-value rule lives in a script the workflow runs, not in prose. It does not re-implement the credential-write lint, which checks code paths, not values.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface on agent behaviour.

It is a CI check on repository content. It is not a required status check in the main ruleset; the green-PR merger's `--auto` path treats any red check as a reason not to merge, which is the existing behaviour for every check.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Exact values only" is an enumerable invariant.

---

## 5. Interactions

- `scripts/safe-merge.mjs` `--auto` refuses on any red check (`refused:red-checks`), so a secret finding stops the merge of that pull request; nothing else changes.
- Adds one short job per pull request to GitHub's queue, offset many times over by #3616, which removes about twenty.
- The test file reads the real workflow and config, like `tests/unit/ci-workflow-concurrency.test.ts` does for ci.yml.

---

## 6. External surfaces

A new check named Secret Scan appears on every pull request. Its output is redacted (`--redact`), so a found value is never printed in a log. No agent, user or other system reads it.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Not agent state: repository CI configuration read by GitHub. No replication, no status surface.

---

## 8. Rollback cost

Delete the four files in one commit. No data, agent state or release artefact changes.

---

## Conclusion

Approved to ship as Tier 1. It adds the scan the repository never had, enforces the exact-values-only rule in code, and is verified three ways: the full tree scans clean with the exceptions, a planted token in a fresh commit is reported, and an exact-value exception in a fresh commit is not.

## Evidence pointers

- `npx vitest run tests/unit/secret-scan-exact-allowlist.test.ts`: 11 tests pass.
- `node scripts/lint-gitleaks-allowlist-exact.mjs`: clean, 116 exact-value exceptions.
- gitleaks 8.30.1 (`dir` mode) over the worktree with `.gitleaks.toml`: no leaks found, 212 MB scanned.
- gitleaks `git` mode over a fresh commit holding a generated `ghp_` token: 1 leak found, exit 1.
- gitleaks `git` mode over a fresh commit holding a listed fixture value: no leaks found.
- Checksum for `gitleaks_8.30.1_linux_x64.tar.gz` read from the release's `gitleaks_8.30.1_checksums.txt`; the darwin build's checksum was verified against the same file before local use.
