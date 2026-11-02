## What Changed

- The automatic merger no longer stalls behind a pull request it has given up on. Each round it moves past PRs it cannot act on (given up, or waiting before a retry) to the next-oldest ready one, still making at most one merge attempt per round.

## What to Tell Your User

Finished changes merge on their own again even when an old, stuck change is at the front of the line.

## Evidence

- On a live agent, a PR given up on since Oct 26 was the oldest ready one; rounds picked it and stopped, so a fix that passed its checks at 20:10 waited until 20:46. Unit tests cover the skip, and that a real attempt still ends the round.

## Summary of New Capabilities

None. This fixes merge ordering.
