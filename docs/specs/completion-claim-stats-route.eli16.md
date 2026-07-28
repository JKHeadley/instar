# ELI16 — a safety check that could never be switched on

## The short version

There is a feature that watches the agent's own outgoing messages and flags factual claims it
can't back up. It has been running for weeks in a "watch but don't act" mode. It was supposed to
graduate to doing something real once it proved itself.

It could never have graduated. The number that proves it works was impossible to read.

## What was actually wrong

The plan for this feature says, in writing: turn it on properly once it has classified at least
one claim. Sensible — don't enable a checker until you've seen it check something.

To read that number, the plan points at an address. That address was never built. Not "broken" —
never built at all. Meanwhile the code that counts the number exists, works, and has been
counting the whole time, with nothing anywhere calling it.

So the feature sits in watch-only mode forever. Not because it's failing — the records show it
observing and recording, dated today — but because the one number that would let anyone say
"yes, it's working, switch it on" is unreachable.

## Why nobody noticed

Because a feature stuck in watch-only mode looks exactly like a feature that is being careful.

There's no error. Nothing crashes. Nothing raises an alarm. Every day it does its watching, and
every day nobody can check on it, and the absence of a complaint reads as "still soaking, still
fine." It would have stayed there indefinitely.

## What changed

Two small things.

The counters now have an address you can read them at. And the plan's pointer, which named an
address that didn't exist, now names the one that does.

That's all. The feature still doesn't do anything new — it still just watches. But now someone
can look at it and decide whether it has earned the right to do more.

## The detail worth keeping

One of the tests checks that when the feature has counted **zero** claims, the answer is the
number zero — not a missing field, not an empty response.

That sounds pedantic and isn't. A missing number is indistinguishable from "this address doesn't
work," which is the exact confusion that created this problem. If the answer to "how many claims
has it classified?" can come back as nothing-at-all, then a genuinely idle feature and a broken
endpoint look identical, and we're straight back where we started. Zero has to say zero.

## What this doesn't fix

This makes the feature *measurable*. It does not make it graduate — whether the evidence is good
enough to switch it on is a separate decision for a person to make, on purpose.

And there's a bigger question underneath, which is written down rather than answered: how many
*other* features are parked in the same way, pointing at evidence that was never built? This
found one. Nobody has checked the rest.
