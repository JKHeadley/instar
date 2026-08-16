# Side-effects review — Publish version-truth

Per L6. Seven dimensions.

## 1. Over-block / under-block

**Before.** UNDER: the workflow could not express an operator-intended major
bump at all — every release was a patch. This is the incident root cause.

**After.** No over-block. Routine patch PRs (the overwhelming majority, which
don't touch package.json) behave identically — LOCAL == NPM → patch+1. The
only new path is "LOCAL > NPM → honor LOCAL," which is exactly the
intentional-leap case. The LOCAL < NPM guard prevents an accidental downgrade
(a queued-run stale-package scenario), so there's no new under-block either.

## 2. Level-of-abstraction fit

The resolution policy lives in `scripts/resolve-publish-version.mjs` — a pure
function with a CLI shim, unit-tested. The workflow calls it. This is the
right altitude: decision logic in testable code, orchestration in the
workflow. No logic buried in inline bash.

## 3. Signal vs Authority compliance

package.json is the SIGNAL of operator intent. The npm registry is the
AUTHORITY for what shipped. The script reconciles them deterministically with
a documented precedence. No brittle filter is granted blocking authority; the
script never *blocks* a publish, it only *resolves the number*. (The loud
refusal-on-mismatch behavior is part of the separate lockdown spec, not this
PR.)

## 4. Interactions with adjacent systems

- **Release workflow.** Only the "Determine next version" step changes. The
  NEXT.md skip-gate, the guide-check, the publish, and the tag/commit steps
  are untouched.
- **Routine patch line.** Unchanged. Verified by the `eq` test case.
- **Queued concurrent runs.** The original concern ("queued runs leave
  package.json out of sync") is preserved: a queued run that lands after an
  earlier publish bumped will see LOCAL <= NPM and patch-bump cleanly, not
  collide.
- **The v1.0.0 cut.** This is the enabling change — the alignment PR will set
  package.json to 1.0.0 and the workflow will, for the first time, honor it.

## 5. Rollback cost

Low. Three files (workflow step, new script, new test). `git revert` restores
the npm-derived behavior. No state migration, no deployed-agent impact (this
is build-time infra, not shipped runtime code).

## 6. Backwards compatibility / drift surface

Fully backwards-compatible for the patch line. The only behavioral delta is
the previously-impossible major/minor leap. No config, no schema, no agent
files touched. Drift surface: none — the script has no persistent state.

## 7. Authorization / Trust posture

No new authority. The script reads two version strings and prints one. It
cannot publish, cannot mutate state, cannot escalate. The actual publish
authority (NPM_TOKEN) is unchanged and still gated by the same CI required
checks via branch protection.

## Outcome

Ship. Minimal, incident-driven, fully tested, no over-block, trivial
rollback. Unblocks the v1.0.0 cut without pulling in the broader lockdown
scope.
