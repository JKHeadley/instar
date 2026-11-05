---
title: "Evolution retention: preserve memory and expose soft targets"
slug: evolution-retention-cap-saturation
author: Echo
tracking: "EVO-022; CMT-1124"
parent-principle: "Archiving May Never Mean Deleting"
parent-principle-fit: "Retention moves full memory to a verified durable archive; operational eviction never erases its content."
lessons-engaged: "Verify the State; Signal vs. Authority; Close the Loop; Cross-Machine Coherence; Archiving May Never Mean Deleting"
eli16-overview: docs/specs/evolution-retention-cap-saturation.eli16.md
approved: true
approved-by: "Evolution proposal EVO-022 carries status approved in the evolution queue. Spec-level approval recorded by Echo under Justin's standing statement of 2026-10-01 17:49 (Telegram topic 102965) that non-critical process approvals are decided at the desk and reported afterwards, following PR #2776. Explicit user instruction authorizes build through main under CMT-1124. The constitution is unchanged. External review degradation is disclosed in the convergence report."
review-convergence: "2026-11-05T09:25:09.228Z"
review-iterations: 5
review-completed-at: "2026-11-05T09:25:09.228Z"
review-report: "docs/specs/reports/evolution-retention-cap-saturation-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "External Codex CLI attempts timed out; no successful external opinion claimed"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Evolution retention: preserve memory and expose soft targets

## Problem statement

The four save funnels in EvolutionManager use slice(-Math.max(0, target-active)),
which keeps every terminal record when the allowance is zero. Active work is exempt:
these settings have always been soft total retention targets, never hard capacity caps.

Source: the corrected preserved spec at preserve/2026-09-unlanded-evolution-memory-metrics,
including its September correction and resolution history, supersedes the original branch.
The 352/300 August premise is historical. November 5 live API inspection found 300 actions:
160 pending, 7 in_progress, 17 completed, 116 cancelled; 36 applied learnings; no gaps.
The local action file is 276966 bytes. The current queue is not saturated with active work.
Base origin/main: 1cb59f787 (1.3.1668). All four slice defects remain.

## Proposed design

1. Keep every active record. Terminal means implemented/rejected proposals, applied learnings,
addressed/wont_fix gaps (every status other than identified, preserving the existing policy),
and completed/cancelled actions. Retain the newest terminal suffix only when allowance > 0.
Every save computes statistics AFTER retention; statistics reads recompute from the actual
records instead of trusting old cached counters. Report total, active, terminalRetained,
target, terminalAllowance, overflow, plus existing fields. New retentionTargets keys are
proposals/learnings/gaps/actions, taking precedence over maxProposals/maxLearnings/maxGaps/
maxActions, then existing defaults. Accept finite nonnegative safe integers, including zero.
An explicitly invalid setting disables removal and reports target unknown; it never falls
through to a lower target. Resolve legacy aliases at read time, so existing installations
need no destructive config rewrite and new values are never overwritten.

2. Reuse #2468's action-archive.json, not another archive. Keep its entries array and existing
auto-expiry action format. Extend the same document with typed retentionEntries for proposals,
learnings and gaps. Retention action entries use class retention and carry full action content.
Preserve unknown document fields on every write, including restore and expiry. Strictly validate
archive entries before writing; unreadable or malformed archives hold all eviction. Archive
before hot-list eviction, fsync the temporary file, atomically rename, fsync its parent directory, then read back and compare full content before
saving the smaller hot list. Deduplicate by content digest; a crash after archive but before
queue save is harmless and retried. Never overwrite an earlier version. The archive is durable
memory, has no TTL, and is included wherever the existing state directory is backed up/restored.
The new archive API returns full records; it does not claim backup redundancy or offline peer
availability. Failure of archive preservation retains the hot records and reports pressure.

3. Operational eviction is NOT memory deletion. Remove the retention delete-tombstone loops
for learnings and actions. Keep real put emission, including evicted records, and expose
archive-inclusive learning/action reads to the existing puts-only ReplicatedStoreReconciler
and action union reader. Include the archive path in reconciler watched inputs. For each actual replication identity (deriveLearningRecordKey / deriveEvolutionActionRecordKey),
use the live record first, otherwise the latest archived version; never replay all historical versions.
Project auto-expired actions to cancelled with the existing auto-expiry resolution, never
re-emit their raw pending snapshot. Retention records keep their original terminal state. Thus failed
puts are retried by the existing bounded reconciler and no peer receives erasure authority.
An offline peer may retain terminal records hot until it applies its own retention target;
that is safe. Full archival content for ALL four kinds replicates separately, as specified below; projected
operational puts alone do not preserve complete memory.

4. GET /evolution/retention defaults to pool reads using the existing
credential-allowlisted, bounded readReaperPoolPeers helper. scope=local is the recursion base.
Return own and per-machine peer observations with failures and complete flag; never sum
possibly duplicated records as a unified unique population. GET /evolution/archive reads the LOCAL durable union of own and received archive memory by default.
Archive records carry origin, kind, content digest and full content; received text is untrusted data. Paginate each machine independently using
offset/nextOffset, a limit <= 50 and a response payload budget below the peer helper's 2 MiB
cap. Accept optional kind/id filters so a specific historic record stays reachable as the
archive grows. An individual oversized record returns explicit unavailable/oversized metadata,
never a truncated record. Responses preserve continuation; pages are
observations, not snapshot-consistent transactions. Missing files are empty new stores, malformed/unreadable files are unknown.
Retention reads are strictly read-only. All four mutation loaders strictly validate the
record array, IDs and status/applied shape and throw on corrupt existing files rather than
fall back to empty. Summary reads catch these errors and return unknown for that store. Extend these endpoints in agent awareness and its
existing migration path so agents inspect archives before claiming memory is gone.

5. Allocate monotonic local IDs using the highest observed suffix across live + archive records,
not first unused. Reserve all archived versions, even restored entries. Fail allocation on
unreadable archives instead of reusing a stale ID. This prevents new reuse after adoption;
previous reuse cannot be undone. PATCH on an archived ID remains 404; it never targets new work.
Action restore preserves status, returns held, and keeps restored terminal actions hot (hold
exempts terminal actions from retention too), so restore cannot succeed into immediate eviction.

6. After retention has attempted the only legitimate automatic heal (archive terminal surplus),
remaining overflow emits a structured warning naming store, target, active, terminal retained
and overflow. This is an agent-owned operational alarm, consumed through existing server logs;
it is not a claim of operator notification. Emit once per changed pressure signature, clear
on recovery; no timer, notification loop, cancellation, or enabling of action auto-expiry.
Archive failures and invalid settings also warn explicitly. No signal can abandon active work.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Active-work exemption | invariant | Size grants no authority to abandon work. |
| Terminal suffix budget | invariant | Enumerated status policy and nonnegative arithmetic. |
| Invalid settings | invariant | Unknown input grants no additional removal. |
| Archive-before-evict | invariant | Full readback failure retains the live record. |
| ID reservation | invariant | Historical identity never authorizes a new referent. |
| Pressure alarm | invariant | Observation after legitimate heal; no behavioral authority. |
| Peer coverage | invariant | Missing peers are explicit unknowns, never healthy zeros. |
| Peer import admission | invariant | Known peers, safe URLs, strict digest/schema; custody grants no action authority. |
| Retry budget | invariant | Finite pages, network deadline, in-flight exclusion, backoff and breaker. |

## Frontloaded Decisions

1. Soft total targets, preserving all open work; no hard capacity claim.
2. Reuse the existing archive and preserve complete records without TTL.
3. Never send tombstones for hot-list eviction; retry archival puts through existing reconciler.
4. New keys override deprecated aliases; invalid explicit input holds eviction.
5. Monotonic IDs reserve history; restore holds actions hot.
6. Pool reads show coverage and per-machine provenance without fake deduplication.
7. Existing auto-expiry remains opt-in/dry-run as configured; its protections are unchanged.
8. Alarm is a structured operational warning, not a new operator-notification watcher.
9. Rollback reverts code and restores hot lists from the preserved archive; do not delete archive.

## Evidence contract

Symbol: retained counts and targets. Claimed state: measured hot-list pressure, never completion
or total unique fleet memory. Independent corroboration: strict reads of actual arrays and
full archive readback compared to candidate content, plus HTTP and restart tests. Unknown
read/target remains unknown and cannot authorize pruning. Archive existence alone proves
nothing. Tests cover at/past/below saturation for all four stores, zero and invalid values,
archive corruption/failure/crash boundaries, post-retention stats, ID reservation, restore,
no delete emissions, reconciler archive visibility and authenticated pool coverage.

## Multi-machine posture

Full memory is REPLICATED, not proxied-on-read. Extend the existing action-archive.json with
replicaEntries holding immutable, full-content origin/kind/record/digest envelopes. Export own
and received records through the paginated archive endpoint so surviving machines can relay
memory even when its original owner is gone. Derive digest from stable JSON of origin, kind
and full record. Existing action entries and typed retentionEntries remain the source; replicas
never allocate local IDs, never restore through local action routes, never gain execution or
instruction authority, and never replace another origin's memory. Preserve unknown fields.

An EvolutionArchiveSync worker runs on the EXISTING PeerPresencePuller.onPeerRecorded cadence,
not a new timer. Launch from the void callback with explicit catch; stop/shutdown suppresses
new passes and aborts in-flight fetches. Never retain an archive document across an await:
import rereads latest disk content, then synchronously merges+writes before yielding. Resolve known non-revoked peers using the existing peer URL resolver and
credential allowlist; refuse redirects. Pull <= 4 pages and <= 5 seconds per peer per tick,
limit 50 records / <= 1 MiB per page, no overlapping pull for a peer. Persist the
append-only export digest order; never derive cursor order by concatenating changing arrays.
The 5s deadline bounds network work, not the synchronous whole-file archive rewrite; this
archive implementation enforces a 64 MiB document ceiling: stat before reading, reject
oversized existing documents without mutation; reject writes/imports that would cross it,
without deleting existing memory. This bounds each archive read/rewrite; saturation holds hot
records, stops import/cursor advance, and signals explicit degraded preservation. No silent
TTL/deletion or claim of complete replication is permitted at this resource ceiling. Persist each validated
page into the same archive with fsync before advancing the durable peer cursor. Retry on a later presence tick with exponential backoff (30s base, 30m ceiling).
After 6 consecutive failures, PARK that peer durably and emit one deduplicated structured
degradation warning: unchanged evidence causes zero further requests, even after restart.
Rearm only on changed peer URL (new transport evidence) or explicit agent reset of that
peer state; successful archive import resets the failure count. Persist failures/cooldown/
parked state with cursors; in-flight state is runtime-only. No notification
or restart action is introduced. Cursor belongs to the peer's append-only export stream incarnation;
reset/rebuilt archive changes incarnation and resets the cursor, including when a short stream
would otherwise make a stale cursor look complete. On end, reset offset to zero on next tick
for anti-entropy; content digests deduplicate replay. Archive remains no-TTL on every machine.

Validate envelope shape, allowed kind, ID/status/applied shape, origin and content digest before
importing; an invalid page imports nothing and advances no cursor. Enforce bounds without
truncation. Records too large for a page are not eligible for hot eviction and report explicit
pressure. Reading complete local archive memory works after every peer is disconnected. New
peers catch up through repeated bounded pages; failures/older peers are explicit degraded
replication, not claims of immediate redundancy. Local archive preservation always precedes
hot eviction; eventual cross-machine replication has the same unavoidable partition window
as existing state replication. No existing replication flag is silently enabled. Archive copy
is integral to retention when multiple registered machines are present, not gated on the
projected learning/action stateSync flags. Operational retention reports alone use pool
fan-out and show honest coverage. Peer archive import is memory custody, never work execution.

## Open questions

*(none)*

## Rollout and verification

Tier 2: durable memory eviction is not undone by a code revert alone. Converge before editing
runtime code; approve at the desk under the non-critical-approvals standing statement used by
PR #2776. No constitution change. Unit boundaries, HTTP integration, restart lifecycle, type
check, Local Verify, safe-merge, verify origin/main and prove against a copy of the real queue
with unchanged active records and full archive preservation. After deployment, perform a harmless
live API save and independently read actual hot/archive files and the live retention surface;
a copied fixture alone cannot prove the live runtime. Only then mark EVO-022 implemented,
prepending evidence to its entire preserved prior resolution. Scope EVO-022 only.

## Maturation plan

- **test-agent-live:** real filesystem boundaries, authenticated HTTP and restart lifecycle; copied live queue saturation fixture proves preservation before eviction.
- **dev-agent-live:** after merge, run the harmless real queue save/readback proof on the development agent; observe post-retention counts and archive preservation.
- **fleet:** ships in the normal release; existing aliases preserve settings and open work. Archive replication uses registered peer-presence cadence, without enabling independent auto-expiry or projected state-sync flags.
- **graduation criterion:** Local Verify and main checks pass; actual queue active IDs remain unchanged; all evicted full records are readable in the archive; restart and peer-offline tests pass.
- **dark-window:** none for the arithmetic/preservation correction: the existing retention behavior is being repaired with fail-safe archival. New sync work is bounded and parks on repeated failure.
- **ladder:** not applicable: correction of existing retention with conservative preservation holds.
