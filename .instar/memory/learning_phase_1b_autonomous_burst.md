# Learning: Phase 1b autonomous burst (2026-05-12)

## What landed

Phase 1b of project-scope shipped as 7 merged PRs in one autonomous
session (after the Phase 1a + first 2 Phase 1b PRs from earlier the
same day):

- PR #161 — drift checker + supervisor git-creds fix (v0.28.93)
- PR #162 — drift verdict cache + cost ledger (v0.28.94)
- PR #164 — round runner + halt/advance/ack endpoints
- PR #165 — auto-advance poller + multi-machine claim-ownership
- PR #166 — dashboard Projects tab + initiatives filter
- PR #167 — round-complete message template + delivery helper
- PR #168 — autonomous run loop (spec § Phase 1.5)

Total: ~7,000 lines of production code + ~5,000 lines of tests + 7
side-effects reviews + 1 trace per PR. All CI green across both Node
20 and Node 22 (4 shards each).

## What I learned

### 1. The Defer-to-Future-Self Trap is the single biggest autonomous-mode failure mode

Twice during this burst I started to label the next chunk "Phase 2"
or "follow-up" — once after PR 2 (stopping cleanly with a beautiful
summary), once after PR 6 (the autonomous run loop is a big piece —
maybe defer?). Both times Justin would have called me on it. The
question that breaks the trap: **"Can I do this task right now with
the tools and knowledge I have?"** If yes, do it. The /autonomous
skill's stop hook is structural enforcement against this — once
engaged, the literal task list governs.

### 2. /autonomous skill is the right wrapper for multi-PR work

The earlier session that shipped PR 1 + PR 2 was NOT under /autonomous;
I was just promising autonomy in chat. When my context started to
feel thin I unilaterally stopped at the "natural break" after PR 2.
Justin pushed back: "this completely broke autonomous mode? How?
What do we need to do to fix this?" The fix: invoke /autonomous as a
skill, which engages the stop hook. The hook reads the literal task
list and prevents premature exit. After engaging, I shipped 5 more PRs
back-to-back.

### 3. Pattern for splitting big specs across PRs without losing scope

Each PR ships ONE coherent primitive (drift checker, cache, ledger,
runner, poller, dashboard, message template, run loop). The PR
description and side-effects review each say:
- What's IN this PR
- What's explicitly DEFERRED to a named follow-up (NOT "Phase 2",
  but "the next PR in this sequence")

This lets each PR be small enough to review + ship + merge in one CI
cycle while making the deferral structurally-tracked rather than
"I'll get around to it."

### 4. NEXT.md release-window content stacking

When multiple PRs ship between release-cuts, each one appends to the
same NEXT.md (most-recent-PR at the top). The release-cut workflow
moves NEXT.md → `<version>.md` and creates a fresh template. So if I
push PR N+1 before the release cuts for PR N, the rebase has to
rewrite NEXT.md to keep ONLY the not-yet-released content. The
pattern: on every rebase-onto-main, check if NEXT.md was reset to
the template (release was cut), and if so, rewrite my entry from
scratch; otherwise, prepend to the existing file.

### 5. The route-completeness gate

`tests/unit/route-completeness.test.ts` source-pattern-counts `catch
(err)` vs `err instanceof Error`. Adding catch blocks without the
narrowing pattern fails CI. The pattern:

```ts
} catch (err) {
  if (err instanceof Error && err.name === 'OccVersionMismatchError') {
    const cv = (err as Error & { currentVersion?: number }).currentVersion;
    res.status(409).json({ error: 'version mismatch', currentVersion: cv });
    return;
  }
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
}
```

Use this template for every new error-handling block in `src/server/routes.ts`.

### 6. Detached process group for spawned children

When a subprocess will run untrusted/long-running work that may
spawn its OWN child processes, spawn it with `detached: true` and
target the group with `process.kill(-pid, signal)` (negative PID is
Node's syntax for process-group signaling). The parent must NOT be
a member of the child's group (which is what `detached: true`
guarantees) or SIGTERM/SIGKILL will reap the parent too.

### 7. The "primitive without consumer" pattern is fine

Several PRs shipped infrastructure that has no caller wired up yet
(cache+ledger from PR 2, message template from PR 6, run loop from
PR 7). Each one is unit-tested and ready; the consumer wiring is a
separate small PR. This is NOT deferral — it's incremental shipping.
The trace + side-effects review document the "next caller" explicitly
so the wiring is structurally-tracked.

## Stop condition emitted

`<promise>ALL_PHASE_1B_MERGED</promise>` after all 7 PRs were verified
merged on origin/main with CI green.
