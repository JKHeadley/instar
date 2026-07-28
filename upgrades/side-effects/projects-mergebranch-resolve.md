# Side-Effects Review — projects merge-base branch resolution (#866 sibling)

**Version / slug:** `projects-mergebranch-resolve`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required — small read-only environment fix + unit coverage`

## Summary of the change

After #866 wired ghPrView, the `building → merged` gate's NEXT check —
`gitMergeBaseIsAncestor(oid, 'origin/main')` — failed on fork-origin dev-agent
homes: `origin` is the agent's fork (instar-echo) while merges land on the
upstream remote (JKHeadley/instar), so origin/main never contains the merge
commit (MERGE_COMMIT_UNREACHABLE). Fix: `StageTransitionValidator` reads the
branch from a new `ctx.mergeBaseBranch` (default `origin/main`, behavior
preserved); the route computes it via `resolveCanonicalMainRef()` — asks gh
which repo it resolves for the cwd, maps that to the local remote whose URL
matches, returns `<remote>/main`, falling back to `origin/main`.

## Decision-point inventory
- `building → merged` merge-base check — was hardcoded `origin/main`, now uses the resolved canonical-main ref. The check's logic is unchanged; only the ref it compares against is now environment-correct.

## 1. Over-block
Before: fork-origin homes 100% over-blocked (every merged transition rejected though the PR merged). After: rejects only when the commit truly isn't on the canonical main. Strict improvement. Canonical-origin installs unchanged (resolves to origin/main).

## 2. Under-block
If gh/remote resolution misfires it falls back to `origin/main` (the prior behavior) — never a more-permissive ref, so no new under-block. The resolved remote must actually contain the commit or the gate still rejects.

## 3. Level-of-abstraction fit
Validator stays pure (takes the branch as input); the environment resolution lives in the route (where gh/git + cwd are). Right seam — mirrors how #866 injected the helpers.

## 4. Signal vs authority compliance
**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)
- [x] No — the gate remains a real check (commit reachability on canonical main); this only supplies the correct ref.

## 5. Interactions
- `resolveCanonicalMainRef` is read-only: `gh repo view` (gh, not funnel-gated) + `git remote -v` via SafeGitExecutor.readSync (`remote` is a READONLY_GIT_VERB, shape-checked list/get-url only).
- Any failure → fallback `origin/main`; never throws into the route.
- No interaction with the other advance edges (outline→spec, etc.) — only the merged edge reads mergeBaseBranch.

## 6. External surfaces
- Spawns `gh repo view` + `git remote -v` against the project target repo when a merged transition is attempted. No persistent state, no messaging, no fleet surface.

## 7. Rollback cost
Pure code revert + patch. No state.

## Conclusion
Completes the #866 chain: the projects pipeline can now record merged steps on dev-agent homes (fork-origin) as well as canonical-origin installs. Clear to ship.

## Evidence pointers
- `tests/unit/StageTransitionValidator.test.ts` — new cases: helper called with the configured `mergeBaseBranch` (not origin/main); unreachable error names the configured branch. 28 validator tests + 45 projects-api green; tsc + destructive-lint clean.

_Follow-up: the resolver catch carries an `@silent-fallback-ok` note — falling back to the `origin/main` default is the conservative behavior this resolver refines, not a swallowed error._
