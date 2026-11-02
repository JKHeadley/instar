# Side-effects review: one missed pooled read no longer shows "part could not be checked"

## Change
`dashboard/console/home-model.js` adds `fillPartial(fresh, previous, listKey, now, at)` and `PARTIAL_GRACE_MS` (2 minutes). `dashboard/console/console.js` remembers the last complete answer for the pooled `attention` and `sessions` reads. When a later read is partial (some machines in `pool.failed`), the console shows the fresh rows from the machines that answered plus the missing machines' rows from the last complete answer, marked as retrying, and keeps retrying as before. After two minutes without a complete answer, or when a failure names no machine, the partial answer is shown as it is, with the existing "part could not be checked" wording.

## 1. Over-block
None. Not a gate.

## 2. Under-block
For up to two minutes, a new item raised on the machine that is not answering is not visible (its last known rows are). After that the partial warning shows as before. The card keeps its "Checking again automatically." line during the grace period, so it is not presented as fully fresh.

## 3. Level-of-abstraction fit
Presentation smoothing in the page that renders the read. The server's pool fan-out is unchanged. Correct layer.

## 4. Signal vs authority
No decision point. Not applicable.

## 5. Interactions
The existing retry loop is unchanged (a partial read still schedules retries). The last complete answer is kept in memory only for this page load. Only reads whose rows carry `machineId` (attention items, sessions) are filled.

## 6. External surfaces
Dashboard Home only.

## 6b. Operator-surface quality
The operator reported that "a part that could not be checked" appears too often. A pooled read currently answers in under a second from every machine; the message comes from single missed reads during a refresh. Checked on the preview by forcing the second attention read to come back partial: Home kept the full list and did not show the warning.

## 7. Multi-machine posture
This is about pooled reads across machines: it hides a single machine's transient miss and still reports a sustained one. Page code only.

## 8. Rollback cost
Revert the commit; no data.
