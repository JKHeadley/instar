## What Changed

When the feedback executor reacquires its owner lease during verification, it now adopts an intact same-machine fix and repeats verification under the new epoch instead of discarding the worker's change. Attempts on another machine or without the required review tree and publish clone still stop safely. If a push or PR creation may already have happened, the executor holds the item and asks for reconciliation instead of publishing twice.
