---
title: "Wire the worktree reaper and orphaned-work sentinel to the repo that owns the worktrees: Spec"
slug: "worktree-reaper-repo-wiring"
author: "echo"
parent-principle: "Enabled Is Not Running — a guard that cannot look must not read as a guard that looked and found nothing"
eli16-overview: "worktree-reaper-repo-wiring.eli16.md"
status: "draft"
review-convergence: null
review-iterations: 0
approved: false
approved-by: "NOT APPROVED — awaiting operator. This spec exists because the change is Tier 2 by my own declaration: runtime code feeding a guard with delete authority. I am not self-approving it, and the tier signal (riskFloor 1) would have let me ship it as Tier 1 without this document."
parent-spec: "AGENT-WORKTREE-CONVENTION-SPEC.md (where worktrees live); the AgentWorktreeReaper's own honest-reporting contract (enumerationOk / reclaimable:null, 2026-07-29)"
commitment: "CMT-1306"
---

# Wire the worktree reaper to the repo that owns the worktrees

## 1. The observed failure

On a live development agent, 2026-08-14, `GET /worktrees/agent-reaper`:

```
enabled: true, dryRun: true, reapedLastPass: 0, worktrees: []
enumerationOk: FALSE
enumerationFailures: 98
enumerationError: git -C /Users/<user>/.instar/agents/echo worktree list --porcelain
                  → fatal: not a git repository (or any of the parent directories): .git
```

45 worktrees under that agent home. **27 GB.** Ninety-eight consecutive passes, none of which enumerated
anything.

`src/commands/server.ts` constructs both consumers with `instarRepo: config.projectDir`. On this layout
`projectDir` **is the agent home**, and an agent home is not a git repo — the worktrees belong to
`<agent_home>/.dev/instar` (and, here, also `<agent_home>/.build/instar`). The same wiring is used by
`OrphanedWorkSentinel`, which therefore has the same blind spot.

**This already happened once.** The reaper's own source records it:

> *"That collapse is what let a mis-wired repo path sit behind a clean bill of health while real worktrees
> accumulated (2026-07-29: the reaper reported `reclaimable: 0` against 73 worktrees because
> `git -C <path> worktree list` was failing outright)."*

The fix that shipped then was the **honest reporting** (`enumerationOk: false` + `reclaimable: null`), and it
works — it is the only reason this was found. The mis-wired path itself was never corrected. Sixteen days
later the same wiring is failing 98 times. *The loop was closed on the symptom and left open on the cause.*

## 2. What is already merged (not in scope here)

PR #1882 landed the mechanism, inert:

- `parseWorktreeGitPointer(contents)` — a linked worktree's `.git` is a FILE naming its owning repo.
- `discoverInstarRepoFromWorktrees(roots, {maxWorktrees})` — reads those pointers, returns owning repos
  ordered by how many worktrees name each. No subprocess.
- `ResolveDetectorRepoOptions.worktreeRoots` — inert unless a caller passes its own root.

Nothing calls it. That was deliberate: the consuming half is this spec.

## 3. The proposed change

In `src/commands/server.ts`, resolve once and use for both consumers:

```ts
const _agentWorktreeRepo =
  resolveDetectorInstarRepo({ worktreeRoots: [_agentWorktreesDir] }) ?? config.projectDir;
```

- `AgentWorktreeReaper` — `instarRepo: _agentWorktreeRepo`
- `OrphanedWorkSentinel` — `instarRepo: _agentWorktreeRepo`

`config.projectDir` remains the fallback, so the ordinary layout (where `projectDir` IS the repo) is
unchanged, and an agent where discovery finds nothing behaves exactly as today.

## 4. Why this is Tier 2 and not Tier 1

The classifier says `riskFloor: 1` — no safety-invariant path is touched — so this could have shipped as a
Tier 1 declaration. I am declaring Tier 2 on consequence:

1. It is runtime code feeding a guard that **deletes directories**.
2. **My own first draft of this exact resolution produced a wrong answer on the real machine.** It defaulted
   discovery to `enumerateSafeRoots()`, which spans every agent home; measured, `echo` resolved to
   `instar-codey`'s repo. "Easy to get wrong" is not a worry here — it is the observed behaviour of my first
   attempt. That is the single strongest argument for a second pair of eyes.

## 5. Safety analysis

**The reclaim predicates are untouched.** The reaper only reclaims worktrees that are merged + clean + not in
use, with a per-path breaker; none of that changes. What changes is which repo it asks. A wrong answer
therefore cannot cause an unsafe reclaim of a *dirty* or *in-use* worktree — it can only cause it to look at
the wrong set.

**Cross-agent misresolution is closed by construction:** there is no default root; a caller must name its own,
documented on the option and pinned by a test.

**Every unresolvable case yields null,** and null falls back to today's behaviour: a full clone under
`.worktrees/`, a malformed pointer, a submodule gitdir, a missing `.git`, an unreadable file, a missing root.
Candidates are still integrity-validated by `resolveInstarRepo` before use.

**Declared limitation — partial coverage.** One agent's `.worktrees/` can hold worktrees of more than one
clone of the same upstream (measured here: 29 owned by `.build/instar`, 17 by `.dev/instar`). Discovery
returns both, most-owned first; a single-repo consumer takes `[0]` and therefore sees the **largest coherent
set, not all of them**. This is an improvement over enumerating nothing and it is not full coverage. Closing
it means teaching the reaper to iterate several repos, which changes its contract — explicitly out of scope
here and named rather than implied.

## 6. Open question for the operator (§6a) — blindness is masked during dry-run

Found while verifying the above, and I have NOT acted on it.

`guardPostureView` classification order:

```
} else if (dryRun && configEnabled === true) { effective = 'on-dry-run'; }
else if (stale)                              { effective = 'on-stale'; }
else if (verdictUnknown === true)            { effective = 'on-blind'; }   // unreachable while dryRun
```

The codebase **has** an `on-blind` state for exactly "the guard cannot see." A dry-run guard can never reach
it. Our reaper is dry-run AND blind, so `/guards` headlines it `on-dry-run`, `divergence: none`, with the
blindness only in a nested `runtime` field.

Once **armed** (`dryRun:false`), a blind guard IS correctly classified `on-blind` — so the masking is specific
to the soak period, which is precisely when you are meant to be learning whether the guard works before you
arm it. A guard blind through its entire soak produces a clean-looking soak and is then armed on that
evidence. That is how 98 failures stayed quiet.

**Fair reading of the existing code:** the author knew and accepted it — the comment on that line says
*"stale stays visible in the runtime block."* Teeth and sight are orthogonal, so I think this is worth
changing, but reordering would alter classification fleet-wide and could raise new alerts on other agents.
**That is an operator decision, not mine**, and it is why it is a question in this spec rather than a diff.

## 7. Test plan (all three tiers)

- **Unit** — already merged with the mechanism: 14 tests incl. the cross-agent misresolution and every
  "must return don't-know" case.
- **Unit (new)** — the resolution helper used by the server wiring: given a fixture agent home whose
  worktrees point at a repo, the resolved value is that repo; given none, it is `config.projectDir`.
- **Integration** — `GET /worktrees/agent-reaper` reports `enumerationOk: true` on a fixture where the
  worktrees' owning repo is not `projectDir`. This is the test that would have failed for 98 passes.
- **E2E** — the reaper's guard row reaches `on-dry-run` with **no** `verdictUnknown` on that fixture.

The integration test is the important one: it asserts the guard can *look*, which is the property that was
missing and which no existing test covered.

## 8. Rollback

Revert one hunk in `src/commands/server.ts`. No migration, no state, no persisted artifact. The mechanism it
calls is already merged and inert, so reverting the wiring restores today's behaviour exactly.

## 9. What I want from the operator

1. Approve (or reject) the wiring in §3.
2. A ruling on §6a — reorder so blindness is not masked by dry-run, or leave it and accept the nested-field
   reporting.

Nothing else is blocked on you: the mechanism is merged, the tests are written, and the reaper remains in
dry-run either way.
