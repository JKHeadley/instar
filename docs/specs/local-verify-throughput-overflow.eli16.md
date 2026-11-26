# Letting throughput work into a full test line — plain-English overview

Pull requests wait in a line of at most 10 to be tested. A pull request labelled "merge-throughput" (work that speeds up the line itself) is supposed to go to the front. But the label only reorders pull requests already in the line, and the line was full most of the day, so labelled pull requests were turned away at the door for hours and never got to the front.

Now a labelled pull request is let in even when the line is full, up to 5 extra places, and goes to the front as intended. Ordinary pull requests are still turned away when the line is full. After a server restart, everything that was waiting comes back, including those extra places.

Two details keep this safe. A pull request already in the line that gets a new commit keeps its place, even while the extra places are in use. And a pull request that fixes a broken main keeps its own existing way in, which has no fixed limit.

What you need to decide: nothing.
