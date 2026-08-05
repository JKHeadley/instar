# Plain English: "nothing to do" is not the same as "something went wrong"

> **This document was rewritten.** My first design was wrong, an outside reviewer challenged
> it, and a two-minute audit of the real system proved the reviewer right. What follows is
> the corrected version, and it explains what I got wrong, because that's the useful part.

## The one-sentence version

Some scheduled jobs check first whether there's anything to do — and when the answer is
"nothing right now", the scheduler treats that as a **failure** and punishes the job. This
change lets a job say which of those two things its check actually means.

## What already exists

A job can carry a **gate**: a small command that runs first and answers one question. It's
there to save effort — rather than waking a whole session to find nothing to do, the gate
answers in milliseconds for free.

There's also a **retry ladder**. When something genuinely fails, the scheduler backs off and
tries again: after 1 minute, 5, 15, 30, an hour, two hours. Sensible for something broken.

## What's wrong

They're wired together incorrectly. When a gate says "nothing to do", that gets filed as a
*failure* and starts the ladder.

So a healthy job with no work at 2am isn't asked again at 3am on schedule. It's asked at
2:01, 2:06, 2:21, 2:51, 3:51, 5:51 — then the scheduler logs "exhausted 6 retries", the same
thing it says about a genuinely broken job.

- **Wasted effort** — the gate also retries internally, so one run can execute it **18 times**
  to be told the same thing.
- **The schedule gets wrecked.** This is the real damage. An idle job becomes a *late* job,
  wandering up a ladder instead of sitting on its clock. When work finally appears, it may be
  hours from its next check.
- **The alarm stops meaning anything.** "Exhausted 6 retries" should mean "look at this".
  Healthy jobs emit it constantly.

Not theoretical: one job, `insight-harvest`, was watched climbing the whole ladder and
exhausting it three times, every line blaming the gate.

## What I got wrong, and how it was caught

My first design was clever and broken. I noticed the computer already knows *how* a command
failed — whether it ran and chose to exit unhappily, or was killed, or never started — and I
built the fix around reading that.

An outside model reviewing the spec said: careful, real gates might report ordinary
operational failures with ordinary exit codes. So I went and **counted every gate on a live
agent**. The result:

| what the gate actually is | how many |
|---|---:|
| "is the server up?" — a health check | **15** |
| "is there work?" — the case I was designing for | **4** |
| "does this file exist?" | 1 |

**Only 4 of 20 gates mean what I assumed they all meant.** Fifteen are health checks, where
a failure means "the server is restarting, try again shortly."

And I measured what those actually return: a health check against a stopped server exits
with code **7**. An ordinary number. My design would have read that as "no work to do" and
sent the job away until its next scheduled slot — **for 15 of 20 jobs, during a restart,
which is exactly when they most need to retry.** My fix would have made things worse.

The lesson is simple: the same command means "no work" in one job and "the server is
restarting" in another. **Nothing about the running command can tell them apart, because the
difference is in what the author meant.** So the author has to say.

## What's new

**A job can declare what a failing gate means:**

- **"precondition"** — something's temporarily in the way. Retry as today. **This is the
  default, so every existing job keeps behaving exactly as it does now.**
- **"no work"** — a real answer. Skip, and leave the schedule alone.

Only the 4 genuine work-checks opt in. The 15 health checks are untouched.

We still separate "the command couldn't run at all" (a typo, a timeout) from "the command
ran and answered" — a mistyped gate should retry, never be mistaken for "no work". But that
distinction no longer has to carry the meaning; the declaration does.

## The safeguards, in plain terms

- **The default is the safe one.** Doing nothing keeps today's behaviour. The new behaviour
  is opt-in, one job at a time.
- **When in doubt, behave like today.** An unrecognised failure retries, as now.
- **We don't clear the wrong thing.** An earlier draft wiped a job's backoff whenever a later
  check found no work — including backoff from a *real* failure. Now only gate-related
  backoff is cleared.
- **Tests must be able to fail.** Each test is paired with one that *must* fail. Most
  importantly: a test that would pass if the default were set backwards must fail, because
  getting the default wrong is the one mistake here that would do real damage.
- **Rollback is one revert** plus removing a line from 4 job files. No stored data changes.

## What you actually need to decide

**One thing, and it's small now.**

The 4 jobs that opt in are chosen by me from the audit. If you'd rather start with just
`insight-harvest` — the one actually observed suffering — and add the others after watching
it for a week, say so. That's a one-line change and a defensible instinct.

Everything else that was a judgement call in the first draft has been removed by the audit.
I'm no longer asking you to accept a trade about broken gates going quiet, because the
design no longer routes anything into that path by default.

**And the honest summary:** this is the second time tonight that checking my own premise
killed my own design. Both times it happened before any code existed, which is the whole
point of doing it this way — but it does mean the first version of this document confidently
described a change that would have degraded the system.
