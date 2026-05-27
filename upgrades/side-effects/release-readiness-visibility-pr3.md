# Side-Effects Review — Release-Readiness Visibility, PR-3 (Layer C canonical-ref scan)

**Spec:** docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md §4.3 (converged + approved).
**Scope:** the third and final PR of the spec — fix the second silent self-driving loop. The `FeatureRolloutReconciler`'s spec scanner today reads the LOCAL working tree, so a freshly-merged spec that isn't on the developer's current branch (or whose trace receipts have been cleaned up) is invisible — the reconciler silently skips exactly the newest work. This PR adds a canonical-ref scan that reads `docs/specs/` and `.instar/instar-dev-traces/` from canonical `main` directly. Feature-flagged off; falls back to the local scan on any failure with a single degradation event; never throws into boot.

## What changed

- **`src/core/featureRolloutScan.ts`** — new exports:
  - `scanSpecArtifactsCanonical(opts)` — sync canonical scan. Bounded fetch (`--no-tags --no-recurse-submodules`, no `--depth` — matches Layer B's --depth=1 lesson that shallowing the local repo breaks downstream git operations). Enumerates spec + trace blobs via `git ls-tree` and reads contents via `git show <sha>:<path>`. Returns `SpecArtifact[]` with `merged: true` by construction (a spec on main IS merged — the local scan's inferred `approved && traceExists` shortcut is replaced with real ancestry).
  - `scanSpecArtifactsWithCanonical(repoRoot, opts)` — the repo-gated, feature-flagged wrapper. When `canonicalRefScanEnabled` is false → calls the original local scanner. When the flag is on but `canonicalRemote` is missing → degradation + local fallback. When the canonical scan throws → degradation + local fallback. Boot-safe by construction.
- **`src/core/types.ts`** — new top-level `featureRollout` config block (`canonicalRefScan?: boolean` + `canonicalRemote?: string` + `fetchTimeoutMs?: number`). Default off.
- **`src/commands/server.ts`** — `FeatureRolloutReconciler` now constructs its `listSpecArtifacts` via the gated wrapper, passing config + an `onDegradation` log sink. With the flag off (the default) and the wrapper trivially routing to the local scan, behavior on every existing install is byte-identical.

## Side-effects analysis

**Reach.** Default off → every existing install runs the exact local scan from before, unchanged. New code paths only activate when an operator flips `featureRollout.canonicalRefScan: true`. The reconciler's call shape is unchanged (still sync, still returns `SpecArtifact[]`).

**The bug being fixed (proved by test).** Layer C's signature unit test: write an approved spec, commit + push to a canonical bare remote, then DELETE the file from the local working tree. The original local scanner doesn't see it (the file is gone). `scanSpecArtifactsWithCanonical` with the flag on + canonical remote configured DOES see it — `merged: true` by construction. That is the exact failure mode this layer exists to fix.

**Security / input safety.** All git through `SafeGitExecutor.run` (execFileSync, no shell). The canonical-remote allow-list lives on the Layer B side (release-readiness wiring) — Layer C accepts the remote NAME (already validated upstream) and uses it as a single argv token to `git fetch`. Trace JSON is parsed with a `try/catch` per blob; a malformed trace is skipped, never crashes the scan.

**Fail-loud / fail-safe.** Every failure path (no flag, no remote, scan throws) routes through `onDegradation(reason)` once per scan with a structured reason string, then returns the local-scan fallback. The reconciler's sync contract is preserved; the function NEVER throws into the boot path or the every-6h reconcile timer.

**Cross-PR alignment.** The Layer B production-bug fix from PR-2 (drop `--depth=1`) was carried through here verbatim. The `featureRollout.canonicalRemote` setting is INDEPENDENT of `releaseReadiness.canonicalRemote` — Layer C doesn't depend on PR-2 having landed; if both ship, an operator can either configure one for both or set them independently.

**Spec deferrals (per spec §4.3.3).** The skip-signal escalation (K=1 first tick then K=3, degradation → low-priority Attention after K consecutive deserved-skips) and the per-tick `lastProcessedCommit` cursor are mentioned in the spec but are NOT in this commit's scope. The canonical scan as-shipped already removes the silent-skip ROOT cause (the scan now sees what main has, not what the local tree has). The skip-signal + cursor are an additional observability enhancement on top — tracked here for a follow-up: <!-- tracked: release-readiness-visibility-pr3-followups -->. The follow-up does not block this PR's correctness — Layer C as-shipped is a self-contained improvement.

**Rollback.** Revert removes the canonical-scan path; the reconciler returns to using the local-only scanner. The `featureRollout` config key becomes orphaned but harmless.

## Testing

- **Unit (5):** flag off → local fallback; flag on + no remote → degradation + local fallback; **the headline test — a spec deleted from the local tree but committed to main is still detected**; trace + spec joined by `specPath` (canonical-only); bad remote → ONE degradation + local fallback.
- All run against real fixture git repos with `SafeGitExecutor`; no stubs of git. Layer C's real-I/O coverage is built into the unit tests themselves (the wrapper has trivial branching; the canonical scan IS the I/O).
