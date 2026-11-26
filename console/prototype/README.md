# Console prototype — first screen

A working first screen for the rebuilt operator console, generated from **live
agent data**. Not wired into the product, not deployed, not reachable from the
existing dashboard. It exists to test the research conclusions against reality
before any of them become a design.

Run `build-console.py` to produce `console.html` from the running agent;
`refresh-console.sh` regenerates and republishes it every five minutes so a
shared link shows current state rather than a snapshot. The refresher stops
itself after twelve hours rather than running unattended for ever.

`example-output.html` is one real render, kept so the shape is reviewable
without a running agent.

## What it shows, and why those four things

From `../research/SYNTHESIS.md`: all three products studied independently
arrived at *the agent disclosing what it did and what it was allowed to do*,
together and always visible. Instar records more of that than any of them and
displays none of it. The four sections are that conclusion, built:

| Section | Source | Why |
|---|---|---|
| **Can I reach you** | `/health` | Replies written but not delivered, and how old the oldest is. **First**, because an agent that cannot reach its operator cannot report that it cannot reach its operator. |
| **What needs you** | `/attention?scope=pool` | The queue with no human-facing surface. First because an item nobody sees is an item nobody acts on. |
| **What I'm doing** | `/sessions?scope=pool` | Live sessions across **every** machine, grouped by machine. Names any peer that could not be reached — a fleet view that quietly drops an unreachable machine is indistinguishable from one where everything is fine. |
| **What I've promised** | `/commitments` | Open commitments with what each is blocked on. A follow-through store with no face on it. |
| **Where I'm running** | `/pool`, `/health` | Which machines exist and which holds the right to speak. |
| **What I'm allowed to do** | `/guards?scope=pool` | Guard posture, read from the endpoint's own summary. |

## The design rule it is actually testing

**A value that could not be read must say so, never render as fine.** Three
things in this file exist only because of that:

- A source that errors prints *"Can't tell: …"* with the reason, not an empty
  section.
- `What I'm doing` prints *"Not recorded"* rather than filling the space. The
  first version printed the session's internal bootstrap prompt — a file path
  that looked like an answer and was not.
- The guard counts are read from `/guards`'s own `summary`, not recomputed.
  The first version did `if guard.effective`, and `effective` is a **string**:
  `"off"` is truthy in Python, so it rendered 91 guards as on when 54 were off.
  A console written to catch instruments that claim everything is fine, claiming
  everything was fine. It was caught only by looking at the rendered page.

That last one is the whole argument for the project, committed by the project,
and it is left in the file's comments deliberately.

## What it found on first run

Pointed at this agent, it immediately surfaced 126 open attention items, 36 of
them high, of which 26 were replies to the operator that had been held and then
expired undelivered — the oldest eleven days old, three expired that same day.
Every one had been recorded correctly the whole time. Nothing displayed them.

## What the fleet view surfaced immediately

Twelve sessions across three machines. Two of them on a second machine were named
`held-probe` / `held-probe2` — another of this agent's own sessions already
investigating the held-reply fault, which the session writing this had no way to
know it was duplicating. A third had been running seven hours.

Every one of those facts was already recorded. None were visible, including to the
agent, including while it worked on the problem they describe.

## Tested, not assumed

The claim that a value which could not be read says so is easy to write and easy
to get wrong. It was verified by pointing the generator at a port nothing listens
on, so every source fails exactly as it would if the agent were down.

Result in `example-output-degraded.html`: all six sections render, every one reads
*"Can't tell: the agent is not answering on its port."*, and **no section
fabricates a zero**. A reader cannot mistake an unreachable agent for a healthy
 quiet one.

The *slow* case is tested separately, because it is the one that actually caused
trouble: an agent that accepts the connection and never answers. Against an
endpoint that holds every connection open, the generator still completes — it does
not hang — and every section reads *"Can't tell: the agent took too long to
answer."* (`example-output-slow.html`).

Dead and slow are therefore distinguishable on the page. That is the distinction
the research argues an operator console must make, and the one whose absence cost
this project several hours when the agent's own instruments reported a healthy
server as unreachable. The cost is latency: against a fully-hung agent each build
takes about three minutes rather than seconds, because every source waits out its
own timeout.

The failure wording is plain rather than numeric. It first said `(7)` — a curl
exit code, which is noise to anyone who has to act on it.

## Honest limits

- A snapshot generator, not an application: no interaction, no navigation.
- `focus`/`lastAction` in the parallel-work index are empty on this agent, so
  "what each session is doing" has no real source yet and says so.
- Sessions, attention and guards are pool-scoped. Promises are this machine only — `/commitments` accepts `?scope=pool` and ignores it — and the screen says so rather than presenting a partial count as a whole one.
- The highest-value finding in the research — Grok's *"Take over / I'm done"*
  hand-off — is **not** built here. It needs a session-level mechanism, not a
  screen.
