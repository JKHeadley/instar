# Two bookkeeping entries before pushing the guard change

Before code can be pushed, two checks have to pass.

The first keeps a list of every source file on the path that delivers messages for one of the test agents, and each file must be either fingerprinted or explicitly left out with a reason. The new safety-check files are reachable from that path but take no part in delivery: in watch-only mode they only write notes. So they are listed as left out, each with the reason written next to it.

The second check makes sure every change that affects running agents carries a release note. Without one, the change would merge but never ship to anyone. The note says, in plain words, that nothing changes yet: the new rule only records where it would disagree with the current one, and switching it on is a later decision.

What needs deciding: nothing. Neither entry changes how anything runs.
