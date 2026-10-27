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
   moves 17 of the 37 built-in jobs onto that path. When a script finds a
   problem, such as low disk space, it asks an AI to write one short message,
   once per problem, not once every 5 minutes. If no AI is reachable at all, a fixed message goes out
   instead, so a broken AI can never hide a health alarm.
2. **The checks still happen, just without a session.** Serious problems, such
   as a nearly full disk, are reported straight away. Smaller ones show up as a
   quiet note on the dashboard the moment they are seen. The part of the system
   that owns the problem tries to fix it. If a smaller problem is still there
   after 6 hours, you get one message about it.
   You hear about each problem once, not every 5 minutes.
3. **Two of your requests come in a second step, with its own spec.**
   - The jobs that really need an agent will move to the best-value model the
     Instar benchmark picks, such as Codex GPT-6 Luna.
   - Jev (TypeSafe) will take over the "did someone make a promise?" check.
     That job is switched off on Echo, so its real cost is not measured yet.
   - Review showed the promise check needs its own careful design, because
     messages come from several chats and several machines.
   - These jobs make up a small part of the cost, so the second step waits for
     the first step's real numbers. It is tracked so it does not get lost.
4. **A safety check stays, just cheaper.** Instead of an AI watching every run,
   one AI review a day looks over all the script jobs' recent results. A daily
   practice check also feeds every script a fake broken server and checks that
   each one still notices the failure.

## What stays safe

- An agent with only one AI provider still works fully. Jev, Codex and the
  benchmark only make things cheaper; when they are missing, everything falls
  back to the agent's normal model.
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
goes from about 756 million to under 10 million weighted tokens a week. The
remaining agent jobs (about 40 million) are the second step's target, with similar cuts on every agent that
uses the built-in jobs. The real numbers will come from the measurement, not this
estimate.
