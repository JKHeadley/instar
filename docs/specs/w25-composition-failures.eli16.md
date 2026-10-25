# What this change is, in plain English

Window 25 is taking seven repairs that were each built and tested on their own during Window 24
and turning them into one release that actually runs on the machine. When those seven were put
into a single copy of the code for the first time, two tests broke — and neither of them broke
because any single repair was wrong. They broke because of what the repairs did *together*.

This change fixes those two breakages. It is not new capability; it is the cost of composition,
paid honestly.

## The first breakage: two error paths that fail quietly

The project has a rule, enforced by a test, that an error path must not swallow a failure in
silence — if something goes wrong and the code falls back to a default, it has to say so first.
The test counts how many places still do it silently and refuses to let that number grow. The
ceiling was 496.

After the merge the count was 498. Two error paths that were fine in isolation became silent
fallbacks in the combined code: one that works out which agent a request belongs to, and one that
records a discrepancy in the session list. There were two ways to make the test pass. The wrong
way is to raise the ceiling to 498, which is the exact move the ceiling exists to prevent. The
right way, taken here, is to make both paths report the failure before falling back — so the count
returns to 496 because the code genuinely improved, not because the bar moved.

## The second breakage: two answers to "is this session alive?"

One of the Window 24 repairs made a crashed terminal pane stay around a little longer, so that the
reason it died can be read off it rather than lost. That repair taught the *asynchronous* check for
"is this session still alive?" to recognise a pane that is being kept around after death.

It did not teach the *synchronous* check the same thing. So the codebase ended up with two
functions answering the same question differently: one correctly saw a dead-but-retained pane as
dead, and the other still saw it as alive. A test that starts a session designed to crash then
waited five seconds for a death it was never going to be told about, and failed.

The fix teaches the synchronous check to read the same signal as the asynchronous one. The
alternative — making the test wait longer — would have made the failure disappear without fixing
anything, and a test that passes because it waited is a test that has measured nothing.

## Why this was invisible until now

Every one of these repairs passed its own tests. None of them had ever been in the same copy of
the code as any other. Both defects here are real and both would have shipped. That is the whole
argument for building one integrated candidate instead of merging seven things one at a time and
trusting that green plus green equals green.

## What you would need to decide

Nothing, if you agree that a ceiling should not be raised to accommodate new silent failures and
that two functions answering the same question should agree. If you disagree with either, this is
the change to push back on.
