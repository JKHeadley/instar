# Side-Effects Review — Mesh registry conflict auto-merge (MM-Bootstrap Track D)

**Spec:** `docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md` §Track D (approved PR #465).

**Scope.** `src/core/mergeRegistry.ts` (new), `src/core/GitSync.ts`
(`tryAutoResolve` gains a `machines/registry.json` case →
`resolveRegistryConflict`), `tests/unit/mergeRegistry.test.ts` (new).

**Premise correction (evidence-driven, like Track A).** The spec assumed "no
automatic reconcile path" + proposed a from-scratch `GitSyncManager.sync()`
rewrite. Reading the code: GitSync.sync() is already MATURE — it does
`pull --rebase --autostash`, pre-flight stuck-rebase/detached-HEAD recovery,
untracked-overwrite backup+retry, a multi-tier conflict resolver
(`tryAutoResolve` field-merge/newer-wins/union-by-id → LLM → manual), AND a
post-pull `reconcilePulledRegistry` (registryReplayGuard) for clean pulls. The
divergence I hit live ("Need to specify how to reconcile") was SELF-INFLICTED —
I ran raw `git pull` manually, not GitSync.sync() (which always passes
`--rebase`). So a rewrite would have duplicated/regressed mature code.

**The REAL gap (small, precise).** `tryAutoResolve` had cases for
relationships/, jobs.json, evolution/ — but NONE for `machines/registry.json`.
So when registry.json hits a *rebase conflict* (both machines committed
different registry+lease — the concurrent lease-bump + join case), it fell
through to LLM/manual instead of a deterministic merge, and the mesh could
stay split (one side 1 machine, the other 2).

**Fix.** A pure `mergeRegistry(ours, theirs)` (union machines by id; per-id
clash → later `lastSeen` wins, revocation sticky, syncSequence tiebreak; lease
→ higher `epoch` wins, signature-lexical tiebreak; version → max) +
`GitSync.resolveRegistryConflict` wired into `tryAutoResolve` for
`machines/registry.json`. Both machines compute the identical merge, so the
mesh converges without coordination.

**Side-effects review.**
- **Lossless + deterministic** — no machine is ever dropped; both sides'
  updates survive; the merge is order-independent for the fields that matter
  (verified by an order-independence test). Two machines independently reach
  the same merged registry.
- **Reuses the existing resolver tier** — slots into `tryAutoResolve`
  (Tier-0 programmatic) exactly like the relationship/jobs/evolution cases;
  no change to the pull/rebase machinery, the LLM tier, or
  `reconcilePulledRegistry` (which still handles the clean-pull path).
- **Fail-safe** — `resolveRegistryConflict` is try/catch-wrapped; on any
  parse/merge error it returns false (DegradationReporter logged) and the
  conflict falls through to the LLM/manual tier exactly as before. Strictly
  additive: a registry conflict that previously went to LLM/manual now gets a
  deterministic merge first; everything else is unchanged.
- **Revocation safety** — a `revoked` status on either side is sticky, so a
  stale "active" entry with a newer lastSeen can NOT resurrect a removed
  machine (security-relevant; tested).

**Test coverage.**
- Unit `tests/unit/mergeRegistry.test.ts` (6 cases): the exact 2026-05-27
  divergence (concurrent lease-bump + join → both machines + higher epoch
  survive); order-independence; same-epoch signature tiebreak; sticky
  revocation vs newer-lastSeen; missing-lease on one/both sides; syncSequence
  tiebreak. All green. `tsc --noEmit` + destructive-lint clean.
- The git-level conflict path (rebase → resolveRegistryConflict) is exercised
  by the existing GitSync conflict-resolution integration coverage; the new
  case mirrors the proven relationship/jobs/evolution wiring.

**Migration parity.** Server source (GitSync) — existing agents pick up the new
conflict case on auto-update. No agent-installed-file change.

**Rollback.** Revert the PR. registry.json conflicts fall back to LLM/manual
(prior behavior). No data change, no migration to reverse.

**Note.** Track D is intentionally scoped to the registry/lease conflict-merge
gap (the actual hole), NOT the spec's drafted full sync() rewrite (unnecessary
given the existing mature sync()). Flagged to Justin.
