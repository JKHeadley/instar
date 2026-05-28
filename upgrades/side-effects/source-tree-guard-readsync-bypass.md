# Side-Effects Review — SourceTreeGuard read-tier bypass (extend to readSync)

**Driver:** dogfood follow-up to PR #450 (source-tree-guard-data-pull). The narrow `sourceTreeReadOk` opt was added to `execSync` + `spawn` to let `git fetch` work on the agent's own instar checkout. After deploying v1.3.38 to Echo, the next layer of the same gap surfaced: `readSync` also runs source-tree-checks ("defense-in-depth"), and the canonical-ref scan path uses readonly verbs (`rev-parse`, `ls-tree`, `show`, `log`, `merge-base`, `remote -v`) that all go through `readSync` → all blocked on the source tree.

## What changed

- **`src/core/SafeGitExecutor.ts`** —
  - `readSync` now honors `opts.sourceTreeReadOk` the same way `execSync` / `spawn` do: when the opt is true AND the verb is in `SOURCE_TREE_READ_TIER_VERBS`, skip `runSourceTreeChecks`; audit the bypass with the `sourceTreeReadOk-bypass` reason.
  - `SOURCE_TREE_READ_TIER_VERBS` extended from `['fetch']` to `['fetch', 'rev-parse', 'ls-tree', 'show', 'log', 'cat-file', 'merge-base', 'remote']`. Still a small closed enumeration; still requires a spec edit to grow. Every verb is read-tier: none mutate the working tree or committed refs.
- **`src/monitoring/releaseReadinessWiring.ts`** — every `SafeGitExecutor.run` callsite passes `sourceTreeReadOk: true`: `resolveCanonicalRemote` (`remote -v`), `fetchCanonical` (`rev-parse FETCH_HEAD` — fetch already had it), `oldestUnreleasedCommit` (`log`), `isAncestor` (`merge-base --is-ancestor`).
- **`src/core/featureRolloutScan.ts`** — every `SafeGitExecutor.run` callsite in the canonical scan path passes `sourceTreeReadOk: true`: `rev-parse FETCH_HEAD`, `ls-tree` (spec + trace enumeration), `show` (spec + trace blob reads). `fetch` already had it.

## Side-effects analysis

**Why this is safe.** Every verb in the (still-small, still-closed) `SOURCE_TREE_READ_TIER_VERBS` set is read-tier: it does NOT modify the working tree, any committed ref, or any source file. `fetch` writes only to `FETCH_HEAD` + objects (transient). `rev-parse`, `ls-tree`, `show`, `log`, `cat-file`, `merge-base`, `remote -v/-get-url` are pure-read. The bypass is opt-in per-call, audit-logged, and only effective inside the closed verb allowlist.

**Why the previous fix wasn't enough.** PR-450 only added the bypass to `execSync` + `spawn`, on the assumption that readonly verbs went through `readSync` which "didn't run source-tree checks." That was wrong: `readSync` runs them as defense-in-depth (catches repo-local aliases that could rebind a "read-only" verb). Every readonly verb on the agent's source tree was therefore still being blocked. This PR closes the gap at the right layer.

**Reach.** Two real-code callsites touched (the two new ones added by the spec: Layer B wiring + Layer C scanner). Every existing `SafeGitExecutor.readSync` caller that does NOT pass `sourceTreeReadOk: true` is byte-identically guarded by the prior behavior.

**Rollback.** Reverting this PR re-blocks the canonical-ref readSync calls on source trees. Layer B's fail-loud path keeps signaling on the failure; Layer C's local-scan fallback keeps working. No broken state.

## Testing

`tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts` (7 tests, all green):
- default: fetch on non-source-tree works
- default: fetch on source-tree blocked
- `sourceTreeReadOk: true` + fetch on source-tree passes
- `sourceTreeReadOk: true` does NOT bypass non-allowlist verbs (e.g. `add`)
- `SOURCE_TREE_READ_TIER_VERBS` is a closed read-tier set — no destructive write verbs (commit/push/reset/checkout/rebase/merge/clean/rm/branch/tag); size ≤ 10
- **readSync path also honors `sourceTreeReadOk` — `rev-parse FETCH_HEAD` on a source tree passes**
- **readSync path WITHOUT `sourceTreeReadOk` — `rev-parse FETCH_HEAD` on a source tree STILL blocked**

Lint clean.
