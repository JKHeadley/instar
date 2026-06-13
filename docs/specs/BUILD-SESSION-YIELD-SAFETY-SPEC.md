---
title: Build-Session Yield Safety — commit-before-yield guarantee
status: draft-for-convergence
parent-principle: "Close the Loop (Untracked = Abandoned)" + "Structure > Willpower"
tracked-as: ACT-839, CMT-1451
related: PROMISE-BEACON-ESCALATION-SPEC.md (#1093/#1097), reap-notify-per-topic-and-midwork-resume-queue.md, ORPHANED-WORK-SENTINEL-SPEC.md (#1113)
---

# Build-Session Yield Safety

## 1. The failure this closes

A background build / autonomous session edits files in its worktree, says "standing by for tests," and then **yields** — and because a `claude -p`-style session ends the moment the model stops emitting, it dies with the work **uncommitted and unpushed**. Real work, zero delivery, invisible for hours. This is the 2026-06-12 topic-22367 incident, and it bit three times in one day (a promise, a watcher, a build's final commit — each bound to a session that died).

Three mechanisms already exist around this failure, and this spec is deliberately scoped to the gap **none** of them close:

| Mechanism | Shipped | Covers | Does NOT cover |
|-----------|---------|--------|----------------|
| PromiseBeacon escalation ladder (#1097) | yes | a dead session's open **commitment** is revived/escalated | uncommitted **git** work (no commitment represents it) |
| Mid-work ResumeQueue | yes | revives a session killed with work-evidence (`midWork:true`) | **does not guarantee the revived session COMMITS** the uncommitted work before re-yielding |
| OrphanedWorkSentinel (#1113) | in review | **detects + surfaces** an already-dead session's dirty worktree (records + one notice; optional non-destructive preservation patch) | does not **revive** the work, and is post-hoc (the session is already gone) |

**The delta:** (A) uncommitted worktree work is not itself a resume-eligibility signal, and (B) even a revived session has no *structural* guarantee it commits the stranded work before it can yield again. This spec adds exactly those two things, and nothing else.

## 2. Design — two minimal, composable additions

### R1 — `uncommitted-worktree-work` as STRONG work-evidence

`src/core/WorkEvidence.ts` defines the closed evidence vocabulary clamped at the single kill chokepoint (`SessionManager.terminateSession`). Add one STRONG signal: `uncommitted-worktree-work`.

- Computed AT the chokepoint (the only moment the work is observable), by a dirty-check of the session's resolved worktree: `git status --porcelain` non-empty AND at least one non-ignored change. Reuses the existing `agentWorktreeGit` / OrphanedWorkSentinel signal source — ONE implementation of "is this worktree dirty," never a second.
- Being STRONG, it alone makes the reap resume-eligible (R2.2), so a build session whose `build-or-autonomous-active` flag already cleared (it had "finished" and was standing by) is still revived on the strength of its dirty tree.
- Bounded + safe: a dirty-check is read-only; on any git error the signal is simply absent (fail-open to "no evidence", never a spurious revive).

### R2 — commit-before-revive-yields guarantee (the actual fix)

When the ResumeQueue revives an entry carrying `uncommitted-worktree-work`, the revived session must not be allowed to yield again until its worktree is clean (committed, or explicitly preserved/stashed by deliberate act). Locus options, in safety order:

1. **Revival directive + first-yield gate (preferred).** The revived session is spawned with an injected directive: "you were revived because your worktree had uncommitted work — commit it through the gate or explicitly discard it before doing anything else." A scoped Stop-gate check (keyed to the revival nonce) blocks that session's FIRST yield while its worktree is still dirty, then disarms. This is a NEW, revival-scoped check — it does **not** edit the live general autonomous stop-hook governing already-running sessions (the documented hazard: mutating the hook mid-run risks the running session's own loop).
2. **Auto-WIP fallback.** If the revived session itself dies before committing (revive-of-revive), the queue's give-up path writes a non-destructive WIP preservation patch (reusing OrphanedWorkSentinel's `preserveWork` path) and raises ONE loud Attention item — never a silent second loss.

### Deconfliction (mandatory, per prior design note)

- Extends ResumeQueue; does **not** duplicate it. R1 feeds the existing eligibility classifier; R2 attaches to the existing revive path. No parallel queue.
- The first-yield gate is revival-scoped (nonce-gated, self-disarming) so it cannot wedge a normal session or the running autonomous worker.
- OrphanedWorkSentinel stays the post-hoc detector for sessions that died *without* being reaped through the chokepoint (e.g. a crash) — R1/R2 cover the reaped-with-evidence path. The two are complementary, not redundant.

## 3. Safety / posture

- Ships **dark + dev-gated** (developmentAgent gate); live on the dev agent first.
- R1 is read-only signal computation. R2's only mutation is committing/preserving work that would otherwise be lost — strictly loss-reducing, never destructive (a WIP commit is reversible; a preservation patch never touches the index/ref).
- Fail-open everywhere: a git error, a missing worktree, or a disarmed gate all degrade to today's behavior (the work is at worst flagged by #1113), never to a wedge or a false block.

## 4. Test plan (3-tier)

- **Unit:** `uncommitted-worktree-work` clamps + classifies as STRONG; dirty-check both sides (clean tree → no signal, dirty tree → signal); fail-open on git error. First-yield gate: blocks while dirty, disarms after commit, never fires for a non-revival session.
- **Integration:** a reaped session with a dirty worktree enqueues with the evidence; the revive path injects the directive; `GET /sessions/resume-queue` shows the entry.
- **E2E:** boot → reap a session with a real dirty temp worktree → revive → assert the first-yield gate holds until a commit lands, then releases; assert the auto-WIP fallback fires + raises one Attention item on revive-of-revive.

## 5. Open questions

*(none)*
