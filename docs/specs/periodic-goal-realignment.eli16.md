# ELI16 — A compass check for long-running work

## The problem

When I work autonomously for many hours, I keep deriving "the next obvious step"
from the previous step. Each hop is locally reasonable, but after enough hops the
path can point somewhere the operator never asked to go. That's exactly what
happened on July 23: the operator had to interrupt a long session and say, in
effect, "re-read everything I told you this week — your queue has drifted from my
actual priorities — and this check should be automatic."

Relying on me to remember to re-check is the exact failure mode this project's
first principle forbids: if a behavior matters, build it into the machinery.

## What this adds

A compass check. On a schedule (and every time a session boots into a topic with
active long-running work), the system:

1. Builds a short digest of what the operator actually asked for — read from their
   real, sender-verified messages in that topic over the last week. Not from my own
   notes: a drifted session summarizing itself would just re-inhale its drift.
2. Asks one model call: "does the current work queue still serve these stated
   priorities?" The answer is aligned, drifting, or diverged, with the specific
   neglected priority named.
3. Shows me the digest and the verdict. That's all it does — it never stops or
   edits my work. If drift persists across several checks, the operator gets one
   (exactly one) notice on the existing attention queue.

## Why it's safe

- It can only ADD information to my context, never remove capability or block a
  message. Every error path falls back to doing nothing, silently.
- It only trusts messages from the verified operator of the topic — a name that
  merely appears inside some document can't steer the digest.
- It ships dark and starts in dry-run: verdicts are computed and logged for review
  before anything is ever injected, so a noisy or wrong classifier is measured
  before it can nag.
- Its model calls are budgeted, metered per-feature, and routed off the primary
  account like other background checks.

## The one-sentence version

The operator's own recent words become a periodic compass check on long-running
work, so drift gets caught by machinery instead of by the operator's patience.
