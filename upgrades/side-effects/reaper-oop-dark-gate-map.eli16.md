# Moving a hand-kept list of line numbers down by two

One test keeps a hand-written list of the exact line numbers of certain on/off switches in the agent's default settings file. On purpose, it must be updated by hand rather than regenerated, so that someone looks at each change.

The reaper change (PR 3490) adds two lines to that settings file: the new hourly cleanup interval, with a comment. Every switch below those lines therefore sits two lines further down than the list said, and the test failed in the merge line.

This change moves the 25 affected entries down by two and adds a short note explaining why. It changes no running code. Only the test's expected numbers change, and the test passes again.

What needs deciding: nothing.
