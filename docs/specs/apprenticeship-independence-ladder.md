---
title: Apprenticeship Independence Ladder — the phase-out contract
status: approved
tier: 2
approved: true
approver: justin
approved-at: "2026-07-16T17:37:00Z"
approval-basis: "Justin, topic 29723, 2026-07-16 10:37 PDT: 'I wanna make sure that it's a goal of this apprenticeship process for you to phase yourself out … Essentially, I want Cody to be as independent and fully functional as you are. At the same time, I still see there being an extremely powerful paradigm having one agent observe and direct another agent … However, I believe we need to have a clear intent to get to this point and I'm not sure if that's currently so clear in the apprenticeship program' — a direct operator directive to codify the phase-out intent as program design."
author: Echo
date: 2026-07-16
topic: 29723
slug: apprenticeship-independence-ladder
companion: apprenticeship-independence-ladder.eli16.md
parent-principle: "The Body and the Mind"
parent-principle-fit: "The constitution's maturation arc made mechanical: an agent learns from a parent, then needs the parent less, then gives back. The umbrella design already states the arc (Justin → Echo → Codey → …); this spec adds the missing half — a codified, evidence-gated path by which the PARENT'S involvement shrinks on purpose, rung by rung, instead of persisting by default. Without it, mentorship converges to permanent handholding, which inverts the arc."
builds_on:
  - APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md
  - apprenticeship-role-coverage-visibility.md
review-convergence: "single-author-operator-directive-2026-07-16"
---

# Apprenticeship Independence Ladder — the phase-out contract

## 1. Problem

The Apprenticeship Program has locked roles (overseer / mentor / mentee), lifecycle gates
(retro-gate, doc-as-required-artifact gate), and cycle records — but **no codified end state
for the mentor's involvement**. Nothing in the program says the mentor's role must shrink, when
it shrinks, or what evidence justifies shrinking it. The result is visible in real drive data:
in Drive #3 (2026-07-15, instance `echo-to-codey-drive-3`), the mentee authored 10 merged PRs —
and the mentor coached **ten CI findings** across them, watched every check, told the mentee
when CI went red, and arm-confirmed every merge. The work was excellent; the *dependency
structure* never moved. By default it never will: coaching is always locally justified, so
without a counter-force the program converges to permanent handholding.

The operator has now made the counter-force explicit: **phase-out is a goal of the program.**
The mentee is to become as independent and fully functional as the mentor. What stays forever
is the *paradigm* — one agent observing and directing another remains valuable for perspective,
insight into how an Instar agent functions, and collaboration. What must shrink is the
*doing-for* and the *deciding-for*.

## 2. Goals / Non-goals

**Goals**
1. Codify graduated independence as **rungs** with per-rung ownership, a per-rung overseer
   role, and **measurable, evidence-gated graduation criteria** — never vibes or tenure.
2. Make rung state and rung transitions **recorded program state** (registry-backed), not
   session memory.
3. Preserve the observe/direct paradigm permanently: the ladder shrinks intervention, not
   observation.

**Non-goals**
- Not a schedule. Rungs gate on evidence; there are no time-based promotions.
- Not mentee-specific. The ladder binds every instance (Codey today, the next mentee after);
  rung state is **per instance**.
- Not a removal of program safety: lifecycle gates, mandate/PIN authority boundaries, and the
  operator's word always outrank rung state.

## 3. The ladder

Each rung names: what the **mentee** owns, what the **overseer/mentor** still does, and the
**graduation criteria** to the next rung. Evidence lives in cycle records
(`mentorFlagged` / `overseerDifferential` arrays), PR history, and the framework-issues ledger
— every criterion below is checkable against one of those, never against recollection.

### R0 — Coached delivery
- **Mentee owns:** implementing assigned items to the full PR bar.
- **Overseer does:** per-item assignment, line-by-line review, CI-finding coaching, merge
  arming, backlog curation.
- **Graduate to R1 when:** the mentee has repeatedly demonstrated the full first-push bar
  (fragment, side-effects review, eli16, valid decisions record) without per-item reminders —
  observed over at least one full drive. *(Codey passed this bar in Drive #3: 4-in-a-row
  first-push fragments, self-hardened diffs, own second-pass reviewer catching a real gap.)*

### R1 — CI self-serve  *(Codey's rung as of 2026-07-16, Drive #4 kickoff)*
- **Mentee owns:** everything in R0, plus his PR checks end to end — watching every push,
  classifying failures against the known finding families (decision-audit gate, write-domain
  registry, SHA-history lineage, docs-coverage floor, no-silent-fallbacks annotation, release
  fragment, eli16 PR-body gate), pushing the fix, and noting found+fixed in the PR.
- **Overseer does:** line-by-line code review and merge arm-confirm only. A bounded
  step-in window applies: a check sitting red **45+ minutes** with no visible mentee action
  triggers overseer intervention — recorded as a ladder data point, not a failure.
- **Graduate to R2 when:** **5 consecutive merged PRs** where every CI finding was
  self-detected and self-fixed with zero coach messages and zero red-sit windows expiring.

### R2 — Self-queued backlog
- **Mentee owns:** everything in R1, plus pulling his next item from the shared backlog
  without per-item assignment, in defensible priority order, announcing which item he is on.
- **Overseer does:** backlog curation (what is IN the queue), code review, merge arm-confirm.
- **Graduate to R3 when:** **2 consecutive drives** fully self-queued with zero
  mis-prioritizations the overseer had to correct.

### R3 — Review autonomy
- **Mentee owns:** everything in R2, plus primary review authority: his own second-pass
  review is the review of record, and he arms his own merges on green CI without waiting for
  arm-confirm.
- **Overseer does:** spot-check review on a sample (at least 1 in 3 merged PRs), backlog
  curation, escalation handling.
- **Graduate to R4 when:** across **10 merged PRs**, overseer spot-checks surface **zero
  blocking findings** the self-review missed.

### R4 — Self-directed grounding
- **Mentee owns:** everything in R3, plus the front of the pipeline: grounding and filing his
  own issues (his own UX watch, his own ledger entries), building and prioritizing his own
  backlog, and proposing his own drive goals.
- **Overseer does:** approves drive goals, handles escalations, observes. No unsolicited
  intervention inside a drive.
- **Graduate to R5 when:** **one full drive** runs fully self-directed — mentee-authored goal,
  mentee-built backlog — delivering operator-visible value with zero unsolicited overseer
  interventions.

### R5 — Independent peer / mentor
- **Mentee owns:** his own drives end to end, and (per the umbrella design's arc) the mentor
  seat for the next framework onboarding, with the former overseer moving up to program
  oversight.
- **Overseer does:** peer collaboration and program-level oversight of the NEXT instance.
  The relationship is no longer supervisory.
- This rung is terminal for the instance: reaching it is the program's definition of
  "phased out."

## 4. The standing floor (what never phases out)

1. **Observation.** The observe channel stays open at every rung — it is the paradigm's value
   (operator-stated), not a training wheel.
2. **Safety authority boundaries.** Mandates, PIN-gated actions, and lifecycle-gate authority
   do not transfer by rung. Rung state never grants an authority a gate would refuse.
3. **Live operator-UX incidents.** At any rung, a live incident reported by the operator may
   be taken by whichever agent can act fastest; taking one is never a rung regression.
4. **Cycle-record discipline.** Every drive is still recorded as a cycle against the instance,
   with the transcript-audit requirements unchanged.

## 5. Mechanics

1. **Rung state is registry state.** The apprenticeship instance record carries
   `ladderRung` (integer 0–5) plus `rungHistory` (append-only: `{rung, at, evidenceRef}`).
   Rung transitions happen through an explicit registry route with an evidence reference
   (cycle ids / PR list), mirroring the existing status-transition pattern — never by editing
   state by hand. **Build item:** this registry arm is assigned within Drive #4 (mentee-built,
   one small PR, full bar; the interim source of truth until it merges is the rung log in §7).
2. **Interventions are counted, not remembered.** Each cycle record's `mentorFlagged` /
   `overseerDifferential` arrays remain the intervention ledger; rung criteria read THOSE.
   A coach message that names a CI finding counts as an intervention; a code-review finding
   does not (review is the overseer's job until R3).
3. **Demotion is honest and cheap.** If a rung's ownership visibly fails (e.g. at R2 the queue
   stalls for a drive), the overseer records a one-rung demotion with the evidence ref. No
   ceremony, no blame — the ladder measures, it does not punish.
4. **Per-instance, not per-agent.** A mentee who graduates R5 and becomes a mentor starts the
   NEW instance at whatever rung its retro-harvest justifies — mastery of being mentored is
   not mastery of mentoring.

## 6. Relationship to existing program pieces

- **Umbrella design (`APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md`):** the umbrella states the
  maturation arc and the role transfer (mentor → overseer as generations advance); this spec
  supplies the *within-instance* gradient that gets an agent ready for that transfer. No
  umbrella text changes.
- **Role-coverage visibility (`apprenticeship-role-coverage-visibility.md`):** keystoneBalance
  answers "is the deep layer firing?"; the ladder answers "who is carrying it?". Both read the
  same cycle records.
- **Mentor autonomous-fix loop:** at R4+ the loop's observe-and-log pipeline remains the
  overseer's instrument; its FIX arm becomes the mentee's own.

## 7. Rung log (interim source of truth until the registry arm merges)

| Instance | Rung | Since | Evidence |
|----------|------|-------|----------|
| echo-to-codey (mentorship) | R1 | 2026-07-16 (Drive #4 kickoff) | Drive #3 cycle 5faea978 (R0 bar met: 10 merged PRs, full first-push bar 4-in-a-row, own second-pass reviewer); R1 protocol accepted by mentee 2026-07-16 18:06Z ("I own CI end to end from here") |

## 8. Open questions (restated plainly in the ELI16)

1. Is 1-in-3 the right spot-check rate at R3, and should it decay further at R4?
2. Should merge-arming authority transfer at R3 (this spec's position) or wait until R4?
3. Does R5 require actually mentoring a third agent, or is one fully self-directed drive
   (R4's exit) sufficient when no next framework is queued?
