## What Changed

The combined locked-Mac proof harness waits for its exact approved request receipt as well as visible controls before starting a case. Missing or expired evidence fails after a bounded wait.

## What to Tell Your User

No new action is needed. This improves developer proof reliability; a live Mac acceptance run is still required.

## Summary of New Capabilities

No product capability added. Proof sequencing now rejects an asynchronous response-body race.

## Evidence

An actual grant-opening mock reproduced the race. The corrected timing and driver tests pass103/103. No live Mac actions were performed.
