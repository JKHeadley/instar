# Splitting the slow tests evenly — plain-English overview

Before a pull request merges, the Studio runs all of Instar's tests on it, in three groups at the same time. A run lasts as long as its slowest group. Two groups were slow: the integration tests (one piece, about 16 minutes) and the end-to-end tests (two pieces of about 9 and 17 minutes). The 17-minute piece decided how long every run took.

The end-to-end tests were split by counting files, not by how long the files take, so one piece got most of the slow files. Now:

- The integration tests run as 2 pieces and the end-to-end tests as 3.
- Each piece gets a list of files chosen by how long each file took in earlier runs, so the pieces finish at about the same time.
- If there isn't enough timing history yet, the tests fall back to the old way of splitting.

The timing history only decides which piece runs a file, never whether it runs. Every test still runs exactly once, and the existing checks still fail the run if a test runs twice or not at all. Wrong timing data can only make a run slower, never let a broken test through.

What you need to decide: nothing. If it causes problems, reverting this change restores the old split.
