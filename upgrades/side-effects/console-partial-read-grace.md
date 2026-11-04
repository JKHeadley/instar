# Side-effects review: one missed pooled read no longer shows "part could not be checked"

## Change
The Home attention read asks for open items only (`/attention?scope=pool&status=OPEN`); the server already forwards that filter to each machine. A machine's full attention history includes closed items: on the Laptop it was 1,770 items and 1.5 MB, and took 0.4 to 3.7 s to send, enough to miss the 5 s per-machine limit. Open only, it is 217 items and 140 KB, and the pooled read took 0.1 to 0.7 s.

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
The existing retry loop is unchanged (a partial read still schedules retries). The last complete answer is kept in memory only for this page load. Only reads whose rows carry `machineId` (attention items, sessions) are filled. Home never used closed attention items (`buildNeeds` keeps only OPEN), so the narrower read changes nothing it shows.

## 6. External surfaces
Dashboard Home only.

## 6b. Operator-surface quality
The operator reported that "a part that could not be checked" appears too often. Sampled on the Studio: the full pooled read missed the Laptop in 2 of 10 reads (5.0 s timeouts); open-only reads answered in 0.1 to 0.7 s. A separate cause, a machine whose Cloudflare route returns HTTP 530 while its Tailscale route works, is fixed in its own change (pool reads fall through to the next route). Unit tests cover the merge, the two-minute limit and failures that name no machine.

## 7. Multi-machine posture
This is about pooled reads across machines: it hides a single machine's transient miss and still reports a sustained one. Page code only.

## 8. Rollback cost
Revert the commit; no data.
