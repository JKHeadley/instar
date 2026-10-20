# Side-Effects Review — npm run release:local (one-command local release)

**Version / slug:** `local-release`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo — spec reviewed over three rounds on PR #2224 (converged on her side); she asked to review this tool PR too`

## Summary of the change

Adds `scripts/release-local.mjs` (`npm run release:local`), which runs the `publish` job of `.github/workflows/publish.yml` on a maintainer's workstation: the same steps, the same order, the same scripts, failing closed at each step. The decision logic lives in `scripts/lib/release-local-steps.mjs` as functions with an injected `run`, so tests drive real git:
- `refreshGateBaseRefs`, `pushReleaseAtomically`, `pushTagThenMain`;
- `isReleaseCutCommit` / `incomingCommits`, `publishedStateAfterFailure`;
- `otpRequirement`;
- `ciRunState` / `activePublishRuns`, `ciGateAction`;
- `dirtyToolFilesOnly`.

`scripts/lint-no-direct-destructive.js` allowlists the script, which runs before `dist/` exists and so cannot import SafeGitExecutor. `CONTRIBUTING.md` gains "Releasing (maintainers)". The spec is `docs/specs/local-release.md` (approved by Justin, 2026-10-20). It depends on #2222, which makes the pre-push gate accept a release cut commit.

**Round 4 (Echo's review of #2225 at 48b54e4f5).**
- **Blocker:** a failure between publish and commit (smoke test, or a pre-commit refusal) now prints a working resume. `--push-only` commits an uncommitted release cut itself when the tree is exactly a cut for a version npm already has.
- **Registry check:** `--prefer-online`, with re-queries over ~30 s. A timed-out publish that still reads absent is UNKNOWN.
- **Push refusals** are classified by ancestry, not by comparing before/after shas (fetching first made that comparison wrong). The tag-exists CI race is named.
- **`--keep-tag-on-published`** is resumable, with exact recovery steps printed.
- **The build** runs with `NODE_ENV=development`.

**Round 5 (Echo approved round 4; two non-blocking minors).** When `vX` already exists on the remote on another commit, the tool now fetches that commit into a temporary ref (deleted afterwards). If it is the release cut for vX, the message says so and points at `--push-only --keep-tag-on-published`. An earlier keep-tag run of this tool is the usual cause, and it is no longer blamed on publish.yml. `INSTAR_RELEASE_LOCAL_VIEW_DELAY_MS`: unset or empty means the 10 s default, and any value is capped at that default, so it can only shorten the wait.

## Decision-point inventory

- **No agent runtime decision point.** This is maintainer tooling; it is in the npm `files` payload only because `scripts/` is.
- **Existing release decisions, pass-through:** release tier, publish version, upgrade-guide validation, Stage-B and contract evidence. Each is called exactly as publish.yml calls it.
- **New stops on irreversible actions (a publish, a push to main)** — add:
  - the preflight checks: clean tree, HEAD == `<remote>/main`, gate base refs refreshable, no unfinished publish.yml run for any commit, npm auth, OTP requirement satisfiable;
  - a hook refusal of the release push;
  - main moving with code;
  - an UNKNOWN publish state.

---

## 1. Over-block

- **Unrelated workflow runs.** It refuses while ANY publish.yml run is unfinished, even one that would find nothing to publish. Intended: a queued run publishes whatever main is when it starts, and refusing costs one cancel.
- **gh unavailable.** It refuses when `gh` can't answer, unless `--allow-unverified-ci` is given. That flag never overrides a run known to be active.
- **2FA unknown.** It refuses when the account's 2FA mode can't be read and neither `--otp-command` nor `--token-skips-otp` is given. A granular token often can't read the profile, so its owner must pass `--token-skips-otp`.
- **Uncommitted cut.** `--push-only` refuses a dirty tree unless it is exactly a release cut for a version npm already has, on main's history.
- **Main moved with code.** After publish it refuses to rebase over code commits. That leaves the version on npm without its release commit until `--push-only --keep-tag-on-published` is run. Intended: the tag must match the tarball.
- **npm view fails.** It fails closed when `npm view instar version` fails, where CI would fall back to `0.0.0`.

## 2. Under-block

- **A run queued after the second check.** A publish.yml run queued after the pre-publish re-check (a merge in that window) is not caught. npm then refuses one of the two publishes of the same version, and the atomic push plus the cut-only rebase rule keep main and the tag consistent.
- **Registry lag beyond ~30 s.** After a failed publish that did NOT time out, a registry that still reads absent after the 3 re-queries is taken as absent: the tree is restored, and a later run would bump past an orphaned version. The re-queries make this unlikely, and the timeout case is already UNKNOWN.
- **The token assertion is trusted.** `--token-skips-otp` is an assertion by the caller. If it's wrong, publish fails with `EOTP`; it does not hang, because stdin is closed and npm 11's `otplease` rethrows with no TTY. That failure is resolved against the registry.

## 3. Level-of-abstraction fit

It reuses every existing release script and adds no release policy of its own. The cut rule is the one #2222 put in `scripts/release-cut-diff.mjs`. The decision logic is pure or injected and unit-tested, and the CLI is a thin sequence.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over agent behaviour.

Its stops are deterministic safety checks on the operator's own irreversible actions (a publish, a push to main), which the principle allows. Every uncertain case stops rather than proceeds.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Each stop is an enumerable invariant: a run exists or it doesn't, a commit is a cut or it isn't, a version is on npm or it isn't.

## 5. Interactions

- **Pre-push gate (#2222).** The release commit is pushed with hooks on, and §3b admits it only through the release-cut exemption. The gate's base ref is refreshed first, from each ref's own remote.
- **publish.yml.** Unchanged. The tool refuses to run alongside it. The tool's own `[skip ci]` release commit doesn't trigger it.
- **`release-skip-annotate.mjs`.** It reads reachable tags only, so with `--keep-tag-on-published` the tag is off main's history and that annotator would report the version's work as unreleased. The tool prints this.
- **`[skip ci]` HEAD.** A HEAD carrying `[skip ci]` is a note, not a stop. The fragment check decides whether anything is left to release.

## 6. External surfaces

- **npm:** a version published this way has no provenance attestation.
- **GitHub:** a push to main and a tag push need the maintainer's branch-protection bypass, the same permission CI's `RELEASE_TOKEN` has.
- **Secrets:** no tokens are read or printed. An OTP from `--otp-command` is passed to npm and printed as `<hidden>`.

## 6b. Operator-surface quality

Not applicable — no dashboard, approval page or grant/secret form.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: one maintainer cuts one release from one workstation against the shared remote. Concurrency with CI or another maintainer is handled four ways:
- it refuses while any publish.yml run is active;
- the version is resolved from the registry;
- `npm publish` refuses an existing version;
- the push is atomic and rebases only over release cuts, never with a force push.

## 8. Rollback cost

Revert the PR: the script, its lib and tests, the npm script, the lint allowlist entry and the CONTRIBUTING section. There is no state, migration or agent surface. A release made with it is an ordinary release.

## Conclusion

Maintainer tooling that runs the existing release scripts in publish.yml's order. The deviations from publish.yml are listed in the spec, and every one fails closed. Mutation-checked across three review rounds; every mutation made a test fail.

## Evidence pointers

- **Real end-to-end dry run on main** (`--dry-run --allow-dirty-tool-files`, before this commit): exit 0, would publish instar@1.3.1360.
- **Bugs found and fixed:**
  - the dry run found an invalid gh status `pending` and a porcelain-parse error;
  - review round 2 found a non-capturing runner passed to the push logic.
- **Tests:** `tests/unit/release-local-steps.test.ts`, `tests/unit/release-local-parity.test.ts`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
