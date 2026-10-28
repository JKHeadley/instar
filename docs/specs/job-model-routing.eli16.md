# Job model routing — plain-English overview

## What this is about

An Instar agent runs scheduled jobs: checking its own health, reviewing its
learning pipeline, noticing promises it made, and so on. Today every job starts a
full AI session, and each session reads about 240,000 tokens of background
before doing anything. The first spec (job cost reduction) fixes the 17 jobs that
never needed an AI at all: they become plain scripts.

This spec handles the 20 jobs that are left. Justin asked for two things for
them. First, when a job really does need a model, it should run on the
best-value model the agent can reach, picked from Instar's own benchmark results
(for example OpenAI's GPT-6 Luna through Codex), with Claude as the fallback.
Second, use Jev (TypeSafe's fast classifier) to skip empty work only after its
answers have been validated. An uncertain answer lets the job proceed. After
**every script finishes**, Jev checks its result and decides whether a full
session is needed; Haiku or Luna takes over that check for each result when
Jev is unavailable. This includes script and pass jobs added here. Those
after-run checks are distinct from the two optional before-work checks in this
spec. One rule sits over both: an agent with only
one AI provider must still work
fully. Jev and Codex make things cheaper; they are never required.

## What changes, job by job

- **Commitment detection stops starting a session.** Every five minutes this job
  starts a whole AI session to read new Telegram messages and note any promise or
  action item as a tracked item with its deadline, which another job follows up
  when it goes overdue. It keeps doing exactly that, with the same question and
  the same tracked items, but as one small call inside the server instead of a
  session, and with no call at all when nothing new was said. Jev reads each new
  message first; once it has proven itself, a message Jev is confident holds no
  promise is not sent to the model. Jev must explicitly say "no" in both option
  orders; an uncertain or malformed answer still reaches the model. That proof
  is checked against what actually
  happened: whether the promises the model found were later completed. A message
  is never lost if a call fails: the job simply tries again on its next run. The
  pass and its session rollback share a per-topic cursor, so switching modes
  cannot hide messages from a second topic. On a
  one-provider agent nothing depends on Jev.
- **Two jobs become plain scripts.** The rope-health digest and the org-intent
  drift audit already get their wording from the server.
- **Eight more jobs become one server call each.** The five "overseer" reviews,
  the relationship check and the two weekly analyzers each read one report and
  write a short note. The server gathers the report, skips the model when there is
  nothing in it, and otherwise makes one call through the existing model router,
  which already prefers a non-Claude subscription and falls back to the agent's
  default. Where a message goes is decided by code. If the model fails, nothing is
  sent; after three failures in a row the operator gets one plain note saying the
  job cannot report. Their summaries pass the same credential and tone checks as
  any reply the agent sends.
- **Nine jobs stay as sessions.** They need tools. Four of the busiest (not the
  one that writes code) can be pinned to a different framework and model.

## How the model gets picked

For the four busiest session jobs that don't write code, a job can be pinned to
a framework and model, for example GPT-6 Luna through Codex. The pin is chosen
from benchmark results and added by a reviewed change, only when the benchmark
shows that model doing the job at most five points worse than the default and
clearly above 80%. Development agents try it first.

At each run, the pin is used only if that framework is installed, reachable and
not near its limit, and Instar's safety hooks are proven to block a dangerous
  command there (a small test run checks this every week and again whenever the
  runtime, safety hooks, configuration or slot changes). Otherwise the job
simply runs on the default, as today, and the record says why. If a pinned job
fails or has its work undone three times in a week, that machine switches it
back to the default and raises one note.

One honest point: today the benchmark has no results for GPT-6 models and no
tests shaped like these jobs. So no job is pinned until those tests are added
and run. Nothing claims a model was chosen on evidence before then.

## Jev as a "nothing to do" check

For two of the busiest Opus sessions (reflection and insight harvesting), Jev first answers "is there
anything worth acting on here?" Only a confident "no" skips the run, and only
for a job that has shown at least 30 such "no" answers, checked against what the
full run then did, with none of them wrong. One run in ten still runs anyway, and
a single wrong "no" switches skipping off for that job. Text is scrubbed of
secrets before it goes to Jev, and relationship records never go.

## How we know it worked

Every Jev or other model call in this change must leave a reviewable record:
which question it answered, the prompt version, the model actually used, its
cost and timing, what it decided, and what later evidence showed. Calls with no
known outcome stay marked unknown. A weekly bulk review can compare accuracy,
missed work, speed and cost across models and prompt versions. A model agreeing
with another model is a useful clue, but not proof that either was right. A new
call path stays off until its benchmark, records and grading can be checked.

The first spec adds per-job cost tracking. This spec freezes the week after the
first spec lands as its starting point and then reports, per job, tokens before
and after, how much Claude quota moved elsewhere, and whether quality held
(did the job's work actually land, was anything it did undone). The one-provider
version of each piece is measured first, so "works on one provider" is a measured
fact, not a hope. Each piece has its own off switch that brings back today's
behaviour.
