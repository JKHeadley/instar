# Side-Effects Review — Pre-push release-fragment guard (#23)

**Version / slug:** `pre-push-release-fragment-guard`
**Date:** 2026-05-31
**Author:** echo

## Summary of the change

`scripts/pre-push-gate.js` gains a check, mirroring the existing src→tests check:
if `src/**.ts` changed in the branch diff and no `upgrades/next/*.md` fragment
(or `upgrades/NEXT.md`) is present, it pushes an error → the gate exits non-zero.
Closes the #23 silent-release-skip class (a shippable src change merging without
a release note → publish.yml silently skips → fix never ships).

**Files changed (source/scripts):**
- `scripts/pre-push-gate.js` — +1 check (~13 lines) inside the existing git-diff
  `try` block, after the src→tests check.

**Files changed (tests):**
- `tests/unit/pre-push-gate.test.ts` — +1 content-assertion test (matches the
  file's testing approach for the gate's git-dependent checks).

## Blast radius

`scripts/pre-push-gate.js` runs only on `git push` (husky pre-push). It gates
LOCAL pushes; CI remains the authority for tests. The new check adds one more
reason a push can be rejected: a src change with no release fragment.

## Behavior delta

| Scenario | Before | After |
|---|---|---|
| src/ changed + a fragment/NEXT.md present | push proceeds | push proceeds (unchanged) |
| src/ changed + NO fragment | push proceeds → merges → **silent no-release** | push **rejected** with a clear message |
| `chore: release` cut commit (touches upgrades/, not src/) | proceeds | proceeds (srcChanges=0, check inert) |
| docs/test-only PR (no src/**.ts) | proceeds | proceeds (srcChanges=0, check inert) |
| git unavailable (CI / detached HEAD) | git-diff checks skipped | skipped (same `try/catch`) |

## Risks considered

- **False-positive blocking a legitimate push?** Only when src/ changed with no
  release note — which is exactly the bug. Genuine WIP bypasses via the existing
  `INSTAR_PRE_PUSH_SKIP=1`. The release-cut commit and docs/test-only PRs don't
  trip it (no src/**.ts).
- **Severity (error vs warning):** error, because a silent release-skip is a real
  failure (the fix never ships), matching the adapter-contract gate's error
  severity rather than the softer src→tests warning.
- **No new dependencies, no network, no state.**

## Migration parity

None required. `scripts/pre-push-gate.js` is a dev/release tooling script run from
the repo's husky hook — not an agent-installed file (hook/config/CLAUDE.md
template/skill). It ships in the repo; no `PostUpdateMigrator` entry needed.

## Test evidence

`npx vitest run tests/unit/pre-push-gate.test.ts` → 14 passed (incl. the new
content-assertion). `npm run lint` + `tsc --noEmit` clean. Dogfood: this PR
itself carries `upgrades/next/pre-push-release-fragment-guard.md`, so the new
guard would pass on this very change.
