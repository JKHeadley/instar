# Planned restart admission enablement evidence

The watcher and supervisor share an exact-request deadline created only after lease admission first defers. Waiting for verification occurs before this deadline. Same-host publishers and consumers coordinate request changes through a cooperative file lock. A matching terminal request can be retired after reporting, and a self-heal request can replace it without displacing live work.

The topology decision uses the enrollment roster and the dialable-peer view. Missing or inconsistent evidence remains a hold. An enrolled but unreachable peer still counts. The lease window remains bounded by the peer-safe ceiling. If the measured allowance exceeds that ceiling, evidence records the measured requirement and cap. A superseded renewal cannot report failure solely because a newer request or renewal already supplies current authority.

Leave lease admission off until the installed server, supervisor and local writers all use the cooperative protocol. The lock cannot coordinate an older writer or a manually edited request file. A lock failure is a short deferral for a consumer, and async writers retry briefly without blocking the event loop. The implementation gives no new serving authority.

## Class-Closure Declaration

- Restart permission remains bound to the exact active request and current evidence. The request file lock is an ordering mechanism and cannot authorize serving or extend the lease.
- Deferred requests have a bounded lease decision interval. The watcher reports retirement and does not restart the server.

Normal replacement, consumption and retirement remove their markers. A host crash between file operations or artifacts left by an older version can leave orphaned markers. The successor does not scan historical files.

## Second-pass review

**Reviewer:** Independent Codex reviewer restart_review

Concur after re-review. Role publication rechecks whether a restart is still needed inside the lock and writes no stamp when the role has reverted. This completes the earlier review of priority, malformed requests, timeout retirement, and concurrent request replacement. The reviewer checked source and test coverage without running tests.

## Publication timing correction

The updater publishes the request under the same lock before yielding when the lock is free. A competing writer still triggers the existing bounded asynchronous retry. Other publication failures reach the updater's error handler. The request remains an atomic replacement and the correction adds no lease authority. Read and parse errors in pending-update inspection are logged, and the writer still checks the request under the lock. The silent-fallback limit is unchanged.

This is a small, reversible correction to three source files. The five files implicated by the M5 run passed all 87 local tests. The existing focused checks passed 141 unit, 15 integration, and 16 lifecycle tests, and TypeScript passed.

Independent Codex reviewer publication_review concurred. The reviewer confirmed both paths acquire the same lock before rereading and replacing the request, and contention alone takes the retry path. The reviewer checked source and test logs.
