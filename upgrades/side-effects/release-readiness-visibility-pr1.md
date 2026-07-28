# Side-Effects Review — Release-Readiness Visibility, PR-1 (`analyze-release.js --ref`)

**Spec:** docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md (converged + approved 2026-05-27)
**Scope of this PR:** the prerequisite-only change — add a `--ref=<rev>` flag to `scripts/analyze-release.js` and thread it through the git-range queries. No sentinel, no job, no routes (those are PR-2/PR-3). Plus the approved spec docs + convergence report + a unit test.

## What changed

- `scripts/analyze-release.js`: new `REF` constant parsed from `--ref=<rev>` / `--ref <rev>` (default `HEAD`). Threaded into `getLastReleaseTag`, `getCommitsSinceTag`, `getDiffStat`, `getChangedFiles`, `getFileDiff` — every place that previously hardcoded `HEAD`.
- `tests/unit/analyze-release-ref-flag.test.ts`: 4 subprocess tests against a deterministic git fixture (default ≡ HEAD; `--ref=HEAD` ≡ default; `--ref=<earlier commit>` changes the analyzed tip — different nearest tag + commit count; space form ≡ equals form).
- Spec + ELI16 + convergence report (docs only).

## Side-effects analysis

**Over/under-reach.** The change is additive and opt-in. `REF` defaults to `'HEAD'`, so every existing caller — most importantly the `prepublishOnly` chain (`npm run check:release` → `analyze-release.js`, which never passes `--ref`) — produces byte-identical behavior to before. There is no path where omitting the flag changes output. Verified by the `--ref=HEAD ≡ default` test.

**Level-of-abstraction fit.** The ref is a module-level constant rather than a threaded parameter, matching the script's existing shape (`getLastReleaseTag()` already took no args and implicitly used HEAD). This keeps the diff minimal and the helpers' signatures unchanged for the four that already took `tag`.

**Signal vs authority.** N/A for this PR — `analyze-release.js` is a read-only analyzer (it only reads git and prints a report). It gates nothing. The flag does not grant or remove any blocking authority. The downstream consumer that WILL use `--ref=FETCH_HEAD` (Layer B's readiness sentinel) is signal-only and ships in PR-2.

**Interactions.** The only consumer touched today is the prepublish chain, which is unaffected (default HEAD). `check-upgrade-guide.js` is not touched. The `--ref` flag is forward-looking: PR-2's readiness job will invoke `--ref=FETCH_HEAD` after a bounded fetch of canonical main. Per §10 sequencing, PR-2 does not merge until this PR is on main, enforced by a required-status CI check that asserts `--ref=<known SHA>` differs from `--ref=HEAD` (i.e. the flag is genuinely threaded, not silently ignored).

**Input safety.** `REF` flows only into `git` argv arrays via the existing `gitRead` helper (`execFileSync`, no shell) — no shell-injection surface. A bogus ref makes the underlying `git` call fail and the existing `try/catch` returns the empty/initial-commit fallback, exactly as today for a tagless repo.

**Rollback cost.** Trivial — reverting this commit restores the hardcoded `HEAD`. No state, no config, no migration introduced by PR-1. The unit test reverts with it.

**Testing.** Unit tier covered (4 tests, green). Integration/E2E tiers are not applicable to PR-1 in isolation (no routes/jobs yet) and land with PR-2, which adds the `GET /release-readiness` route + the "feature is alive" E2E that exercises the full readiness pipeline including the `--ref` path.
