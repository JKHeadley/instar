# Local History Private Exchange Admission

Tier 2 supporting component under docs/specs/local-history-native-contract.md. Reuses an existing clean worktree at base5da82d941 on branch echo/local-history-service-143810, remote JKHeadley/instar, version1.3.1984. One independent review, one concrete fixed-path protection finding, and one targeted re-review. No native upload route or app action is enabled.

## Problem and implementation

The approved contract requires one state-directory-shared private exchange slot before private body allocation or response dispatch. withLocalHistoryExchange uses a process-held SQLite write lock named exchange-lock.sqlite in the private local-history-upload namespace, separate from any future combined child lock. A competing call returns accepted:false before its callback runs. The admitted callback must await transport abort, buffer clearing and response disposal; the lock remains held until that callback completes. Callback failures propagate, including SQLITE_BUSY errors originating inside the callback. The narrow busy conversion covers lock acquisition only. Registration occurs after successful admission and unregister/close runs on every exit.

This is exchange admission only. It grants no owner, source, upload, copy, child or disk authority. A parent process that exits can no longer own request/response buffers, so the OS can release this exchange lock. Separate combined-worker and durable child/disk accounting remain tracked in topic143810 and the approved spec; this helper does not substitute for them or reclaim them based on parent death.

## Side-effects review

Over-block: concurrent private exchanges in one state directory are refused under the initial serial policy; different state directories remain independent. No unrelated HTTP request uses this component. Under-block: until a real route waits for actual disposal, this helper cannot prove HTTP buffer custody; no endpoint is advertised. Layer fit: the resource helper owns only the process-held exchange slot, while native admission, body parsing, encryption and operation custody retain their separate responsibilities. Signal versus authority: reference docs/signal-vs-authority.md; OS lock ownership is a resource fact, not a text classifier or permission heuristic. No timeout or stale-PID detector can release a live lock.

Interactions: the namespace is included in the single private-import exclusion list, so file routes, backups and sync reject it. Fixed DB and WAL/SHM/journal paths also join the inode deny list to protect hard-link aliases. Existing PostUpdateMigrator loops over KEY_MATERIAL_GITIGNORE_STATE and PROJECT propagate the exclusion to existing agents idempotently. SQLite registry accounting covers admitted handles and closes them at teardown. No global transaction is held in an unrelated importer database.

External surfaces: no endpoint, UI, capability or raw transcript copy. The lock database carries no content or approval authority. Team posture: the helper cannot admit a role or select an owner; future callers still need the existing owner checks. Multi-machine posture: selected-machine-only exchange coordination by design; no replication, generated URL or cross-machine ownership claim. Other machines cannot own this process's buffers. Rollback: source revert before any caller is enabled; preserve private namespace exclusions if later intake code has placed user bytes there.

## Verification and review

Four initial semantic tests covered competing allocations, awaited disposal, separate state directories, callback error propagation, redirected namespace and real process death. Review caught missing fixed-path inode protection, now corrected. Added six negative cases for unsafe permissions, redirected DB/sidecars and a hard-link alias; all refuse before allocation and preserve the unrelated target. All10 helper cases and21 existing key-material route checks passed. The SQLite wiring suite separately passed10 cases. Official no-emit typecheck passed. The independent reader confirmed its finding closed and found no further issue. These are supporting-module checks, not a full-suite or installed native feature claim.

## Class-Closure Declaration

- defectClass: unbounded-self-action
- closure: n/a
- reason: One callback-scoped resource lease adds no autonomous controller, retry, timer, deadline extension or source discovery. Disposal and transport deadlines belong to the future wired exchange under the same approved contract.
