# Why Jev failures had no cause, and the fix (plain-English overview)

## What this is

Some small yes/no decisions in Instar, such as "did the agent just promise to do something?", are first asked of Jev, a fast and cheap model. If Jev gives a confident answer, that answer is used. If Jev is unsure or fails, the question goes to the slower model that answered it before Jev existed (the incumbent). Every one of these decisions is written to a local record so we can later check how well Jev is doing.

## What went wrong

Over the last week, about one in nine Jev calls for the promise check failed. Each failure was recorded only as "jev-error", with no timing and no cause. The code that caught the failure threw the error away. The server log had nothing either. So nobody could tell whether Jev was timing out, the service was refusing requests (for example too many at once), the network connection was dropping, or Jev was sending back something unreadable. Each of those has a different fix, so the error rate could not be worked on.

## What is new

When a Jev call fails, the record now carries one of four fixed labels: timeout (the call was cut off for taking too long), http (the service answered with an error code, and the code number is kept), invalid-body (the reply could not be read), or transport (anything else, such as a dropped connection). It also records how long the call took, on both failed and successful calls. The error message itself is never stored, only the fixed label, so no request content or secret can leak into the record through an error message.

## What stays the same

Every failure still hands the decision to the incumbent exactly as before. Nothing about when Jev is asked, what it is asked, which model is used, or how confident it must be changes. The existing timing field from Jev itself is kept as it was.

## Safeguards

New tests feed the gateway each of the four kinds of failure and check the label, the timing (taken from a test clock, so it is exact), and that the record holds none of the error text. Another test checks successful calls now carry the timing. The existing tests for the gateway and for the two places that use it pass unchanged.

## What a reader needs to decide

Nothing. This only adds facts to a record so the error rate can be diagnosed. Once a release with this runs, the first real failure records will say which kind of failure it was.
