---
title: Merge hand-off re-check
---
The live switch `monitoring.greenPrAutoMerge.handoffRecheck` is off when absent.
When enabled, a verified change refused only for `UNKNOWN` mergeability uses the
pass's direct read, then waits 5, 10 and 15 seconds for up to three further reads.
Only `MERGEABLE` at the verified head proceeds through the existing merge gates.
Each delayed read writes `handoff-recheck` to the watcher audit with its wait and
read seconds. The verifier's `merge-handoff-result` records `firstMergeable`,
`recheckEntered`, `recheckReads`, `recheckSeconds` and `recovered`. Correlate rows
with `handoffStartedAt`; a `merge-handoff-late-answer` is never a recovery.
`GET /local-verify` exposes `mergeLine.unknownHandoffs`, `recoveredHandoffs` and
`holdActiveSkips` since this coordinator started. UNKNOWN counts hand-offs refused as not mergeable whose first value was
UNKNOWN, with the switch off or on, including those that entered the re-check.
Other refusals whose list value happened to be UNKNOWN do not count. Both switch settings distinguish `not-mergeable-unknown` from
`not-mergeable-conflicting` in refusal answers. Collect the baseline with the
switch off before the operating session decides whether to enable it.
