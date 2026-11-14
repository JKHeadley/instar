# Seeing what a stuck check was doing

Before a feedback fix gets published, the server runs checks in a sandbox, each with a time limit. When one runs out of time, the server kills it, and the folders it was using get deleted. So if a check gets stuck without printing anything, nothing is left to show why. Fourteen of the last forty check failures were timeouts, and almost none of them can be diagnosed from what was recorded. I already guessed wrong about one of them tonight.

Now, just before killing a timed-out check, the server records two things: when the check first printed anything, or that it never did, and a short list of the processes that were running. That goes in the same failure record people already read, through the same secret scrubbing and size limits. The check still times out and fails exactly as before. Nobody has a decision to make, and undoing this is a plain revert.
