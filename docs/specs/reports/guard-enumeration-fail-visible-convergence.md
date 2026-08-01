# Convergence Report — Guard Enumeration Fail-Visible

## Final disposition — converged for the narrowed contract (2026-07-31)

The historical runs below remain unchanged because they accurately record two capped,
non-converged reviews. The later operator directive to implement after PR #1748 merged is
the missing disposition those runs explicitly requested. It accepts the two tracked
follow-ups as out of this increment: unprompted alerting/exported metrics (`CMT-1103`) and
event-loop-safe live diagnostic reads (`CMT-1123`). Neither is represented as delivered.

A fresh implementation audit then compared the handed-off patch to the final normative
contract. It found four stale gaps — no `on-blind` guard posture, no runtime registration,
no restart-safe failure history, and no completed-tick update on enumeration failure. The
implementation closes all four and pins the two real lifecycle routes, posture precedence,
heartbeat projection, and restart semantics. With the formerly open design choice resolved
by the operator and the implementation reconciled to the final contract, this report's final
disposition is **CONVERGED for that narrow contract**. The earlier non-converged verdicts are
history, not silently rewritten evidence.

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

---

# Convergence run 2 — after building the fix for run 1's open finding

**Outcome: NOT CONVERGED AGAIN. The 10-round cap was reached a second time. No tag was
written, and none should be.**

Run 1 (above) ended at the cap with one open finding: no durable, alertable signal, with
the proposed home being `GET /guards` reading `errored` for a guard whose enumeration is
failing. **That finding has since been built** — as the new effective state `on-blind`
rather than `errored`, a deliberate divergence recorded in the spec and in the test file's
header (`errored` means *the status could not be READ*; a blind guard is perfectly readable
and is reporting a true fact about itself, so collapsing them would reproduce this spec's
own defect one layer up).

Run 2 re-ran the full loop against the spec carrying that work. It hit the cap on a
**different** unresolved finding.

| | |
|---|---|
| Rounds run | 10 of 10 (cap) |
| Criterion | two consecutive rounds with zero DESIGN-class findings |
| Best achieved | **one** clean round (round 4), never two consecutively |
| Final verdict | **SERIOUS ISSUES** — finding 1 explicitly approval-blocking |
| External families | **one** (`codex-cli` / gpt-5.5); gemini **not installed on this machine** |

| Round | Verdict | DESIGN? | The finding that mattered |
|---|---|---|---|
| 1 | — | yes | "durable, restart-surviving home" overclaimed |
| 2 | — | yes | two surfaces read different sources and can contradict |
| 3 | — | yes | the spec's own *title* overclaims |
| 4 | MINOR | **no** | timeout premise falsified; contract precision only |
| 5 | MINOR | yes | live route blocks the **event loop**, not "more subprocesses" |
| 6 | SERIOUS | yes | persistence contradiction — **repeat of round 1** |
| 7 | MINOR | yes | declining the fleet audit was process compliance, not risk management |
| 8 | SERIOUS | yes | persistence contradiction **again**; spec steers polling at the hazardous route |
| 9 | MINOR | yes | the normative section deferred to the prose, defeating itself |
| 10 | SERIOUS | yes | availability hazard is **approval-blocking** |

## Run 2's open finding — the one a decider needs

**`GET /worktrees/agent-reaper` enumerates synchronously in a non-async handler**
(`snapshot()` → `listWorktrees()` → `SafeGitExecutor.readSync` → `execFileSync`, bounded at
30s), so a hung `git worktree list` stalls **the whole Node event loop** — every route,
timer, lease heartbeat, mesh probe — for up to 30s per call.

Why it is approval-relevant rather than merely pre-existing:

1. **This spec makes the route more attractive to poll** by adding the fields that make it
   worth trusting.
2. **The mitigation currently shipped is prose.** The spec tells readers to poll `/guards`
   instead — which round-9 review correctly named as a violation of this project's own
   *Structure > Willpower* standard. A written instruction is a wish, not a guardrail.
3. **Raised in five separate rounds** (4, 5, 7, 8, 10), escalating each time. It is the
   most-repeated finding of the run.

Tracked as **`CMT-1123`** (availability), deliberately separate from `CMT-1103` (alerting),
both verified as real records. **Tracking is not closure and is not presented as such.**

### Run 2's second unresolved finding

In the reaper's **shipped dry-run default**, a restart erases the blind state entirely:
`lastEnumerationOk` and `lastPassAt` reset and `on-dry-run` outranks everything, so the row
is indistinguishable from a healthy guard until the next pass. The failure *history*
persists; the live *signal* does not. The feature's main posture signal has a blind spot in
the exact configuration it ships in. Found by a test that failed for the right reason.

### Correction to run 1's record

Run 1's report states the counters are "process-local counters that reset on restart."
**That is wrong** and the same error survived three rounds of run 2 before being pinned
field by field: `enumerationFailures` and `lastEnumerationFailureAt` **are** persisted and
reloaded; `lastEnumerationOk`, `lastEnumerationError` and `lastPassAt` are not. The
authoritative table is in the spec's persistence-model section. Run 1's text is left intact
as a historical record with this correction attached.

## Limits — read before weighing the verdict

Same reduced-assurance shape as run 1, and it must not be glossed:

- **One external family, and the earlier wording here understated it.** This section previously
  said gemini was "not authenticated", which reads as one login away. Measured 2026-07-30 on this
  machine: `command -v gemini` finds no binary, `~/.gemini` does not exist, and neither OAuth creds
  path is present — gemini is **not installed at all**, so `--detect-only` returns exactly one
  framework. Every round here is one model's opinion, not the family-diverse pass intended.
  Closing it needs an install *and* an operator-held Google login, not a login alone.
- **Fleet-level:** the other machine in this fleet has gemini installed but **not operationally
  authenticated**: the binary loads cached credentials, then refuses because the account needs a
  cloud project configured. Measured there on 2026-07-30, it fails in about four seconds rather
  than timing out. So the second family fails by absence here and by configuration there: **no
  machine in this fleet has yet produced a genuine two-family convergence.** Recorded because
  "cross-model reviewed" must not carry weight neither machine has earned — and because the
  skill's aggregate flag goes clean when a single family succeeds, which would hide exactly this.
- **The six internal reviewers were again self-applied** — this session prohibits spawning
  subagents. The security / scalability / adversarial / integration / decision-completeness /
  lessons-aware passes were performed by the same mind that wrote the spec: the circular
  self-review the skill explicitly warns against.
- **The DESIGN/PRECISION calls are therefore also mine.** Where a call was close it was
  counted as DESIGN — the conservative direction, since the author's bias that produced the
  overclaims could equally produce lenient classifications.

## The pattern — the most useful output of run 2

Nine of ten rounds found something real, and the **repeats** are the signal. The persistence
claim was found wrong three times (rounds 1, 6, 8), each time in a *different paragraph*:
round 6 added a correct authoritative table but left two contradicting sentences standing
elsewhere, and round 8 found one of them.

The lesson generalises: **in a long spec, adding a correct section does not remove an
incorrect one.** Contradictions are eliminated by deleting or explicitly subordinating
duplicates, not by out-arguing them in new prose. Rounds 7–10 kept returning to the same
structural complaint — ~900 lines of design, rationale, review history and doctrine
interleaved — and that entanglement is precisely what let one defect survive three rounds of
review aimed at it.

Two further instances of the same shape, both self-inflicted: the round-4 acceptance table,
written *to fix* overclaiming, was found overclaiming in round 6; and the round-7 normative
section, written *to fix* the entanglement, undercut itself in round 9 by declaring the prose
authoritative over itself. Naming the bias at the top of the document did not prevent
reproducing it two rounds later — which is the strongest available argument that this needed a
structural fix rather than another careful paragraph.

## Options for the decider

1. **Land `CMT-1123` first, then re-run convergence.** Removes the blocking finding at its
   root. Highest confidence, most work — it needs its own spec and review.
2. **Change this spec's contract now** — make `/guards`/last-pass the supported read and
   demote the live routes to an explicit, concurrency-limited probe. Smaller, but it is new
   design introduced at the review cap, so it would need its own rounds.
3. **Approve with the hazard accepted and tracked**, on the reasoning that the blocking is
   byte-for-byte pre-existing and this change alters only what the route *reports*. Cheapest;
   accepts a documented availability risk on the operator's judgment.

**Recommendation: option 1.** The hazard is real, five rounds kept returning to it, and the
shipped mitigation is exactly the written-instruction guardrail this project's constitution
rejects. Option 3 is defensible on scope grounds and is legitimately the operator's call — it
is a risk acceptance, not a technical resolution, and should be recorded as one.

## Implementation state

`tsc --noEmit` clean; 92 tests green across the two affected unit files, with Tier-1 and
Tier-3 coverage for `on-blind` (including the restart-behaviour test and five explicitly
labelled CONTROL tests that pass on both revisions and are *not* counted as evidence).
Nothing is committed — correctly, since the gate requires a tag neither run has earned.

*Written at the cap with the tag deliberately unstamped. Relabelling design findings as
precision would have produced a converged spec and a false record; the gate has now caught
two runs' worth of genuine defects and is worth more intact than satisfied.*
