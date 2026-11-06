<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The lifecycle end-to-end test no longer fails under load at its final "saved to disk" check. Before running a job by hand, it now ends its own leftover sessions instead of waiting for them to finish. It then checks right away that the job really started. Test-only; no runtime change.

## Evidence

With the fake sessions slowed to copy a busy machine, the old test failed 2 of 2 runs, matching GitHub Actions job 127321800225. The fixed test passed 10 of 10 runs across slow, slow plus high memory pressure, and normal conditions.
