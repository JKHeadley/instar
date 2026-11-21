# Side-Effects Review — a real secret scan on pull requests, exceptions for exact values only

**Version / slug:** `pr-secret-scan-exact-exceptions`
**Date:** `2026-11-21`
**Author:** `echo (session echo-increasing-throughput)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. Four new files, no runtime source changed: `.github/workflows/secret-scan.yml` (a Secret Scan job on every pull request to main and push to main: `npm ci`, the checker, pinned gitleaks 8.30.1 with sha256 check, `gitleaks git` over `base..head` with `--ignore-gitleaks-allow` and `--gitleaks-ignore-path` pointed at an empty directory, then `gitleaks stdin` over the content of any changed file whose path gitleaks' default allowlist would skip), `.gitleaks.toml` (default rules plus an allowlist of 116 exact values, one anchored escaped literal each), `scripts/lint-gitleaks-allowlist-exact.mjs` (refuses any path, folder, rule, commit, stopword or non-literal exception and a `.gitleaksignore` file; lists the default-allowlist-shadowed changed paths; prints the line for a new exact value), and `tests/unit/secret-scan-exact-allowlist.test.ts` (13 tests). Effort: five review rounds (round 1 found the checker would crash without `npm ci` and three ways gitleaks could be told to look away; round 2 found the content scan would fail on this file itself and a fail-open loop; round 3 found a comment in the exceptions file was unscanned; round 4 found the title and description still were; all fixed), two commit attempts. That is out of line with the size of a Tier-1 change; the cause is that each round found a real escape in a scanner's defaults, which is the kind of thing a review exists to catch.

## Decision-point inventory

- `Secret Scan GitHub check` — add — fails a pull request when gitleaks finds a secret-shaped string in its commits that is not an exact-value exception. Not an agent decision point: it gates a GitHub check on code, not agent behaviour.
- `lint-gitleaks-allowlist-exact` — add — fails the same check when the exceptions file is widened beyond exact values.

---

## 1. Over-block

A new test fixture or documentation placeholder shaped like a key fails the check until its exact value is added to `.gitleaks.toml`. That is the intended cost; the failing step prints the one command that produces the line. Values already in the repository (116) are listed, verified by a full-tree scan returning no leaks.

---

## 2. Under-block

- gitleaks finds secret-shaped strings; a secret that matches none of its default rules (an unusual format with low entropy) passes. This is the same ceiling every rule-based scanner has.
- The scan covers the pull request's commits only; a secret already on main is not re-reported. The push-to-main run covers merge commits as they land. `git log -p` does not show a merge commit's own diff, so a value introduced only while resolving a merge conflict inside a pull request branch is missed by the commit scan; the squash merge to main is then scanned by the push run.
- A real secret that an author deliberately adds to the exceptions file passes. The exact-value rule means that excuses one value, visibly, in a reviewed file, rather than a whole folder.
- gitleaks' own ways of looking away were each found by the independent review and are closed: inline `gitleaks:allow` comments are ignored (`--ignore-gitleaks-allow`); a `.gitleaksignore` at the repository root is refused by the checker, which is what actually blocks it, because gitleaks 8.30.1 reads `<source>/.gitleaksignore` whatever `--gitleaks-ignore-path` says (the flag is still set to an empty directory for the non-root case); the default allowlist's `paths`, global (node_modules, vendor, lockfiles, image, font and document extensions, anything named like `gitleaks.toml`) and per rule (BitBake `.bb/.bbappend/.bbclass/.inc` files for generic keys, octokit's README for GitHub tokens), still apply to `gitleaks git`, so the workflow lists every changed file those patterns match (from the merge base, every change but a deletion, NUL-separated) and scans its content through `gitleaks stdin`, where no path rule applies; the list is written to a file under `set -e` and the loop refuses to pass if it read fewer entries than listed, so a lister crash fails closed. The repository's own `.gitleaks.toml` is excluded from that content scan because its escaped entries read as private keys; in exchange the checker refuses the file unless it is byte for byte the canonical rendering of its own parsed values (`--canonical`: a fixed header, `title`, `[extend]`, `[allowlist]`, the regexes), so no comment, blank line or stray line can carry a value that no scan reads; `title` and `description` are fixed constants, so the file has no free text at all. A fixture holding a control character other than tab, newline or return cannot be listed (TOML refuses the string), which fails closed. The pattern list lives in the checker and must move with the pinned gitleaks version.
- A same-repo pull request runs this workflow and the checker from its own head and could weaken them. Local Verify flags any change under `.github/workflows` as a protected path that needs an independent second-pass review before its status can post, and the main ruleset requires that status; the exceptions file and the checker script are not under that flag, which is the residual.
- A force-push to main whose `before` commit is gone makes the push run fail rather than pass.

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
- Adds one short job per pull request to GitHub's queue (checkout, `npm ci`, a 20 MB download, two scans), offset many times over by #3616, which removes about twenty.
- The failure-advice step speaks only when a scan step failed, so a checker refusal or a bad checksum is reported as what it is.
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

Approved to ship as Tier 1 after the second-pass concerns were fixed. It adds the scan the repository never had, enforces the exact-values-only rule in code, closes gitleaks' own escape hatches, and is verified: the full tree scans clean with the exceptions, a planted token in a fresh commit is reported, an exact-value exception in a fresh commit is not, a token behind a `gitleaks:allow` comment is reported with the flag and missed without it, and a token in a `node_modules/` file is reported by the content scan.

## Second-pass review

**Reviewer:** independent reviewer subagent (Opus), rounds 1 to 5 on 2026-11-21.

**Independent read of the artifact: concur** (round 5). Round 3 found that a value hidden in a comment in the root `.gitleaks.toml` passed every scan (gitleaks skips the file by path, the content scan excluded it, and a TOML parser drops comments); fixed by the canonical-form rule. Round 4 found that `title` and `description` were still free text an 80-character cap did not close; fixed by making both fixed constants, with tests that plant a token in a comment, the title and the description and expect a refusal. Round 1 found that the checker would crash in CI (no `npm ci` before an import of `smol-toml`), that an inline `gitleaks:allow` comment, a `.gitleaksignore` file and the default allowlist's path patterns each let a planted value through, that the advice step misreported a checker or download failure as a finding, and that the tests pinned flag order and layout. Round 2 found that the content scan would have failed this very pull request on its own `.gitleaks.toml`, that the loop read from a process substitution and so failed open if the lister crashed, that the per-rule path exceptions were not mirrored, that type changes and quoted paths were mishandled, and that `--gitleaks-ignore-path` alone does not stop a root `.gitleaksignore`. Each is fixed in this commit.

## Evidence pointers

- `npx vitest run tests/unit/secret-scan-exact-allowlist.test.ts`: 13 tests pass.
- gitleaks `git` mode over a fresh commit with a token followed by `// gitleaks:allow`: missed without `--ignore-gitleaks-allow`, 1 leak with it. The same token in `tests/node_modules/hidden.ts`, scanned by content through `gitleaks stdin`: 1 leak.
- `node scripts/lint-gitleaks-allowlist-exact.mjs`: clean, 116 exact-value exceptions.
- gitleaks 8.30.1 (`dir` mode) over the worktree with `.gitleaks.toml`: no leaks found, 212 MB scanned.
- gitleaks `git` mode over a fresh commit holding a generated `ghp_` token: 1 leak found, exit 1.
- gitleaks `git` mode over a fresh commit holding a listed fixture value: no leaks found.
- Checksum for `gitleaks_8.30.1_linux_x64.tar.gz` read from the release's `gitleaks_8.30.1_checksums.txt`; the darwin build's checksum was verified against the same file before local use.
