---
title: "Subscription Pool Authority Foundation"
slug: "subscription-pool-authority-foundation"
author: "Echo"
eli16-overview: "docs/specs/subscription-pool-authority-foundation.eli16.md"
lessons-engaged:
  - "P20 Verify the State, Not Its Symbol — an unreadable or invalid durable pool never becomes an authoritative empty pool."
  - "Expected Capacity Enforcement — load, scan, index, and serialized responses have explicit hard bounds."
  - "Migration Parity — existing single-file pools move through a restart-safe staged directory protocol."
review-convergence: "2026-08-27T02:45:21.028Z"
review-iterations: 2
review-completed-at: "2026-08-27T02:45:21.028Z"
review-report: "docs/specs/reports/subscription-signin-ledger-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Justin (topic 33890)"
approved-date: "2026-08-26"
---

# Subscription Pool Authority Foundation

Status: CONVERGED AND OPERATOR-APPROVED (80/20 v1 boundary; implementation authorized)
Author: Echo
Date: 2026-08-26
Origin: extracted prerequisite of `subscription-signin-ledger` after external scope review

## Problem

`SubscriptionPool.list()` currently clones/scans the entire backing array and `get()` performs an
array search. More importantly, durable-load failures can collapse through a catch into an empty
pool. A bounded observer cannot safely consume that surface: a corrupt giant pool defeats its work
bound, while malformed authority can be reported as “0 accounts.”

This spec changes only the pool authority foundation. It does not record login history, change
selection policy, execute sign-in, or add proactive notices. It publishes
the static implementation capability `{version:1}` whenever the v1 code and wiring are installed,
independent of live pool health. `getAvailability()` separately reports dynamic authority state.
The sign-in ledger requires implementation version 1; missing/lower/higher/partial code disables
its observer and writes, while an installed v1 foundation with `invalid|unavailable` authority keeps
the history route active and passes that degradation through as data.

## Contract

Local terms: a **bounded observer** is any caller that must inspect a fixed maximum number of pool
rows; the **history route** is the ledger's read-only login-history API; **unified peer reads** query
the same bounded API across registered machines without copying authority; **follow-me** is the
existing workflow that makes a selected subscription credential available on a target machine;
**Threadline identity** is the agent-network identity and is explicitly not the machine identity
that binds this store.

### Canonical visibility and eligibility

One exported `isQuotaPollSupportedAccount(account)` predicate is shared by QuotaPoller and bounded
consumers. Observable eligibility is that predicate plus `account.status !== 'disabled'`;
`active`, `warming`, `rate-limited`, and `needs-reauth` remain visible. Temporarily unresolved
identity remains visible. Public `get()` and bounded scan preserve today's `list()` rule that rows
need a nonblank trimmed email. Missing/blank/whitespace-email legacy rows remain available only via
`listEmailGaps()`.

### Index and bounded scan

`SubscriptionPool` maintains `Map<accountId,account>` beside its array. Load and every
add/update/remove publish array+index atomically only after validation and durable persistence.
`get()` delegates to the index, then applies public visibility. `scanAccountsBounded(limit)` visits
and clones at most `limit` BACKING rows before filtering and returns `{accounts,truncated,
examined}`. The initial supported ceiling is 4,096; consumers may choose a lower limit. No bounded
consumer may call materializing `list()` later in the same pass. This is deliberately a backing-row
prefix API, NOT “return N eligible accounts” and not a cursor: callers accept fewer visible rows,
publish `truncated:true`, and never continue scanning in the same pass. The ledger preserves
incumbents through indexed lookup before using the prefix for vacancies, so repair-only rows can
reduce refill completeness but cannot evict an existing observed cell.

Duplicate ids reject before either representation publishes. Unit instrumentation—not wall clock—
proves index delegation and examined-row bounds.

### V1 threat model and 80/20 boundary

V1 assumes a trusted operating system, trusted operator and same-UID processes, and the existing
`SingleInstanceLock` as the sole application-writer boundary. In scope: crashes at every declared
durability boundary, torn/incomplete writes, static malformed or oversized files, accidental I/O
failure, static symlink substitution, foreign-machine restore/copy, and stale recognized recovery
artifacts. Every expected pool directory and authority artifact is type-checked without following a
symlink before use; a symlink maps to closed `recovery-conflict` with no publication or mutation.
Concurrent replacement after validation belongs to the same-UID mutation exclusion below. Out of
scope: an actively malicious or concurrently mutating same-UID process replacing or rewriting pool
files, their parent witness, or generation metadata between syscalls. That principal could rewrite
the entire authority set and requires a different architecture/security boundary, not more
filesystem choreography in this v1.

No-follow opens, descriptor-bound reads, byte caps, digest checks, and typed conflicts remain useful
defense in depth, but the spec does not claim coherent publication under an active same-UID file
replacement attack. If that threat is later admitted, the design must reopen around a kernel-backed
transactional primitive rather than extending this protocol incrementally.

### Bounded durable load

Every normal, legacy, candidate, rollback, and active `accounts.json` validation opens the file
with no-follow semantics, `fstat`s that same descriptor, rejects a reported size over 8 MiB, and
reads from that descriptor through an 8 MiB+1 capped reader. Observing byte 8 MiB+1 refuses before
parsing or publication, so static oversize and accidental growth cannot materialize an unbounded
string. Digest and size bind exactly the captured capped bytes. The
bounded parser then refuses row 8,193 without constructing/publishing array or index. Closed load
states:

| Input | State | Authority behavior |
|---|---|---|
| authority absent and never initialized | `unconfigured` | legitimate empty; safe reads and first-create only |
| valid v1 store | `ready` | normal APIs |
| read/I/O failure | `unavailable` | no data/mutation value; typed failure |
| parse, missing/wrong root version, non-array, invalid row, duplicate id, size/row excess | `invalid` | no data/mutation value; typed failure |

Existing per-row migrations run before validation (including pre-CAS optional version defaults).
There is NO missing-root-version migration. Email remains optional/blank for repair-only rows.

`getAvailability()` is the sole non-throwing diagnostic and returns the closed shape
`{state:'unconfigured'|'ready'|'invalid'|'unavailable',reason:AvailabilityReason|null,
maintenance:'rollback-cleanup-pending'|null}`. Maintenance is orthogonal to authority state: it is
non-null only while committed NEW is `ready` and removal of its exact recognized OLD rollback, or
the parent-directory durability of that removal, remains pending. `AvailabilityReason` is the
scrubbed enum `not-initialized` · `io-read` · `io-stat` ·
`size-limit` · `row-limit` · `parse` ·
`root-version` · `root-shape` · `invalid-row` · `duplicate-id` ·
`machine-identity-unavailable` · `foreign-authority` · `initialization-incomplete` ·
`missing-after-initialization` · `recovery-conflict`. Mapping is closed:
`not-initialized → unconfigured`; `io-read|io-stat|machine-identity-unavailable → unavailable`;
every limit, parse/shape, duplicate, foreign-identity, initialization, missing-after-init, or
recovery-conflict reason → `invalid`. In `invalid|unavailable`, `list`, `get`, `size`, `listEmailGaps`, bounded scan,
selection, and all mutations throw `SubscriptionPoolUnavailableError` before returning a value or
side effect—never `[]`, `null`, or zero. Central route middleware maps authority-sensitive APIs to
typed 503. Scheduler/swap/follow-me/enrollment boundaries skip action. Static callsite audit forbids
catch-to-empty/default for this error.

### Authority publication and loss witness

The machine-local authority directory is `state/subscription-pool/` (0700), containing 0600
`accounts.json` plus `generation.json` with closed schema
`{schemaVersion:1,generation:string,baseGeneration:string|null,machineId:string,
accountsSha256:string,accountsSize:number}`.
Generation is a random 128-bit lowercase hex id; digest and size bind the exact validated account
bytes. A separate parent 0600 witness
`state/subscription-pool.initialized.json` survives whole-directory loss:

```
{ generation, nextGeneration: string | null, machineId,
  operation: 'first-create' | 'legacy-migrate' | 'update',
  legacyDigest: string | null, legacySize: number | null,
  state: 'initializing' | 'updating' | 'initialized', cleanupPending: boolean }
```

Witness cross-field validity is closed:

| operation | state | generation means | nextGeneration | legacyDigest / legacySize | cleanupPending |
|---|---|---|---|---|---|
| first-create | initializing | candidate generation | null | both null | false |
| first-create | initialized | committed generation | null | both null | false |
| legacy-migrate | initializing | candidate generation | null | both required and source-bound | false |
| legacy-migrate | initialized | committed generation | null | both retained and source-bound | false |
| update | updating | committed OLD | required distinct NEW | both null | false |
| update | initialized | committed current generation | null | both null | true while rollback deletion/durability is pending; false after cleanup completion |

Every other operation/state/nullability combination is invalid. A committed generation file has
`baseGeneration:null`; an update candidate has `baseGeneration:OLD` until publication, when its
otherwise identical validated record is rewritten/fsynced with null before the directory swap.

`machineId` is always the existing persisted
`MachineIdentityManager.loadIdentity().machineId`; hostname and Threadline identity are forbidden.
Missing identity is typed unavailable. Mismatch is `invalid:foreign-authority`, with no automatic
adoption, rebind, or teardown surface. Identity recovery uses the existing foundational identity
workflow; a replacement machine uses ordinary subscription enrollment.

First creation:

1. Atomically write+fsync `initializing` witness.
2. Build store+generation in a 0700 sibling staging directory; fsync files and directory.
3. Atomic directory rename; fsync parent.
4. Atomically advance witness to `initialized`; fsync parent; only then return success.

Handled pre-publication failure removes staging+witness and fsyncs parent before returning
unconfigured. Cleanup failure is typed `invalid:initialization-incomplete`. Crash recovery finalizes
a matching complete directory. `first-create` with initializing witness but no matching directory
never auto-clears/resumes.

Legacy migration binds SHA-256+size of the validated untouched source. Recovery precedence:

| State | Result |
|---|---|
| matching valid directory | finalize witness, then remove matching legacy |
| no directory + matching valid staging/source | resume rename |
| no directory/staging + matching legacy | rebuild staging and resume |
| source missing/mutated, staging invalid, generation/identity mismatch, conflicting directory | fail closed; delete no authority |

Subsequent saves never replace `accounts.json` alone. Exact protocol, with OLD and NEW generations:

1. Refuse if any candidate/rollback sibling exists; choose NEW.
2. BEFORE creating a directory, atomically write+fsync witness
   `{operation:'update',state:'updating',generation:OLD,nextGeneration:NEW,...}`. The exact owned
   candidate name is now derivable from durable intent: `subscription-pool.candidate-<OLD>-<NEW>/`.
3. Create that one candidate directory and build/fsync `accounts.json` plus `generation.json`
   with `baseGeneration:OLD`; fsync candidate and parent. Validate the complete candidate, then
   atomically rewrite/fsync its generation record with `baseGeneration:null` and fsync candidate.
   That rewrite is the publication-ready boundary; no staging-only file is carried into active.
4. Rename active OLD → rollback and fsync parent; rename publication-ready candidate NEW → active
   and fsync parent. Each rename is a separate durable boundary.
5. Validate active NEW completely, atomically advance witness to
   `{operation:'update',state:'initialized',generation:NEW,nextGeneration:null,
   cleanupPending:true,...}`, and fsync
   parent. This witness write is the COMMIT POINT; no rollback deletion is permitted before it.
6. Remove OLD rollback through SafeFsExecutor, fsync parent, then atomically rewrite the witness
   with `cleanupPending:false` and fsync parent. Cleanup failure at deletion, either parent fsync,
   or witness rewrite leaves committed NEW
   ready but refuses the next save until cleanup succeeds. Mutation methods return the discriminated
   `SubscriptionPoolMutationResult = {committed:true,cleanupPending:boolean}`. Memory array/index
   publish immediately after step-5 validation+commit, before cleanup. Therefore step-6 failure
   returns `{committed:true,cleanupPending:true}`—never throws an ambiguous failure and never invites
   retry of an already-committed mutation. Reads remain ready; `getAvailability()` includes
   `maintenance:'rollback-cleanup-pending'`; health and the mutation route response expose the same
   typed maintenance field; one structured warning is emitted. Any later mutation—including a
   transport retry of the original request—throws
   `SubscriptionPoolCleanupPendingError = {code:'subscription-pool-cleanup-pending',
   priorCommitMayHaveSucceeded:true}` before side effects; the caller must re-read rather than
   reapply. Restart is the sole cleanup-retry path: startup validates the initialized witness,
   active NEW, and witness `cleanupPending:true`. If the exact recognized OLD rollback exists it
   removes only that rollback; if absent it treats deletion as persisted. It then fsyncs the parent,
   rewrites the witness to `cleanupPending:false`, fsyncs parent again, and clears maintenance.
   Repeated restart after successful cleanup is idempotent. There is no
   live cleanup method or route. If rollback deletion or parent fsync fails again during startup,
   startup still publishes validated NEW as `ready`, retains
   `maintenance:'rollback-cleanup-pending'`, emits one bounded warning for that boot, and keeps all
   mutations closed. Every later restart retries only that exact recognized cleanup until deletion
   plus parent fsync and the witness-clear fsync succeed. Failure before the false-witness rename
   leaves `cleanupPending:true` durable. If that rename succeeds but its parent fsync reports
   failure, the running process conservatively retains maintenance and closed mutations, while a
   later restart may observe either true (pending/no-sibling recovery) or false (clean CURRENT
   steady state). NEW bytes, memory, and generation remain unchanged in either outcome.

Startup validates digest/size/generation before publishing array/index. Closed update recovery:

| Witness / artifacts | Recovery |
|---|---|
| updating OLD→NEW; active OLD; candidate absent/incomplete under exact derived name; no rollback | delete exact candidate if present, fsync parent, validate OLD, abort witness to initialized OLD |
| updating OLD→NEW; active OLD; complete candidate with base OLD | validate, normalize base to null durably, resume step 4 |
| updating OLD→NEW; active OLD; publication-ready candidate NEW | resume step 4 |
| updating OLD→NEW; no active; rollback OLD; publication-ready candidate NEW | validate both; rename NEW→active, fsync, then commit NEW and cleanup OLD |
| updating OLD→NEW; active NEW publication-ready; rollback OLD | validate both, commit witness NEW, then cleanup OLD |
| initialized NEW, cleanupPending true; active NEW; rollback OLD | publish NEW ready+maintenance, cleanup OLD, fsync parent, clear witness flag+fsync |
| initialized NEW, cleanupPending true; active NEW; no siblings | publish NEW ready+maintenance, fsync parent to confirm absent rollback, clear witness flag+fsync |
| initialized CURRENT, cleanupPending false; active matching CURRENT; no siblings | validate and publish CURRENT ready with maintenance null; no cleanup fsync |
| any sibling not exactly derived from updating witness, foreign machine id, extra sibling, digest mismatch in a claimed complete directory, or missing committed OLD with no valid recovery pair | fail closed; delete no authority |

A crash after intent but before/during mkdir or any candidate write is therefore recognizable without
trusting candidate contents: the durable witness names the sole directory the recovery code may
delete. With no update intent, every candidate sibling is unrecognized and fails closed.
The witness is a transaction journal and loss witness, never an arbitrary current-generation
selector. A later save cannot start while the bounded sibling remains
undeletable.
Directory/witness present but store missing is invalid, never fresh bootstrap.

Repair-only email-gap rows count against both the 8,192-row and 8 MiB authority limits and against
bounded-scan examined rows. `listEmailGaps()` is the explicit operator repair surface; existing
update/remove operations can repair or delete those ids. Enrollment refuses with a typed capacity
diagnostic while the hard limit is occupied—there is no automatic compaction or silent eviction.

### Artifact lifecycle

Pool directory, parent witness, and all staging/temp siblings are machine-local under
`machine-local-justification: physical-credential-locality`. Both root forms are denied by file
routes and unconditionally excluded from BackupManager capture/restore. Ledger rollback never
removes them. Only SubscriptionPool's recognized recovery state machine may clean staging.

### Public status mapping

Pool authority consumers distinguish `unconfigured`, `invalid`, and `unavailable`. Unified peer
reads map them to named `peer-pool-unconfigured`, `peer-pool-invalid`, and
`peer-pool-unavailable`, with no path, raw error, account id, or source bytes. They never collapse
to a zero-account peer. A ready peer with cleanup pending remains `ready` and carries the closed
scrubbed field `maintenance:'rollback-cleanup-pending'`; otherwise `maintenance:null`.
Central middleware maps `SubscriptionPoolCleanupPendingError` on mutation routes to HTTP 409 with
`{error:'subscription-pool-cleanup-pending',priorCommitMayHaveSucceeded:true,
recovery:'re-read-and-restart'}` and no path, generation, account id, or raw error.

## Frontloaded Decisions

1. **A load error never means empty.** Invalid/unavailable is typed and fail-closed. *(NOT reversible
   as a public authority semantic.)*
2. **Canonical public visibility remains email-present; repair-only email gaps stay separate.**
   *(NOT reversible for consumers without a versioned API.)*
3. **8 MiB / 8,192 stored rows / 4,096 scanned rows are hard initial bounds.** Loosening is safe;
   tightening requires migration analysis. *(reversible-forward-only.)*
4. **Authority is machine-bound to persisted MachineIdentityManager identity.** No hostname,
   adoption, rebind, or backup transplant. *(NOT reversible.)*
5. **First-create and legacy migration use operation/source/generation-bound staged publication.**
   *(NOT reversible after deployed stores migrate.)*
6. **Recovery after repair requires restart.** No watcher/reloader is added. *(reversible later.)*
7. **Implementation compatibility and live authority are independent axes.** Static
   `getContractCapability(): {version:1}` gates downstream wiring; dynamic `getAvailability()`
   carries `unconfigured|ready|invalid|unavailable`. Missing/incompatible code disables writes,
   while live authority degradation remains readable. *(NOT reversible as an activation safety
   boundary.)*
8. **Migration uses a two-release rollback protocol.** Release A adds the directory-aware reader
   but never migrates; release B may migrate only after its fleet/version gate proves every
   supported rollback target includes A. Compatibility remains for two further minor releases and
   removal requires fleet evidence. *(NOT reversible once B migrates authority.)*

## Alternatives considered

SQLite would simplify paired writes but would make the live subscription authority depend on the
native-module healer and a new transactional store migration for a small configuration set. An
append-only log still needs compaction, projection, and a crash-safe pointer. A content-addressed
generation directory plus freely selectable pointer swap was closest, but that pointer becomes an
independent current-generation authority. The chosen external witness is instead a closed
transaction journal and whole-directory-loss witness: it can advance only through the exhaustive
artifact state table and never selects an arbitrary generation. The whole-directory swap keeps each candidate self-validating,
uses filesystem primitives already required for legacy migration, bounds rollback to one sibling,
and never publishes a half pair.

## Decision points touched

| Point | Class (`invariant` or `judgment-candidate`) | Floor / justification |
|---|---|---|
| load classification | `invariant` | closed parse/I/O/absence taxonomy; no competing signals |
| public visibility | `invariant` | exact parity with existing list/get email gate |
| identity mismatch | `invariant` | persisted machine identity equality; mismatch always fails closed |
| recovery precedence | `invariant` | operation/generation/digest/identity table is exhaustive |

## Multi-machine posture

| Surface | Posture | Notes |
|---|---|---|
| pool authority directory/witness | `machine-local` | `machine-local-justification: physical-credential-locality` |
| typed peer status | `unified` | proxied read maps local state to named failure; authority bytes never replicate |

## Self-heal posture

No watcher, timer, or notification. Repair is operator action plus restart; startup recovery only
finishes an already-recognized staged transaction.

## Changed files

`src/core/SubscriptionPool.ts` · `src/core/QuotaPoller.ts` (owns the shared exported support
predicate; no ledger behavior) · `src/core/MachineIdentity.ts` (dependency only; no identity
semantic change) · `src/commands/server.ts` (real identity injection and job boundaries) ·
`src/server/routes.ts` (typed route mapping) · `src/server/fileRoutes.ts` (dual-root denies) ·
`src/core/BackupManager.ts` (dual-root exclusions) · `src/core/PostUpdateMigrator.ts` (legacy
single-file staged migration) · corresponding unit/integration/e2e tests and agent-awareness
template update for typed pool health.

## Testing

The three tiers prove the capability at increasing realism; they do not duplicate every syscall
fault at every tier. Unit owns the exhaustive state/fault matrix, integration owns representative
public-boundary behavior and real dependency composition, and production E2E owns a small set of
load/save/restart lifecycles that prove the feature is alive.

- **Unit:** root/row migration+validation matrix; same-descriptor no-follow/fstat/capped-read
  enforcement across normal, legacy, candidate, rollback, and active validation; static oversize
  and controlled same-process growth past the cap prove `size-limit` refusal and no partial
  publication; static symlink substitution for every directory/artifact class maps to
  `recovery-conflict`. Size/row refusal before publication; index
  coherence across load/add/update/remove; duplicate rejection; email-gap parity; bounded-scan
  instrumentation; every first-create/legacy recovery state; fsync/rename/cleanup faults; identity
  unavailable/mismatch/copy/remint/restore; no hostname dependency. Closed witness-schema tests
  enumerate every operation/state/nextGeneration/cleanupPending combination and reject all invalid
  tuples.
  Table-driven subsequent-update
  recovery covers every witness/artifact row above, recognizes/deletes only the exact candidate
  name derived from the durable updating witness, refuses foreign/multiple/unrecognized siblings,
  and faults after witness intent fsync, candidate mkdir, partial file write, candidate file fsync,
  candidate dir fsync, generation normalization rewrite/fsync, OLD→rollback rename, the
  between-renames state, NEW→active rename,
  parent fsync, commit witness, rollback deletion, and final
  fsync, including cleanup refusal and repeated restart.
- **Integration:** every public pool read/mutation and scheduler/swap/follow-me/enrollment boundary
  under ready/unconfigured/invalid/unavailable; no selection, mutation, overwrite, or “0 accounts”;
  route diagnostics scrubbed; representative static file/directory symlink refusal; file/backup
  denial; real status/support mutations; repair+restart.
  Through the real public pool/load boundary, a representative oversized normal store proves the
  capped reader consumes at most 8 MiB+1, returns the closed typed `size-limit` refusal, and
  publishes neither a partial array nor index. Representative recovery validation proves the same
  closed refusal without repeating the unit fault matrix.
  Real update/remove/add operations cross the subsequent-save protocol and assert memory array,
  index, active files, generation, and witness agree. Post-commit cleanup failure asserts the
  original caller receives committed+pending (not throw), memory/readback show NEW, health and
  availability expose pending, a transport retry of the original mutation receives the typed 409
  before side effects, readback confirms committed NEW, the next distinct mutation is likewise
  refused, restart cleanup clears maintenance without changing NEW, and another restart is
  idempotent. Two consecutive restart cleanup failures keep validated NEW ready/readable and every
  mutation boundary inert; a later successful restart clears maintenance. Delete-success plus
  rollback-deletion parent-fsync failure covers both permitted restart observations while the
  witness flag stays true: rollback reappears and follows recognized cleanup, or remains absent and the
  cleanup-pending/no-sibling row clears maintenance only after parent fsync plus witness-clear
  fsync. Failure of the parent fsync after the false-witness rename keeps runtime maintenance and
  closed mutations but admits both restart observations: true follows pending/no-sibling recovery;
  false follows clean CURRENT/no-sibling. A clean witness never performs a cleanup fsync on ordinary boot. Local and unified-peer
  serialization preserve ready+maintenance without converting it to empty/unavailable, and every
  scheduler/swap/follow-me/enrollment caller propagates the typed refusal without account action. A
  prefix filled with repair-only rows proves
  `examined<=4096`, incumbent preservation, visible vacancy incompleteness, and no fallback `list()`.
  Exact row/byte capacity refusal preserves source bytes; `listEmailGaps` plus update/remove frees
  capacity and the next enrollment succeeds without silent eviction.
- **E2E:** production initialization with fresh first enrollment, valid legacy migration, one
  pre-commit crash that recovers complete OLD, one post-commit cleanup failure that returns pending
  and clears on restart, >8 MiB and >8,192 inputs, >4,096 bounded scan, hand-authored
  malformed/duplicate stores and capped static-oversize refusal/no partial publication,
  whole-directory loss, real MachineIdentityManager wiring, healthy+
  invalid/unavailable peer mapping, and unchanged healthy-peer data. These representative production
  lifecycles prove restart exposes exactly complete OLD or complete NEW authority, never a mixed
  pair; the exhaustive crash-boundary matrix remains unit-owned. The production route returns
  `{committed:true,cleanupPending:true}` at the post-commit cleanup fault; transport retry is
  refused with `priorCommitMayHaveSucceeded:true`, readback shows NEW, and restart-only cleanup is
  idempotent. Production fixtures also cover the scrubbed local 409, ready+maintenance peer output,
  representative scheduler and enrollment consumers, and one failed restart followed by successful
  cleanup while NEW authority remains unchanged. The same fixture covers repair-only prefix saturation
  and capacity-refuse→operator-repair→successful-enrollment lifecycle.
- **Wiring integrity:** production SubscriptionPool receives the already-loaded real machine id;
  no Threadline/hostname/no-op substitute. Entire production poll pass proves no later `list()`.
  Unit/schema tests enumerate the generation record and every scrubbed reason. Production update
  E2E proves missing/version-mismatch code cannot write; v1 code with each dynamic authority state
  keeps typed history diagnostics reachable; only ready authority admits observation work.

## Rollback

Disable downstream observation first. Code rollback MUST retain the migrated authority directory
and parent witness; deleting them can turn lost authority into fresh bootstrap. Release A ships a
directory-aware compatibility reader but leaves the single-file authority untouched. Release B's
migrator is programmatically gated on fleet evidence that every supported rollback target is A or
newer; absent evidence means no migration. The reader remains for at least two subsequent minor
releases. A production lifecycle E2E uses the real A and B artifacts: legacy → A/no migration →
B/migrate → rollback to A → B again, asserting identical account ids/content and no authority
rewrite/loss. Removing compatibility requires fleet-version evidence. Backup/file-route denials remain.

## Maturation plan

- **test-agent-live:** run the exhaustive unit recovery matrix, representative public integration,
  and production-init first-create/migration/update/restart fixtures against isolated state roots.
- **dev-agent-live:** ship release A's compatibility reader without migration, then enable release B
  migration first on Echo after the version gate proves A-or-newer rollback support; exercise one
  real add/update/remove and restart with identical authority readback.
- **fleet:** release A must reach every supported rollback target before release B's migration gate
  can admit any machine; B then follows the normal staged rollout with typed availability visible.
- **graduation criterion:** the complete test matrix is green and Echo completes 48 consecutive
  hours plus one restart with zero authority loss, mixed-generation publication, false empty pool,
  or unexpected `invalid|unavailable` state.
- **dark-window:** migration remains dark until fleet version evidence admits B; after first dev
  migration, fleet activation waits at least 48 hours and the graduation criterion.

## Open questions

*(none)*
