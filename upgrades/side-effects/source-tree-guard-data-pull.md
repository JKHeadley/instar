# Side-Effects Review — SourceTreeGuard data-pull exemption for `git fetch`

**Driver:** RELEASE-READINESS-VISIBILITY-SPEC §4.2.2 + §4.3.2 (Layer B + Layer C canonical-ref reads). Discovered during dogfood on Echo (the instar source IS the agent home — exactly the maintainer environment the spec targets).

## What changed

- **`src/core/SafeGitExecutor.ts`** —
  - New `SafeGitOptions.sourceTreeReadOk?: boolean` (default false).
  - New exported `SOURCE_TREE_READ_TIER_VERBS: Set<string>` — currently `['fetch']` only. Closed enumeration.
  - `execSync` + `spawn` skip `runSourceTreeChecks` when `sourceTreeReadOk: true` AND the verb is in `SOURCE_TREE_READ_TIER_VERBS`. The bypass is audit-logged (`sourceTreeReadOk-bypass` reason).
- **`src/monitoring/releaseReadinessWiring.ts`** — Layer B's `fetchCanonical` passes `sourceTreeReadOk: true`.
- **`src/core/featureRolloutScan.ts`** — Layer C's `scanSpecArtifactsCanonical` passes `sourceTreeReadOk: true` for its bounded fetch.

## Side-effects analysis

**The dogfood that prompted this.** With Layers B + C live and Echo's `monitoring.releaseReadiness.enabled: true`, the very first real tick on Echo hit `SourceTreeGuardError` on the watchdog's `git fetch <canonical-remote> main`. The watchdog correctly fail-louded (one LOW-priority Attention item `release-readiness-eval-failure-fetch`, deduped across ticks, full audit in `sentinel-events.jsonl`). Layer C correctly degraded + fell back to the local scan with a degradation log. So the architecture caught its own integration gap. This PR closes the gap principledly.

**Why this is safe.** SourceTreeGuard's mandate is "refuse destructive ops against the instar source tree" — the 2026-04-22 incident class. `git fetch <remote> <branch> --no-tags --no-recurse-submodules` writes only to `FETCH_HEAD` (transient ref) and the object database. It does NOT modify: the working tree, any committed ref (heads/tags/remotes), any source file. From the source-protection standpoint it is read-tier. `ls-remote` is pure read and already in `READONLY_GIT_VERBS` (so it goes through `readSync`, which doesn't run source-tree checks at all).

**Why opt-in.** The bypass is opt-in per-call, not a global relaxation. Every callsite that uses it is reviewable and audit-logged. The allowlist is a small closed set (`fetch` only) — adding to it requires a spec edit + this same review pattern.

**Reach.** Two callsites touched, both in the canonical-ref read path the spec defines (Layer B `fetchCanonical`, Layer C `scanSpecArtifactsCanonical`). Every existing callsite that does NOT pass `sourceTreeReadOk: true` is byte-identically guarded by the prior behavior.

**Rollback.** Reverting this PR re-blocks the canonical-ref fetch on source trees. Layer B's fail-loud path keeps signaling on the failure; Layer C's local-scan fallback keeps working. The watchdog and the reconciler degrade gracefully back to their prior behavior — no broken state.

## Testing

- `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts` (5 tests):
  - Default: `fetch` on a non-source tree works (baseline).
  - Default: `fetch` on a source tree is BLOCKED by `SourceTreeGuard`.
  - `sourceTreeReadOk: true` + `fetch` on a source tree passes.
  - `sourceTreeReadOk: true` does NOT bypass for non-allowlist verbs (e.g. `add`).
  - `SOURCE_TREE_READ_TIER_VERBS` is a small closed set (`fetch` only, ≤3 entries).

All green; lint clean.
