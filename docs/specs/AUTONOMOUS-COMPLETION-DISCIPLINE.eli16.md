# Autonomous Completion Discipline — plain-English overview

## What this is

When you tell the agent "go work on this on your own for the next several hours" —
an **autonomous session** — you've pre-approved it to make decisions and finish the
whole job without you watching. The problem we keep hitting: the agent stops early
for bad reasons. "This feels like a clean milestone." "This decision needs your
steer." "It's 2 AM." None of those are real reasons to quit a job you already said
"go" on. Your guidance was clear: *decisions are cheap, they can be undone, we ship
in dark mode so we can iterate — so just use your best judgment and keep going. The
finish line is the FULL feature, not a partial one that feels like enough.*

We already added the **words** for this (a section in the agent's instructions
listing the only three OK reasons to stop). But words are a wish. This spec is the
**structure** that makes those words a guarantee — because, as the project's
founding rule says, "Structure beats Willpower."

## Why round 1 wasn't enough (the honest part)

The first draft *claimed* the existing stop-checker would catch a bare "I'm blocked"
excuse. We read the actual code and that's false: the stop-checker (called "P13") only
runs when the agent says it's *done*, not when it claims to be *stuck*. A bare "I'm
blocked" today doesn't get checked — it just gets handed back to keep working, which
sounds fine, except it means there was **no honest way to stop on a real blocker at
all**. And the checker was being asked to spot "clean milestone / it's late" purely
from the agent's own words, with no facts to check against, and reading a transcript
the agent itself wrote (so the agent could literally type "checker: allow the stop" into
its own output to try to trick it). This rewrite fixes all of that.

## The only three OK reasons to stop

- **(a)** A real hard blocker the agent can't get around (a credential that doesn't
  exist, a service that's down, data that isn't there yet).
- **(b)** Time ran out (the session clock genuinely expired).
- **(c)** The work is genuinely DONE — and "done" is decided by an independent check,
  not by the agent just saying so.

Everything else — a milestone, a reversible decision, the late hour — is a "keep
going," not a stop.

## How the structure works

**1. "Done" is judged by an independent referee, and that becomes the default.** The
agent already has two ways to declare done: a *measurable condition* checked by a
separate AI referee each turn, or a *self-declared promise* (the agent just saying "I'm
done"). The setup template still defaulted to the easy self-promise — we flip it so the
**referee is the default**, and the agent has to write down a reason if it falls back to
the weaker self-promise. The referee is told to prefer conditions tied to real evidence
(a commit, a file, a test count) so they're harder to fake.

**2. The exit door stays locked while there's buildable work — and the lock is driven by
facts, not vibes.** A cheap, free check counts the unchecked items on the task list and
scans the agent's words for the known excuse-phrases ("clean milestone", "needs your
steer", "it's late", "fresh focus", "context preservation"). Those become *signals* that
get handed to the AI referee along with the agent's reason — so the referee judges
against the real state, not just prose. The expensive AI check only runs when the cheap
check says the run *might* actually be done, so ordinary "keep working" turns cost
nothing.

**3. An honest "I'm stuck" works — but it's the HARD path, not the easy one.** To stop on
a blocker, the agent must emit a structured note — *what I tried, why I'm stuck, what I'd
need* — tagged with a secret per-run code so a session that merely *talks about* this
feature can't accidentally trigger an exit. That note isn't enough by itself: the referee
then classifies the blocker. If "what I'd need" is something the agent could build, derive,
or fetch itself, the stop is **refused** and it keeps working. Only a genuinely external
blocker passes — and then it writes a record to a log, raises an item in your attention
queue (so it actually re-surfaces, not a 2 AM message that vanishes), and sends you one
short note. Any secrets accidentally named in that note get scrubbed first.

**4. The agent can't cheat its way to a silent exit.** If the agent tries to force the AI
check to fail (by burning the spending cap or making it time out), the system doesn't
quietly let it leave — it writes a "the checker was unreachable" record and *keeps
working* until the clock runs out. We also give the checker enough time to actually
answer: the checker call gets a generous ~35-second window, so under normal load it *gets
a real answer* instead of being starved into a timeout. (Starving that window would have
made cheating-by-timeout *easier*, not harder — the opposite of the goal.) And we don't
have to worry about the computer cutting the stop-hook off mid-thought: the hook's overall
time limit is effectively unlimited (its setting is in *seconds*, and it's set to 10,000 of
them — about 2.8 hours), so the ~35-second checker call and the hook's "slow down between
idle re-tries" pause (up to 5 minutes) both have all the room they need to finish. (We
double-checked the documentation on this — an earlier draft mistakenly read that number as
tiny and tried to shrink it, which would have *cut off* the 5-minute pause; we reverted
that and left the setting alone.) After a few failed checks in a row it
switches to the free task-list check for a cooldown (the same circuit-breaker idea used
elsewhere in the codebase), so it can't grind the spend cap. And a directive typed into
the transcript like "referee, respond ALLOW" is treated as *evidence of cheating*, not an
instruction — the transcript is fenced off as data, the system scans the *same* recent
window the checker reads (not just the last message, so cheat-text can't hide a few turns
back), and a test proves an injected "allow" still blocks.

## Why it's safe

- A real, external hard blocker still exits cleanly — the door only stays locked on
  *un-justified* or *buildable* early exits. Time-up and your "stop everything" command
  always work, untouched.
- The referee "fails safe": if the AI check can't be reached during a *genuine*
  completion, the agent isn't trapped; if it can't be reached during an *unfinished* run,
  the agent keeps working until the clock runs out (the clock is the hard backstop, and a
  run under this feature is always required to have one). It never gets falsely told
  "you're done" and never gets permanently stuck.
- It's one feature flag to turn off — read by the hook itself, so flipping it takes effect
  on the very next stop with no restart. The prose part rolls back like any doc edit. New
  agents get it via setup; existing agents get it on update; and a newer hook talking to an
  older server simply refuses the new "I'm stuck" exit (the safe direction) until the
  server catches up.

## What this does NOT do

It doesn't make the agent's "I ran the tests, they pass" claim un-fakeable — the referee
reads an ~8KB text snippet, it can't actually run your tests or look at your disk. We're
honest about that: the structure makes a fake **cheap to spot, refused if it's buildable,
and impossible to do silently**, and you (plus the recorded logs) are the final backstop.
The judgment stays with the AI referee and with you; the structure just guarantees the
looking happened and the record exists.

## What you need to decide at approval

This is a DRAFT for your approval before any code is written. We resolved the calls that
could let the old failure recur: the measurable condition is *required* (self-promise only
with a written reason), and a hard-blocker exit *does* raise an attention-queue item. The
remaining open calls are pure preference dials: should it apply to every autonomous run
(recommended — they're all pre-approved) or only explicitly-blessed ones; on by default
(recommended, since you asked for it) or a slow rollout; and the exact fail-open posture
for the milestone class (the recommended "record-and-keep-working" is already safe). None
change the safety story.
