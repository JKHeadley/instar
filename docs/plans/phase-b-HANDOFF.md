# Phase B — handoff for the next Pathway session

## WHERE YOU ARE AND WHAT TO OPEN (read this block first)

**This file exists in two places, byte-identical. You are reading one of them:**
- `~/.instar/agents/echo/.instar/phase-b/HANDOFF.md` — the agent-home copy (survives any branch state)
- `<worktree>/docs/plans/phase-b-HANDOFF.md` — the committed copy, on the branch

**The work lives on branch `echo/guard-effectiveness-observability`, 79+ commits, pushed.**
Worktree: `~/.instar/agents/echo/.worktrees/guard-effectiveness-observability/`

```bash
cd ~/.instar/agents/echo/.worktrees/guard-effectiveness-observability && git log --oneline -3
```

**Status: the Phase B exit gate PASSED on round 6. The kickoff charter is CLOSED.**
Nothing is queued. Do not re-run the gate. Do not start a new finding sweep.
Three operator decisions are outstanding (bottom of this file) and none blocks work.


**Written:** 2026-08-05 ~15:05Z, window 7, ~11h elapsed / ~13h remaining.
**Written proactively**, before a context ceiling, at the manager's request. Nothing here is urgent —
this exists so that hitting the wall costs a re-read rather than a re-derivation.

---

## DURABILITY — checked, not believed (manager's ruling, 15:23Z)

**Verified by measurement at 75 commits:** local HEAD `==` remote HEAD, working tree clean, and each
required artifact confirmed present **on disk, in the commit, and on the remote** individually.

**The check found two things I had wrongly believed were durable:**

1. `docs/audits/phase-b/tree-review-4.md` — the round-4 gate verdict — was on disk, uncommitted.
2. **The journal (14 KB) was not in the branch at all.** It lived only in the agent home, which is
   **not a git repository** — while the handoff cited it as one of three must-reads.

**That second one is Phase A's own lesson repeating verbatim**, corrected there and reproduced here.
Both are now committed and pushed and re-verified on the remote.

> **Nothing of consequence is now only in my context.** That statement is a measurement, not a belief —
> and the measurement is the reason it is now true rather than evidence that it already was.

## Read these three, in this order. Nothing else is required.

1. **`docs/plans/phase-b-remediation-tree.md`** — leads with an authoritative CURRENT-STATE header.
   **Read the header and trust it over the body**; the body is an append-log and several of its
   sections are deliberately marked superseded.
2. **`docs/specs/guard-effectiveness-observability.md`** — the first build item. Leads with a status
   banner. **Design v3; v1/v2 are in `docs/audits/phase-b/guard-observability-design-history.md`** with
   the reviews that killed them.
3. **`.instar/phase-b/phase-b-journal.md`** — what surprised me, per the node contract.

**Branch: `echo/guard-effectiveness-observability`, 72+ commits, pushed and remote-verified.** Everything
below is on it. The working tree is clean.

---

## The state in one paragraph

Phase B's tree is built and its node premises have been swept: **eight checked, five did not survive**.
The first build item is specified through three design generations and **is not ready to build** —
correctly, and the operator has ruled that no build happens until the spec is approved. The plan has
been through its own exit gate **six times. Rounds 1-5 all failed; ROUND 6 PASSED (COHERENT).**
The gate requirement is MET and the kickoff charter is closed. The second failure was mostly my own repairs.
**Three operator decisions are outstanding** and none blocks work.

⚠️ **This paragraph was itself stale within the hour** — it said "twice" and "two decisions" while the
table below said otherwise, because I updated the table and not the prose. **That is trap #6 on the
list below, committed in the same edit that added trap #6 to the list.** Left visible rather than
quietly fixed, because a successor should know how fast this document rots.

---

## What is IN FLIGHT (this is the part that dies with the session)

| item | state |
|---|---|
| exit-gate rounds | **DONE — R6 returned COHERENT; the gate PASSED.** R1–R5 all failed and each caught something real. **Do NOT re-run it.** Verdicts: `docs/audits/phase-b/tree-review-*.md`. |
| Codey engagement | **DONE** — real scoped work filed with ACK (`ATT-echo-trustbcase-1785942194`), framed as a peer proposal he may decline. |
| memory carry-over re-spec | **DONE** — re-specified against available memory, compressor trend, and pageout *delta*. |
| two items for Justin's list | **DONE** — gate-demotion evidence page (published, current) and the enforcing-mode-never-invoked artifact. |
| two candidate standards | **DONE** — both filed as proposals, deliberately NOT written into the registry. |

**Laptop lanes are intentionally at zero.** The manager explicitly declined to flag this: serial
plan-coherence work does not parallelise. **Do not dispatch lanes to look busy.**

---

## Things I already established — do NOT re-derive these

Each cost real time. Re-deriving them is the most likely way to waste the next session.

| fact | why it matters |
|---|---|
| The memory gate reads **`vm_stat` RAM availability**, never swap (`hostMemoryPressure.ts:119`) | Both the manager and I reasoned from swap and were wrong. |
| `/health` `llmReliability` uses **`sinceHours: 24`, hardcoded** (`routes.ts:3638`) | It says `failing` for broken, idle, AND already-fixed. Do not trust it as current state. |
| `--strict` appears **zero times** in the whole repo | Four lints implement an enforcing mode nothing invokes. |
| **28 of 72** guards can carry a caller-owned counter; the other 44 cannot | Settled by per-guard tracing. `docs/audits/phase-b/guard-verifiability-28-and-44.md`. |
| The constitution's "false claim" is **NOT false** — the audit job runs daily | I reported it twice and a correction PR was sanctioned before I retracted. |
| The trust code is **CORRECT**; only its test's name and comment are false | I escalated this as urgent-adjacent. It is not. |
| **`CrashLoopPauser` IS written and unit-tested** — it is never constructed *at boot* | Phase A said "never constructed"; I repeated it 5× without control. `new CrashLoopPauser` resolves 8× in tests, 0× in `src`. **The remedy is wiring, not building.** |
| `telegram-reply.sh` flags go **before** the topic id | A flag after it becomes message text silently. |
| The reviewer's tree needs `git fetch origin <branch> && git checkout FETCH_HEAD` | Otherwise every cited artifact reads as absent. **Two review findings were this.** |

---

## Traps I walked into — they are still open and will catch you the same way

1. **Writing an expectation into a lane prompt.** I wrote *"(expected: empty)"* and the lane returned my
   own error carrying the authority of execution. **A dispatch supplies the QUESTION and withholds the
   ANSWER.** Now a candidate standard.
2. **Renumbering without listing what is taken.** I fixed a duplicate branch id by creating the same
   collision, twice. `B0–B6` are taken; the new branch is **B7**.
3. **A matching total is not matching membership.** Twice my count matched an independent count exactly
   while the sets barely overlapped.
4. **Reading where I should have run.** Three times. The lanes that *executed* beat the lanes that
   *read*, every time.
5. **Appending under an "authoritative" header.** The header I wrote to stop the plan going stale was
   itself stale within the hour.
6. **Correcting in a NEW section instead of tombstoning in place.** Three gate rounds told me this in
   three different ways: a reader hits the stale text first and the correction second. **Strike it
   where it sits.**
7. **Inheriting a claim from trusted upstream work.** I repeated Phase A's "never constructed" five
   times without running a one-command control. **A finding that arrives pre-labelled as verified is
   exactly the one I stop checking.**

---

## Live positions a successor CANNOT reconstruct from the plan file

The plan file records findings. It does not record **which conclusions are settled and what they cost**,
and a fresh reader will not be able to tell. These four are settled:

**1. The exit gate failed FIVE times, caught something real every time, and PASSED on round 6.**
It was converging, not spinning. **It is finished — do not re-run it.** What finally passed it was not
more care: five rounds failed on the SAME defect (a count kept in four places). Round 6 passed because
three of the four copies were DELETED. That is the window's root finding, below.

**2. TWO of the gate's catches were factual errors I had already reported upward as findings.** The
constitution's "false claim" (not false — the job runs daily) and `CrashLoopPauser` "never constructed"
(written and unit-tested; never wired at boot). **Both had been escalated, one had action sanctioned on
it.** The gate is not polishing prose — it is catching claims that reached the operator.

**3. Instance #14 is the purest example in the whole set.** `crash-loop-pauser.test.ts` has **8 passing
unit tests** for a component that has paused nothing across a **492-consecutive-failure** streak. The
tests measure *"the class behaves correctly when constructed"*; they are read as *"this guard works."*
**A fully green test file is the entire distance between a passing suite and a job nobody paused.**

**4. B3.1's remedy changed and this is easy to miss.** Not "build `CrashLoopPauser`" — it is built and
tested. **"Wire it at boot and verify it pauses a seeded crash-loop."** Smaller job than the plan
originally implied.

## The window's root finding — recorded as a finding, not a reflection

**Proposed as a candidate standard under my name** (manager's ruling, 16:30Z):
`docs/proposals/standard-proposal-remove-what-demands-attention.md`.

> **I could not have passed the exit gate by being more careful.** Care produced five consecutive
> partial fixes. What worked was **deleting three copies of a number instead of keeping four in
> agreement** — removing the thing that demanded attention rather than supplying more attention.

Derived from six gate rounds, five failed identically, while ~4 of the ~14 instances of the defect the
plan was auditing were committed **by me, in the document about that defect.** If diligence were the
answer, the person hunting the defect would have been immune.

## Open decisions — operator's, not mine

1. **The three-rung amendment** (acts / holds-back as two axes). Endorsed by the manager, carried to
   Justin. Two-axis is working practice until he rules.
2. **Gate demotion** — the outbound message check from hard block to advisory. Endorsed, on Justin's
   list. Evidence page is published and current.
3. **B0.4** — the positional ceiling: 10 of 27 enforcement guards cannot be tested from an agent
   workstation. Still unanswered; nothing downstream can be sized until it is.

---

## What I would do next, in order

1. **Nothing is queued. The gate is PASSED and the charter is CLOSED.** Do not re-run the gate, and do
   not start a new finding sweep — both are already done.
2. **Leave the spec alone** unless the operator approves it. Four review rounds; the remaining gaps are
   prerequisites (the harness), not defects.
3. **Nothing else is queued.** Three operator decisions are outstanding and none blocks work.

**Do not start a new finding sweep.** The tree has more confirmed findings than it has capacity to
remediate, and the manager's cycle-four read was explicit that this window's value was tree work rather
than volume.
