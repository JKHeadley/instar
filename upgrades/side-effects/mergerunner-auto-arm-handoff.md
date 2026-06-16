# Side-Effects Review — MergeRunner Auto-Arm Handoff

**Spec:** `docs/specs/mergerunner-auto-arm-handoff.md` (CONVERGED 3 rounds + approved:true; report `docs/specs/reports/mergerunner-auto-arm-handoff-convergence.md`). Dev-cycle P0.
**Change:** switch the green-PR auto-merge watcher (`MergeRunner`/`GreenPrAutoMerger`) from "spawn `safe-merge --admin` and synchronously watch the merge land" to "arm GitHub native auto-merge (`safe-merge --auto`) and hand off," confirming the eventual merge on a later reconciliation tick. New non-terminal `armed`/`armed-overdue` episode states; operator-disarm reach via `--disable-auto`; GitHub `autoMergeRequest` as the cross-machine source of truth.

## Phase 1 — Principle check (signal vs authority)
Touches a decision point (whether/when to merge a PR), so the principle applies. **No new brittle blocking authority.** Arming native auto-merge is a *handoff*, not a new gate — GitHub enforces every required check (strictly STRICTER than `--admin`, which *bypassed* them). The merge AUTHORITY is unchanged (still the existing eligibility gates: protected-paths, identity, dual-latch, lease, holds — all upstream of arming and unmodified). The new pieces are SIGNALS or operator-authorized actions: the `merged-at-unexpected-head` detector, `armed-overdue`, `auto-merge-unavailable`, and the `unconfirmedArmAttempts` ceiling are attention lines (never forced give-ups); the `--disable-auto` disarm is the explicit reach of an EXISTING operator kill switch (the operator pressed rollback / set the HOLD), not a new autonomous mutation. The B10 honesty invariant is preserved exactly — `merged` is recorded only after an independent `gh pr view` MERGED read, now on the reconciliation tick. Fail-open throughout (UNKNOWN read → leave armed, no ladder, no breaker). Compliant (`docs/signal-vs-authority.md`).

## Phase 2 — Plan
Built in `.worktrees/mergerunner-auto-switch` off `JKHeadley/main` #1188 (`git remote -v` → JKHeadley; converged+approved spec present). Decision points touched: the act-path strategy (`mergeStrategy:'auto'` default | `'admin'` legacy) + the B10 confirm timing. Existing detectors interacted with: the per-PR failure ladder, the global breaker, the dual-latch, the lease. Rollback: `mergeStrategy:'admin'` config lever + the dual-latch/dark flags + revert the PR (additive code, no data migration).

## 1. Over-block
The change does not block inputs — it routes the merge to GitHub. The inverse risk is **over-merge** (auto-merge merging something it shouldn't). Bounded by: the SAME upstream eligibility gates (protected-paths, identity, holds, dual-latch, lease) all run BEFORE arming and are unchanged; native auto-merge cannot merge a red/pending PR (GitHub enforces required checks — stricter than the old `--admin` bypass); the documented residual race (a write-capable push between arm and green could merge an unvetted head) is surfaced post-hoc via the `mergeCommitOid`/`expectedHeadOid` vs `armedHead` mismatch detector + attention line; and the whole watcher ships dark (`monitoring.greenPrAutoMerge.enabled` off fleet-wide; `dryRun` soak first).

## 2. Under-block
A PR armed-then-stuck (CI perma-red after arming) is NOT silently dropped — `armed-overdue` keeps reconciling and re-surfaces a deduped attention line (Close the Loop). A confirm gap that persists is bounded by the head-keyed `unconfirmedArmAttempts` ceiling (surfaces, never spins invisibly). The one accepted residual (write-capable-push head substitution) is documented + post-hoc-detected, not silently missed — and the realistic write-capable-pusher set on `JKHeadley/instar` is small.

## 3. Level-of-abstraction fit
Correct layer. The switch lives in the existing `MergeRunner`/`GreenPrAutoMerger` (the one place the watcher acts) + a thin `safe-merge.mjs` slug refinement + a config-threading chain. It reuses the existing episode/ladder/breaker/lease machinery rather than building a parallel revival path; the new `armed` outcome is a clean third branch of `applyOutcome` that does not alter the existing terminal branches. GitHub's `autoMergeRequest` (not a new local store) is the cross-machine truth.

## 4. Signal vs authority compliance
See Phase 1. No brittle check gains blocking authority. The only new mutation (`--disable-auto`) is operator-authorized + audited + namespace-checked + null-safe. Compliant.

## 5. Interactions
- **The B10 line (`GreenPrAutoMerger.ts:452`)** is the central interaction: it is left gated on `merged` ONLY (explicit comment forbids generalizing it to `armed` — `confirmedMerged:false` is correct/expected for armed). Verified by a positive + negative test.
- **Reconciliation vs candidate path:** `gather()` excludes any PR with a local `armedAt` OR GitHub `autoMergeArmed`, so an armed PR never re-enters the act path until reconciliation clears it — no arm/re-arm thrash (the mirror-decision-methods lesson: the reconciler's "leave armed" is matched by gather's exclusion).
- **Breaker:** reconciliation read-failures (UNKNOWN) and the non-ladder retry classes feed NO breaker signal (the breaker still only takes busy/deadline/tick-failed); arming already succeeded, so a flaky read can't open the breaker.
- **Disarm vs tick:** disarm runs IN-LINE in the rollback/pool-disarm routes (the tick is latch-gated and would never reach it), so the operator kill switch genuinely reaches in-flight armed merges.
- **No double-fire:** the `armed` (candidate) and reconciliation paths are mutually exclusive on a given PR within a tick.

## 6. External surfaces
- `GET /green-pr-automerge` gains non-optional `armedCount`/`armed:[]` (observability — an in-flight async merge is now first-class visible).
- `safe-merge.mjs` gains a `refused:auto-arm-unavailable` result + `--capabilities` entry (back-compat: a new slug; existing callers unaffected).
- CLAUDE.md template gains the corrected behavior text (new agents via `generateClaudeMd`; EXISTING agents via a dedicated content-sniff REPLACE migration — the Migration-Parity fix, since the old install-if-`/green-pr-automerge`-absent sniff would skip already-armed agents and never deliver the load-bearing "a HOLD label alone does NOT stop GitHub auto-merge" fact).
- Depends on a runtime condition: "Allow auto-merge" enabled on the repo (it is, on `JKHeadley/instar`); if disabled, `refused:auto-arm-unavailable` → terminal-non-ladder attention (operator enables it or sets `mergeStrategy:'admin'`).

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local episodes + GitHub-global merge authority, coordinated by the existing lease + GitHub `autoMergeRequest`.** Episode state (`green-pr-automerge.json`) is machine-local-by-design and does NOT replicate — but that no longer strands a lease move, because GitHub-side `autoMergeRequest` (read in the widened `gather()`/`refetchPr` projections) is the source of truth for "already armed": the new lease holder reads GitHub and skips/reconciles rather than re-arming. The async handoff genuinely IMPROVES the multi-machine story (a lease move between arm and merge no longer loses the merge — GitHub owns it). No new cross-machine state, no generated URL, no one-voice notice surface introduced. Stated explicitly in the spec's Multi-machine posture section.

## 8. Rollback cost
Cheap and layered. (a) **Dark by default:** the whole watcher is off fleet-wide; armed per dev agent. (b) **`mergeStrategy:'admin'` lever:** restores the exact prior poll+admin behavior (runbook documents that a code-level rollback with armed PRs on GitHub leaves them for old code to redundantly `--admin`-merge — benign, both paths enforce required checks; or disarm-first). (c) **Dual-latch:** rollback/emergency-pause/pool-disarm now actively `--disable-auto` armed PRs. (d) **Full back-out:** revert the PR — additive code, new optional config/episode fields are forward-compatible via the `loadState` spread, no data migration, no agent-state repair.

## No-deferrals (Phase 4.5)
No deferrals. Every Round-2/Round-3 finding was resolved in the converged spec and implemented (the convergence report is the audit trail). The one accepted residual (write-capable-push head race) is an explicitly-documented, post-hoc-detected, bounded risk — the honest scope, not a partial fix.

## Phase 5 — Second-pass review
*(reaper/merge-class — REQUIRED; appended below)*
**Concur with the review.** An independent reaper/merge-class reviewer audited the ACTUAL implementation diff (not the artifact's claims) against all 7 load-bearing properties at real file:line — B10 not corrupted (`GreenPrAutoMerger.ts:579` gated on `merged` only; `armed` reaches its own branch; `act()` truthy for armed + negative misimpl test), re-arm exclusion airtight (`gather()` `localArmed||githubArmed` :451-461; widened projection derives `autoMergeArmed`), disarm reach real (rollback/pool-disarm in-line null-safe → `--disable-auto`; honest per-PR failure split), reconciliation fail-open (UNKNOWN→leave armed, no ladder/breaker; MERGED compares `expectedHeadOid`/`headRefOid` not squash `mergeCommitOid`), multi-machine (GitHub `autoMergeRequest` source of truth, machine-local episodes, no strand), `--disable-auto` namespace-safe (only `state.episodes` from `@me`-gated PRs, `--repo` pinned), B24 scoped to admin path. tsc clean; new optional fields forward-compatible; no existing terminal `applyOutcome` branch altered. No blockers.
