# Budgeted Local Source Claims

Inside the real imported-history writer, `planSourceClaimWrite` adds a one-use content plan for durable local-source provenance before any transcript append. `executeWritePlan` checks the numeric content ceiling and audited SQLite pager settings. An identical durable claim can activate at zero content cost. This does not provide an actual disk reservation, current owner admission or copy consent.

The budgeted path preserves and refuses journal/WAL/SHM recovery state before SQLite opens. It supports only the audited fixed pager path; do not repair a refused mode or delete a sidecar to force admission. Keep outstanding charge through rollback, close, actual child exit and separately admitted recovery. Filesystem/lock metadata still needs its own reservation. Full apply/native consent/UI acceptance remain with Easy Setup topic143810 and unavailable. <!-- tracked: topic-143810 -->
