# Side-Effects Review — Budgeted Local Source Records

**Slug:** local-history-claim-write-budget
**Date:** 2026-11-23
**Author:** echo
**Risk:** Tier2, durable private SQLite provenance and disk accounting.
**Second-pass reviewer:** channel_side_effects, independent source/artifact review; concur.

## Summary and build location

Implements the approved native contract's prewrite source-claim content accounting in the actual store writer. New opaque source-claim plans enforce a verified native page ceiling before schema/INSERT. Existing identical durable claims activate at zero content cost. The fixed apply worker, parent disk ledger, physical allocation/metadata accounting and preview-specific user confirmation remain unconnected and unavailable. No apply endpoint, app action or UI flag is enabled. <!-- tracked: topic-143810 -->

Owned isolated worktree local-history-claim-budget-143810, verified branch echo/local-history-claim-budget-verified-143810, parent569cc2a5c4b9b2bfad19f889337f7438a6dcc161, package1.3.1984. Approved driving spec/ELI16: local-history-native-contract in this committed parent. Original report's same-family external and unavailable live-conformance limitations remain unchanged. This implements accounting without a new publication/reader model; architecture independently classified it as an implementation detail. The separately unapproved routing amendment and denied source-row retirement are untouched.

Size: two production modules, focused unit and actual child-crash regressions, component/evidence/awareness/upgrade/review documents. Three independent source reviewers concurred; none ran checks. A proposed copy-on-write database replacement was rejected before coding because existing SQLite readers do not hold a publication barrier. The implemented in-place design retains their existing SQLite synchronization. No new spec-convergence run is claimed. The initial trace refused because local Husky hooks were absent. Root then mistakenly ran git commit, producing unchecked633ea796d28c7f2d371e211c46f5b50102ca22ad; it was not published or submitted as verified. Hooks were installed using the existing local Husky CLI. Exact source changes were restaged on clean parent569cc2a5c in a new verified branch, so the real pre-commit checks inspect the entire source change rather than a documentation-only amend. The unchecked branch remains only as audit evidence. No gate override was used.

## Decision points and must-haves

Actual writer lease, immutable source identity, opaque one-use token/revision/file snapshot, safe-integer content ceiling, audited pager version/settings/native limit, pre-open recovery refusal, immediate transaction and first-error termination. These are provenance, protocol and resource constraints; none interprets user meaning or supplies consent. A new schema/INSERT cannot run before the numeric ceiling is checked. No role, owner or pathname is accepted from an HTTP body by this component.

## 1. Over-block

Unsupported SQLite versions, journal modes, auto-vacuum settings, headers or unresolved sidecars refuse the new budgeted path. They are not automatically migrated or deleted. Existing legacy reads/recovery remain available through their prior path. A too-small page allowance safely returns capacity instead of exceeding the plan. The initial row-plus-eight-pages estimate is adjustable resource policy, not a universal minimum. Exact audited-version refusal must be revisited deliberately with a dependency upgrade. Any stale/failed attempt requires a fresh plan; no previous transaction is continued.

## 2. Under-block

contentBytes bounds logical database/journal content, not physical allocation, owner admission, actual reservation or copy consent. Main-file growth subtracts existing logical length, not allocated extents. Sparse/COW filesystems and rollback can allocate new blocks while rewriting existing pages; real parent accounting must reserve forward/rollback extents, block rounding, locks and metadata separately. Other writers can change free space. This API must not be treated as a complete disk guarantee. Native journal recovery is separately admitted; the new path preserves sidecars and refuses before SQLite opens. Outstanding charge must survive rollback, SQLite close, actual child exit and unresolved recovery. <!-- tracked: topic-143810 -->

## 3. Abstraction fit

LocalHistoryClaimBudget owns the audited fixed-pager arithmetic and pre-open checks. ImportedHistoryStore owns the actual source namespace, writer lease, token/revision/snapshot and active durable claim. The same withLocalClaims helper performs one immediate schema-plus-INSERT transaction only when a budget is supplied; existing callers retain their old path. The fixed SQL/schema has no arbitrary statements, ATTACH, triggers, REPLACE, extensions, custom VFS, file-control changes or savepoints. The real parent must bind its permit to this exact plan; the numeric argument alone is not that permit.

## 4. Signal vs authority and fixed-limit contest

Reviewed against docs/signal-vs-authority.md. Exact identities and source provenance are hard invariants. Version3.51.3, page framing and sector-clamp65536 are external constraints of the inspected implementation, not general claims about later libraries. The native page allowance is an enforced resource ceiling. The default eight headroom pages is a judgment policy: legitimate larger/fragmented states may require a different allowance; a trusted caller can supply it, and the native engine still enforces the chosen cap. No semantic heuristic gains blocking authority. No new user decision or escalation watcher is added.

## 5. Native pager evidence and interactions

Primary evidence is installed better-sqlite3 12.8.0's SQLite3.51.3 amalgamation, independently inspected by architecture. The committed evidence file records its hash and source locations: records cost P+8, original pages journal once under pInJournal, OFF spilling prevents additional spill headers, MEMORY temp store keeps statement subjournals in memory, sectors clamp to65536, and commit uses the non-spill synchronization path. Page-move errors can reset journal membership; aborting on the first error is essential. Code verifies the exact native version and default rollback mode, auto_vacuum0, page size, spill/temp/sync settings and effective max_page_count before schema/INSERT.

Before ANY SQLite open the path rejects sidecars and WAL header versions. This matters even with no -wal/-shm files because opening a WAL database can create them. Existing logical file size and page count must agree and fit the allowance. Arithmetic is checked. Main growth is max(0,N*P-existingLogicalBytes); conservative journal content is N*(P+8)+2*65536. No database rename, pointer migration or new persistent filename is introduced.

## 6. External surfaces and awareness

Only internal store/helper APIs are added. No HTTP/config/installed hook/migration/new model call or app flow. New awareness follows the existing data/awareness mechanism for both new and updated agents, explaining limitations and recovery preservation. Finite errors contain no selected source text or path. No SQL or raw error output is newly logged. Existing SQLite and SafeFs metadata auditing remains unchanged. The user-facing release fragment explicitly says the app import is unfinished; it is not marked internal-only despite the dark runtime code.

## 7. Multi-machine posture

No new state locality or replication policy. Existing durable claims belong to the explicitly selected target and stable owner under the parent contract. An ephemeral write plan cannot move that authority to another issuer, writer or machine. No machine-local knowledge exception, credential replication, public URL or notification source is introduced.

## 8. Rollback cost

Revert the new plan/helper and its tests/awareness/documents together. The existing database schema and reader/recovery behavior are unchanged and need no migration. Preserve any unresolved SQLite sidecar and reservation after a failed write or process death. A claim may already be committed even if no conversation was appended; no rollback can pretend that nothing happened. The zero-content plan deliberately reconciles such an already-durable exact claim. No source retirement or user content deletion occurs.

## Evidence and limits

69 focused real-store tests pass:16 new claim-budget checks,16 content-plan checks and37 existing source-claim checks. Two actual process-death integration checks pass on both sides of claim commit; the first preserves/refuses journal state before any new budgeted open and separately verifies old claims remain readable. The second proves the actual committed claim precedes any conversation append and then reconciles through a fresh writer. Additional46 export/parser/store,11 real history HTTP and1 existing AgentServer-construction export lifecycle checks pass. Total129 focused checks. Real build passes. An actual journal is measured before native commit, while another test forces real SQLITE_FULL and verifies the existing database bytes/claims are unchanged.

The new store APIs remain dormant; the legacy HTTP/E2E checks establish compatibility, not a newly wired signed apply feature. Root's actual Swift-to-TypeScript preparation and unsigned full Mac compile remain separate evidence on their own sources. Full frozen-head suites are requested solely through Chief/throughput after commit. No publication, merge, release, physical allocation guarantee, actual copy consent or full import readiness is claimed.

## Second-pass review

Concur with the review. I independently read the new budget helper, complete store diff, unit and actual process-death regressions, component documentation, awareness, upgrade fragment and committed pager evidence. The installed SQLite amalgamation hash matches the evidence. The artifact accurately describes in-place SQLite synchronization, pre-open sidecar/WAL-header refusal, exact supported pager settings and effective native page cap, one immediate fixed transaction with first-error rollback/close, and zero-content reconciliation of an identical durable claim. These ownership, framing and resource checks fit the hard-invariant exception in `docs/signal-vs-authority.md`; the adjustable headroom is clearly identified as resource policy. Logical content growth is explicitly separated from sparse/COW allocation, rollback extent writes, metadata, real parent reservation and copy consent. The ephemeral plan supplies no portable authority, and rollback preserves unresolved journals and already-durable provenance. No apply, endpoint, native UI or complete physical-capacity guarantee is claimed. No new concrete blocker found. This is source/evidence-only concurrence, not a fresh independent pager proof or attestation of test/build counts; I ran no tests or builds.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This owns store/SQLite mutation resources, not agent spawning or automatic restarts. Neighbor tests cover native page refusal, preserved journal/WAL state, rollback, actual pre/postcommit process death and existing writer/claim isolation. No denied operation is routed through another tool or agent.
