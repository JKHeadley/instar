# Convergence Report — Guard Enumeration Fail-Visible

## ⚠ Convergence verdict: NOT CONVERGED (hit the 10-round cap)

**No convergence tag was written, and none should be.** One finding persisted across
rounds 5–10 and is deliberately not closed. Under the instar-dev Tier-2 gate this spec
therefore cannot be committed, and PR #1748 cannot land, until either that finding is
closed or the operator judges the registered follow-up sufficient. **Human input is
required — that is the designed outcome at the cap, not a failure of the review.**

## Cross-model review: codex-cli:gpt-5.5

A real external (non-Claude) pass ran on rounds 1, 2, 4, 8, and 9 through the agent's
own codex CLI. It found material defects the internal reading missed, twice.

## Honest note on process

**The six internal reviewer subagents were NOT run.** This session operates under a
standing instruction not to spawn subagents unless the operator asks, and the operator
did not. What *did* run, every round, was the code-backed half: the live
Standards-Conformance Gate against the 82-article constitution, and the real cross-model
external pass. The reviewer perspectives were applied by the authoring agent in-context.

This is a **reduced-assurance convergence** and is recorded as such rather than
presented as a full run. The two strongest findings both came from the machinery that
did run, which is some evidence the reduced form was not worthless — but it is not the
designed process.

## ELI10 Overview

Two background watchers look after leftover work folders — one reclaims the finished
ones, one shouts if somebody's unsaved work is stranded. Both begin by asking git what
folders exist. When that question failed outright, the code caught the error and
returned an empty answer, which looks exactly like good news: nothing to reclaim,
nothing stranded. A blind watcher and a healthy one produced identical output, and the
blind one was the reassuring kind.

This happened twice in production for unrelated reasons. Both times the specific cause
was fixed and the swallow left in place, so it came back wearing a different hat. This
change fixes the property: enumeration now returns a three-state result the compiler
forces callers to unpack, so "I could not look" cannot be reported as "nothing to do."

## Original vs Converged — what review actually changed

| # | Round | Raised by | Change |
|---|---|---|---|
| 1 | 1 | Constitution | Out-of-scope work named but untracked → cited the real Threadline dispatch + attention item; dropped an audit obligation the change does not carry |
| 2 | 1 | codex-cli | **Only the reaper was fixed; the spec claimed both guards.** The sentinel shares the enumeration and had its own swallow → fixed, with its own tests |
| 3 | 2 | codex-cli | `enumerationError` shape undefined → bounded, single-line, `Error.message`-only, clamped to 300 chars |
| 4 | 2 | codex-cli | Consumer enumeration was `src/`-only for an HTTP contract change → widened to tests, dashboard, OpenAPI; scope of the claim stated honestly |
| 5 | 3 | **Constitution** | **The spec named the structural fix (typed result) and chose JSDoc convention.** Self-refuting against its own thesis → implemented the typed three-state result |
| 6 | 4 | codex-cli | "byte-identical" overclaimed → corrected to "deletion-eligibility logic is unchanged" |
| 7 | 4 | Author, prompted by 6 | **The change made a dead `emit('error')` reachable — which throws with no listener**, in exactly the failure path this fixes. Renamed to `enumeration-failed`; two tests |
| 8 | 5–6 | Constitution | An event nobody subscribes to can rot → durable log line, then a failure counter; gap registered as `CMT-1103` |
| 9 | 8 | codex-cli | **Spec contradicted itself** (Safeguards still described the abandoned design; "a metric is added" vs "no metric") → reconciled |
| 10 | 8 | codex-cli | Control characters survive a whitespace collapse → C0/C1 stripped before collapse |
| 11 | 9 | codex-cli | Sentinel importing diagnostics from the reaper is accidental coupling → extracted to `worktreeEnumeration.ts` |

## Iteration Summary

| Round | Conformance findings | External verdict | Design-class |
|---|---|---|---|
| 1 | 2 | MINOR ISSUES | yes |
| 2 | 0 | MINOR ISSUES | yes |
| 3 | 1 | (delta-skipped) | **yes** — the typed-result finding |
| 4 | 0 | MINOR ISSUES | yes |
| 5 | 2 | — | yes |
| 6 | 2 | — | yes |
| 7 | 1 | — | no |
| 8 | 0 | **SERIOUS ISSUES** | **yes** — self-contradiction |
| 9 | 1 | MINOR ISSUES | no |
| 10 | 1 | — | no |

Rounds 9 and 10 produced no design-class findings, which is the two-consecutive-quiet
criterion — **except** that the round-10 finding is the same persistent Observability
one, and it is design-class in kind (it is about what ships, not how it is worded). It
is counted honestly as unresolved rather than reclassified to reach a clean number.

## The one open finding

> **Observability — you can't tune what you can't see.** The change ships without an
> exported monitoring metric or durable alertable signal, relying on response fields,
> logs, and process-local counters that reset on restart.

**Accurate.** The change delivers four surfaces (response fields, a named event, a log
line, in-process counters) but nothing that survives a restart or pages anyone.

**Why it was not closed here:** an operator-facing raise falls under *Self-Heal Before
Notify*, which requires a self-heal step, brakes, a severity class, and a latency
ceiling — a design with its own risk surface, not a line appended to this change. The
natural home is likely the existing guard-posture surface (`GET /guards`), where a guard
whose enumeration is failing should read `errored` rather than `on-confirmed`. That is
its own change.

**Registered as `CMT-1103`** — agent-owned, beacon-enrolled, so it resurfaces rather
than rotting. Registration is why this is a *deferral that is tracked* rather than one
that is swallowed; it is not a claim that the gap is closed.

## What the operator needs to decide

1. Is the registered follow-up sufficient to approve the spec as-is, or should the
   durable-metric work land first?
2. If approved, the spec needs `approved: true` with attribution before the instar-dev
   gate will permit the commit. Nothing in the working tree is committed yet.

## Test evidence

94 tests green across 7 files (unit, integration, e2e). Every new failure-path test was
verified to **fail** against the pre-change tree by reverting the source and re-running
— including the two that pin the `emit('error')` crash regression.
