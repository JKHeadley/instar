# ELI16 — the push check now says "couldn't check" instead of "tests failed" when no tests ran

Before you push code to instar, a small script runs only the tests your change affects. Sometimes it can't work out which tests those are, because the lookup times out, so it runs none at all. It used to report that the same way as a real failure, and the hook printed "Tests failed". People then went hunting for a broken test that didn't exist.

Now the script uses a special exit code (3) for "I couldn't tell which tests to run, so I ran zero". The hook sees that code and says plainly that the push was blocked because nothing was verified, not because a test failed. The push is still blocked in exactly the same cases as before; only the explanation is now true.

Why it matters: a wrong "tests failed" message costs time twice. First someone looks for a failure that isn't there, and then they learn to distrust the message, so a real failure gets ignored later.
