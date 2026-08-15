# Regenerating a build file when it is out of date, not only when it is missing

## What this is

Part of the test setup generates a file from a source document before the tests
run. Two different setup files decide whether that generation is needed. Both
asked the same question: *does the generated file exist?* If it did, they moved on.

That question cannot tell the difference between a generated file that is correct
and one that was made from an older version of the source. Existing was the whole
test, so a stale file passed forever.

## How we know it is real

This was measured, not imagined. In one working copy the generated file had been
made at 17:59 from a source document that was almost three hours newer. Three test
files failed there with eight failed checks. Regenerating the file made all
seventy-seven checks in those files pass. Nothing else changed.

The uncomfortable detail is that the correct approach was already sitting twelve
lines above one of the broken checks: a sibling function that decides whether to
rebuild the compiled code does it properly, by comparing timestamps. One function
compared timestamps; the function directly below it checked only for existence.

## What changes

Both setups now ask whether the generated file is older than anything it is
generated from. If it is, they regenerate it. If it is not, they skip, exactly as
before. The comparison lives in one shared place, because two copies of a rule
that must agree is just a later bug.

## What is deliberately unchanged

Regenerating on every run would be wasteful, and being too eager here is the real
risk — this runs at the start of every test suite. So the rule is conservative in
three specific ways, each with a test:

- Equal timestamps count as fresh, so a file written in the same second as its
  source does not cause a regeneration on every run.
- If none of the source documents can be read, nothing is reported stale. A
  missing source must not trigger a regeneration that would then fail on the
  missing source.
- A genuinely absent file is still treated as needing generation, which is what
  the old check already did.

## What you would notice

Nothing, if your copy was already up to date. If it was not, tests that compare
against that generated file stop failing for a reason that has nothing to do with
the code you are working on — which is exactly the kind of failure that sends
someone hunting in the wrong place for an afternoon.
