# Side-Effects Review — Post-publish smoke gate (MM-Bootstrap Track A, re-scoped)

**Spec:** MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS §Track A (re-scoped per the
evidence below).

**Scope.** `scripts/post-publish-smoke.mjs` (new), `.github/workflows/publish.yml`
(one new step after `npm publish`), `tests/unit/post-publish-smoke.test.ts` (new).

**Premise correction (evidence-driven).** Track A originally targeted a
"fleet-wide install blocker — the published tarball ships an empty dist." That
premise is FALSE: a clean `npm install --prefix /tmp/... instar@latest` yields a
complete dist (864 dist/core files) and runs. The "empty dist" hit during the
2026-05-27 manual bring-up was self-inflicted (an `rsync -a --delete` wiping the
global install). So there is no active bug to fix. Re-scoped (with Justin's
default-build nod) to cheap REGRESSION INSURANCE: if the publish pipeline ever
DOES ship a broken tarball, catch it within minutes of release.

**What it does.** A new step after `npm publish` runs
`post-publish-smoke.mjs <version>`: waits (bounded retry, 3m) for npm to
propagate the just-published version, clean-installs it into a throwaway prefix,
asserts `dist/cli.js` exists, runs `--version`, and asserts it reports the
published version. Fails the release workflow loudly otherwise (before the
version-bump commit/tag).

**Side-effects review.**
- **No effect on the happy path** — adds a verification step; a healthy publish
  passes it in ~seconds-to-2min (npm propagation).
- **Fails the workflow on a broken publish** — by design. A broken tarball halts
  the release before tagging, so a bad version isn't blessed. (The tarball is
  already on npm at that point — npm doesn't allow un-publish easily — but the
  loud failure surfaces it immediately for a follow-up patch.)
- **Throwaway prefix** — installs into `mkdtemp` under the OS tmpdir; no effect
  on the repo or the runner's global state.
- **Bounded** — 3-minute propagation deadline; never hangs the workflow.
- **substring-safe version check** — `versionMatches` tokenizes (1.3.5 ≠ 1.3.55),
  unit-tested both ways.

**Test coverage.** Unit `tests/unit/post-publish-smoke.test.ts` (4) covers the
pure `versionMatches` (bare output / token-among-others / mismatch / no
substring false-match). The install+run path is exercised by the workflow itself
on the next real publish (CI-only; not unit-mockable meaningfully).

**Migration parity.** None — publish-pipeline + dev script; no agent-installed
file.

**Rollback.** Revert the PR. The smoke step disappears; publishes proceed
unverified (the prior state). No data change.
