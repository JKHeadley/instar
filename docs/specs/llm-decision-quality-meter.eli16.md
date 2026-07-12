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
   (that's how the cost meter works). Two things happen there. First, automatically and for every
   call: a correlation ID is minted per decision, so the metrics rows, the decision record, and any
   later outcome all tie together — even when one decision retried across several AI providers.
   Second, opt-in per decision point: a call site can enroll by handing over its decision context,
   and exactly ONE decision record is written when the call settles. Enrolling is deliberate,
   per-site work (what context, in what bounded form) — the review corrected an early overclaim that
   this would be free.
2. **Outcomes, graded by evidence — with integrity rules.** When reality reveals whether a decision
   was right (the killed process's owner really was dead; the "done" run really passed its
   verification), that evidence is attached to the decision record. Grading in THIS build is strictly
   rule-based: each grade comes from a precise, named evidence rule (for example, a killed process
   "coming back" only counts against the kill if it's the same command AND the same owner AND that
   owner was actually alive at kill time — so you reopening your editor can never make a correct kill
   look wrong). Every grade records who graded it and by which rule; independent evidence always
   outranks a component's self-report; re-running the grader updates grades instead of piling up
   duplicates. Using an AI to interpret ambiguous evidence is designed but deliberately switched OFF
   until that interpreter has its own benchmark and injection defenses — a quality meter graded by an
   ungraded AI would be the original problem all over again.
3. **A read surface for the operator.** One API view answers: for each decision point, over a window —
   how many decisions, how many outcomes known, how many right vs wrong vs honestly unknown, trending
   which way. That's exactly the data needed to decide "this gate needs a bigger model" or "this
   prompt needs work". The trend is kept as small, content-free daily counts that live ~90 days —
   long enough to actually answer "over time" — while the detailed records keep their short 14-day
   life. The view reads from small indexed database tables written at decision time; it never
   re-parses the raw journal files (an early draft did, and review caught that it would have
   recreated the exact server freeze we debugged the week before).

Plus a guard rail: a CI check that refuses to let a NEW AI decision point ship without declaring its
provenance posture — wired (and it's verified, not just claimed), pending with a tracked follow-up,
or exempt from a short fixed list of allowed reasons (no free-text essays). Each point also declares
its volume class, because a few of our AI calls run thousands of times a day and recording all of
them in full would drown the store — rare high-stakes points record everything, chatty ones are
sampled or budgeted, and anything dropped by a budget is counted out loud.

## What does NOT change

Nothing gates on any of this — it's observe-only. No alerts are added. The decision records stay on
the machine that made them (the same privacy posture already ratified: full detail never leaves the
machine; only scrubbed summaries are readable remotely, and full content is never served over HTTP at
all). The review added teeth here: message bodies, transcripts, and process command lines never enter
the records at all — only fingerprints and bounded code-derived facts — so the served summaries can't
leak what the judged content contained. Everything ships dark/off by default and turns on gradually,
starting in dry-run on the development machine.

## The main tradeoffs

- We record more (bounded, clamped, volume-classed, 14-day detail / 90-day counts) in exchange for
  being able to audit judgment.
- The first build wires the two highest-stakes decision points, not all ~60 — the rest become a
  visible backlog the meter itself keeps re-surfacing (wired/pending/exempt counts on every read),
  instead of a silent gap or a pinned list nobody revisits.
- Grades will often be "unknown" at first; we chose honest unknowns over guessed grades — and
  "expired" (the record aged out before evidence landed) is reported as its own thing, never dressed
  up as a bad grade.
- On multi-machine setups, evidence that lands on a different machine than the decision is counted
  and reported as an orphan rather than silently lost; actually routing it home is a tracked
  follow-up.
