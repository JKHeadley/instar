# Local release counts publish runs waiting in the concurrency group

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`npm run release:local` refuses while any publish.yml run is unfinished. It queried GitHub by status (queued, in_progress, waiting, requested, action_required), which never returns a run GitHub marks `pending` while it waits behind another run in `concurrency: publish`. It now also lists the 100 most recent publish.yml runs unfiltered and counts every run not `completed`, so a pending run is named among the runs to cancel. A failed query is still unknown, which stops a real release.

## Evidence

At 2026-11-03T01:55Z publish run 41559178936 was queued and 41561504298 was pending. The previous check returned `{"state":"active","ids":[41559178936]}`; the fixed check returns `{"state":"active","ids":[41559178936,41561504298]}` against the same live repository. Unit tests cover a pending run, a run seen by both queries, and a failed recent-runs query.
