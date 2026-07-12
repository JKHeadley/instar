# The LLM-Decision Quality Meter, in plain English

## What problem this solves

The agent makes hundreds of automated judgment calls a day using AI models: "is this process a
runaway that should be killed?", "is this autonomous run actually done?", "does this message need
to be blocked?". Today we have an excellent COST meter for those calls — which model ran, how many
tokens, how fast — but no QUALITY meter. We can see that a judge fired; we cannot see what it looked
at, and we never find out whether it was RIGHT. The recent accountability audit confirmed it: the
two highest-stakes decisions in the whole system (killing a process, and deciding an autonomous run
can stop) write down nothing about what they saw or why they chose. And the one mechanism built for
this — a decision journal with an "annotate what actually happened later" hook — is wired to just
two places, and the "what happened later" hook has literally zero users.

## What we're building

Three connected pieces:

1. **One shared recording seam.** Every internal AI call already flows through a single chokepoint
   (that's how the cost meter works). We add decision recording at that same chokepoint, so any
   decision point can opt in by handing over its context — no rewiring of a hundred call sites. Every
   decision gets a correlation ID that ties together the metrics row, the decision record, and — later —
   the outcome.
2. **Outcomes, graded by evidence.** When reality eventually reveals whether a decision was right
   (the killed process's owner really was dead; the "done" run really was done), that evidence gets
   attached to the decision record. A periodic background job (off by default, cost-capped) sweeps
   decisions whose outcome window has passed and grades them: right, wrong, or honestly unknown.
   Ground-truth evidence always outranks an AI's opinion — an AI is only ever the interpreter of
   evidence, never the source.
3. **A read surface for the operator.** One API view answers: for each decision point, over a window —
   how many decisions, how many outcomes known, how many right vs wrong, trending which way. That's
   exactly the data needed to decide "this gate needs a bigger model" or "this prompt needs work".

Plus a guard rail: a CI check that refuses to let a NEW AI decision point ship without declaring its
provenance posture (wired, pending, or exempt-with-a-reason) — so the coverage can only grow.

## What does NOT change

Nothing gates on any of this — it's observe-only. No alerts are added. The decision records stay on
the machine that made them (the same privacy posture already ratified: full detail never leaves the
machine; only scrubbed summaries are readable remotely, and full content is never served over HTTP at
all). Everything ships dark/off by default and turns on gradually, starting in dry-run on the
development machine.

## The main tradeoffs

- We record more (bounded, clamped, 14-day retention) in exchange for being able to audit judgment.
- The first build wires the two highest-stakes decision points, not all ~60 — the rest become a
  visible, pinned backlog instead of a silent gap.
- Grades will often be "unknown" at first; we chose honest unknowns over guessed grades.
