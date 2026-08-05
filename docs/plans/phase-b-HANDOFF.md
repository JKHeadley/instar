# Phase B — handoff for the next Pathway session

**Written:** 2026-08-05 ~15:05Z, window 7, ~11h elapsed / ~13h remaining.
**Written proactively**, before a context ceiling, at the manager's request. Nothing here is urgent —
this exists so that hitting the wall costs a re-read rather than a re-derivation.

---

## Read these three, in this order. Nothing else is required.

1. **`docs/plans/phase-b-remediation-tree.md`** — leads with an authoritative CURRENT-STATE header.
   **Read the header and trust it over the body**; the body is an append-log and several of its
   sections are deliberately marked superseded.
2. **`docs/specs/guard-effectiveness-observability.md`** — the first build item. Leads with a status
   banner. **Design v3; v1/v2 are in `docs/audits/phase-b/guard-observability-design-history.md`** with
   the reviews that killed them.
3. **`.instar/phase-b/phase-b-journal.md`** — what surprised me, per the node contract.

**Branch: `echo/guard-effectiveness-observability`, 67 commits, pushed and remote-verified.** Everything
below is on it. The working tree is clean.

---

## The state in one paragraph

Phase B's tree is built and its node premises have been swept: **eight checked, five did not survive**.
The first build item is specified through three design generations and **is not ready to build** —
correctly, and the operator has ruled that no build happens until the spec is approved. The plan has
been through its own exit gate **twice and failed both times**; the second failure was mostly my own
repairs. **Two operator decisions are outstanding** and neither blocks work.

---

## What is IN FLIGHT (this is the part that dies with the session)

| item | state |
|---|---|
| exit-gate review round 3 | **not dispatched.** R1 and R2 both returned INCOHERENT; all findings from both are fixed. R3 is the next obvious step. |
| Codey engagement | one attention item filed **with ACK** (`ATT-echo-bcase-1785936015`). Ruling four asks for real work, not a notification. |
| memory carry-over re-spec | directed at cycle 4 — re-specify against **available memory**, not swap. |

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

---

## Open decisions — operator's, not mine

1. **The three-rung amendment** (acts / holds-back as two axes). Endorsed by the manager, carried to
   Justin. Two-axis is working practice until he rules.
2. **Gate demotion** — the outbound message check from hard block to advisory. Endorsed, on Justin's
   list. Evidence page is published and current.
3. **B0.4** — the positional ceiling: 10 of 27 enforcement guards cannot be tested from an agent
   workstation. Still unanswered; nothing downstream can be sized until it is.

---

## What I would do next, in order

1. **Dispatch exit-gate review round 3.** Both prior rounds failed; all findings are fixed; the gate is
   the ratified Phase B exit condition. **Fetch the branch into the reviewer's tree first.**
2. **Give Codey real work** (ruling four), not a notification.
3. **Re-specify the memory carry-over** against available memory (ruling three).
4. **Leave the spec alone** unless the operator approves it. It has had four review rounds and the
   remaining gaps are prerequisites (the harness), not defects.

**Do not start a new finding sweep.** The tree has more confirmed findings than it has capacity to
remediate, and the manager's cycle-four read was explicit that this window's value was tree work rather
than volume.
