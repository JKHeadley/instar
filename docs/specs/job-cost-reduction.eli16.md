# Job cost reduction — plain-English overview

## What is going on

Instar agents run scheduled "jobs": small tasks on a timer, such as "check the
server is healthy every 5 minutes". Today every one of those runs starts a full
AI session. Before the session does anything, it reads about 240,000 tokens of
background instructions. Then, for most jobs, all it does is run one fixed
command and stop.

Last week Echo ran about 3,140 of these sessions. Together they used about 756
million weighted tokens. Nearly all of that came from five jobs whose
instructions literally say "run this command exactly as written, do not change
it". The AI adds nothing there. Sometimes it even breaks the command by
retyping it. Other agents (Bob, Cora, AI Guy, Luna, Monroe) have the same
problem, because they all use the same built-in job templates.

## What the spec changes

1. **Jobs that are just a command run as a plain script, with no AI at all.**
   The scheduler can already run scripts without starting a session. The spec
   moves 17 of the 37 built-in jobs onto that path. A second spec (job model
   routing) handles the rest, and each job belongs to exactly one of the two. When a script finds a
   problem, such as low disk space, it asks an AI to write one short message,
   once per problem, not once every 5 minutes. If no AI is reachable at all, a fixed message goes out
   instead, so a broken AI can never hide a health alarm.
2. **The checks still happen, just without a session.** Serious problems, such
   as a nearly full disk, are reported straight away. Smaller ones show up as a
   quiet note on the dashboard the moment they are seen. The part of the system
   that owns the problem tries to fix it. If a smaller problem is still there
   after 6 hours, you get one message about it.
   You hear about each problem once, not every 5 minutes.
3. **Jev decides when a job's result needs a real session.** For five jobs whose
   results can carry something a fixed rule cannot read (the health check, the
   three feedback-factory jobs and the check-in reminder), any result that is
   not a plain "all fine" goes to Jev with one question: is this routine, or
   does it need a real AI session to look into it? When Jev is unsure, a bounded
   investigation session starts. Jev can only add
   sessions: a fixed rule (a job that fails twice in a row, or a serious
   problem like a nearly full disk) always gets one, whatever Jev says.
   - A session started this way is an investigator: it gets a fixed brief, a
     reduced set of tools, and is told not to re-run the job or message you;
     what it found is recorded on the dashboard.
   - At most one per job and problem every 6 hours, 3 per job and 6 per
     machine a day.
   - The other script jobs report counters or let the server raise its own
     alert, so nothing reads them per run.
4. **Outage replacement, and one review a day.** Only while Jev is unavailable,
   Luna or Haiku reads a sample of the results called routine at most every 6 hours, and
   says how many it did not get to. Once a day, a single review looks across all
   the jobs. A daily practice check also feeds every script a fake broken server
   and checks that each one still notices the failure.
5. **One request comes in a second step, with its own spec.**
   - The jobs that really need an agent will move to the best-value model the
     Instar benchmark picks, such as Codex GPT-6 Luna.
   - Jev for the "did someone make a promise?" check also waits for that step:
     it needs its own careful design, because messages come from several chats
     and several machines.

## What stays safe

- **Audit gate added 2026-10-27:** Justin requires every Jev or other AI call to
  support regular bulk reviews of cost, performance and accuracy. Until the new
  job calls have benchmark cases, decision records and outcome grading, code
  keeps Jev triage, its fallback, the model-written anomaly sentence and the
  daily model review off. Saved settings cannot override this. Only the
  deterministic grading job runs as a script on development agents; the
  correction-class backfill can make a model call and stays a session until its
  benchmark coverage is complete. Other jobs
  keep their current session behavior. This means the large projected savings
  remain a target, not an achieved result.

- An agent with only one AI provider still works fully. Jev, Codex and the
  benchmark only make things cheaper. With no Jev, each script's own fixed rule
  decides whether a session is needed (a real failure or a critical problem),
  and the 6-hourly backup check runs on the agent's normal model.
- Sending job results to Jev (TypeSafe, an outside service) is switched on only
  for development agents like Echo. Other agents keep the fixed rule and the
  backup check until a later change turns it on for them and says so.
- Script jobs themselves also start on development agents only; everywhere else
  the jobs keep running exactly as today until a later change switches them.
  The first development-agent wave includes one job; its model-backed
  supervisor stays inactive until the audit gate opens.
  On an agent where this rollout is off, the new supervisor stays inactive; it
  does not start a new AI session just because its script is disabled.
  The other converted jobs wait for the first wave's 48-hour review.
- Existing agents get the change automatically when they update, because
  built-in job files are already rewritten on every update.
- One switch in the config file turns the old behaviour back on, live.
- A gap found during this work is fixed: script jobs did not take the
  "only one machine runs this" lock, so on a multi-machine agent the same job
  could run twice. Scripts will take that lock like every other job.

## How we will know it worked

Before switching anything, we save a one-week token count per job. A week after
each job switches, a report compares before and after for that job. It also checks
that the cheaper job still catches real problems as often as before.

## Expected savings

About 95% of the measured job cost. For the five jobs that use the most, Echo
goes from about 756 million to roughly 10 million weighted tokens a week, plus the few real sessions Jev asks for. The
remaining agent jobs (about 40 million) are the second step's target, with similar cuts on every agent that
uses the built-in jobs. The real numbers will come from the measurement, not this
estimate.
