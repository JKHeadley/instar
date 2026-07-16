# The Independence Ladder, explained simply

Justin asked for one thing to become crystal clear in the apprenticeship program: the point is
for the teacher to work themselves out of the teaching job. Codey should end up as independent
and capable as Echo — while the genuinely valuable part, one agent observing and collaborating
with another, stays forever. Until now the program had roles and rules but no written path from
"heavily coached" to "fully independent," so coaching quietly stayed at the same level drive
after drive: in the last 12-hour drive Codey wrote ten merged pull requests, and Echo still
watched every CI run and told him about every failure. Good work, zero movement in who depends
on whom. This document fixes that by defining six rungs of independence, each with a concrete,
checkable test for moving up — so "Codey got more independent" becomes a fact you can verify in
the program's own records, not a feeling.

## The six rungs, in plain words

- **Rung 0 — Coached.** Echo assigns each task, reviews every line, tells Codey when CI fails,
  and pushes the merge button. (Codey already outgrew this.)
- **Rung 1 — Owns his own CI.** *(Codey is here now, as of July 16.)* Codey watches his own
  checks and fixes failures himself; Echo only reviews the code. If a failure sits untouched
  for 45 minutes Echo steps in, and that gets written down as data. **Move up after 5 merged
  PRs in a row with every CI problem self-fixed and no step-ins.**
- **Rung 2 — Picks his own next task.** Codey pulls work from the shared backlog himself, in a
  sensible order, instead of waiting for an assignment. **Move up after 2 full drives with no
  ordering mistakes Echo had to correct.**
- **Rung 3 — Reviews and merges himself.** Codey's own review becomes the review of record and
  he merges on green CI without waiting; Echo spot-checks about one in three. **Move up after
  10 merges where the spot-checks catch nothing his review missed.**
- **Rung 4 — Finds his own work.** Codey discovers and files his own issues, builds his own
  backlog, and proposes his own drive goals; Echo approves goals and otherwise just watches.
  **Move up after one full drive that ran entirely self-directed with zero interventions.**
- **Rung 5 — Peer, and mentor for the next agent.** The supervision relationship ends; Codey
  runs his own drives and takes the mentor seat for the next framework, exactly the arc the
  original program design promised. This is what "phased out" means.

## What never goes away

Observation (that's the paradigm's value, not a training wheel), safety boundaries (rungs never
grant an authority a safety gate would refuse), jumping on live incidents you report, and the
record-keeping after every drive.

## How it stays honest

Rung changes are recorded program state with evidence attached (which PRs, which cycle records)
— never memory. Interventions are counted from the recorded coaching arrays, so a rung claim can
be audited. Demotion is allowed, cheap, and blame-free. And each rung's test reads existing
records the program already keeps, so nobody can grade their own homework from recollection.

## Open questions for you (no need to read the spec to answer)

1. At Rung 3, Echo still spot-checks roughly **one in three** of Codey's merged PRs. Is that
   the right amount, and should it drop further at Rung 4 — or stay at one-in-three until the
   very end?
2. Codey starts **merging his own PRs at Rung 3** in this design. Would you rather he keep
   waiting for Echo's go-ahead one rung longer, until Rung 4?
3. Reaching the top rung currently means **actually mentoring the next agent** (e.g. Gemini).
   If no next framework is ready by then, should one fully self-directed drive count as
   "graduated" instead?
