# Learning velocity counts absorbed corrections, not detected corrections

## What was wrong

The learning-velocity score is meant to answer “are we actually learning?” Its action-queue half already learned a hard lesson: writing down an action is not learning, so actions count only when they finish.

The correction half still made the original mistake. It counted a correction the moment the system detected and stored it. The live ledger had 37 correction records and zero promoted preferences, yet all 37 were scored as learning events. That helped produce another flattering 88/100 “accelerating” score from work that had not completed.

## What changes

A correction now counts only after the correction loop reaches its successful `verified` state. That state means the routed preference still exists and the correction did not recur during its verification window. The event is dated at `updatedAt`, when verification completed, never at `detectedAt`, when the observation was filed.

The just-shipped paraphrase clustering adds one more necessary rule. A cluster can retain several exact correction records while producing one preference. Learning velocity therefore counts one event per durable routed cluster, not one event per member. Older verified rows without a cluster identity still count individually.

## What stays honest

Open, acted-on, reopened, inconclusive, and timestamp-less verified rows do not count. The endpoint reports how many correction rows it considered, how many completed learning events it counted, how many member rows it coalesced, and why other rows were excluded. If the optional correction ledger cannot be read, the metric remains available but reports the source error instead of quietly presenting a partial denominator as complete.

The score remains read-only and advisory. It controls nothing; this change repairs what the instrument reports.
