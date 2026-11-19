# Moving a hand-kept list of line numbers down by two

One test keeps a hand-written list of the exact line numbers of certain on/off switches in the agent's default settings file. On purpose, it must be updated by hand rather than regenerated, so that someone looks at each change.

The deletion-check change (PR 3498) adds eight lines near the top of that settings file: its watch-only setting, with a comment. Every switch below those lines therefore sits eight lines further down than the list said, and the test failed in the merge line.

This change moves all 30 entries down by eight and adds a short note explaining why. It changes no running code. Only the test's expected numbers change, and the test passes again.

What needs deciding: nothing.
