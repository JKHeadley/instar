# Side-Effects Review — Evolution retention targets (EVO-022)

**Version / slug:** evolution-retention-cap-saturation
**Date:** 2026-11-05
**Author:** Echo
**Second-pass reviewer:** independent spec/correctness reviewer; gaps reviewer; archive implementer reviewing root wiring

## Summary of the change

Tier 2. Fix all four saturation sites together, preserve full finished memory in the existing
action archive before eviction, and describe targets honestly. Active work remains eligible
for work, never for size-based abandonment. New archive custody and bounded anti-entropy
close the preservation requirement identified by the corrected September design and current
constitution. Source changes cover the manager, shared archive/sync, existing reconciliation,
HTTP/boot wiring, awareness and migration; tests cover all three tiers. Five spec rounds,
external CLI attempts all timed out and are disclosed, commit attempts not yet started.
The added archive machinery is larger than four arithmetic expressions because activating
those expressions without memory preservation would violate the constitution.

## Decision-point inventory

- Active exemption and terminal allowance — modify: explicit zero result, shared across four stores.
- Config target — modify: new key, deprecated alias, default; explicit invalid values grant no removal.
- Archive custody — add invariant: durable fsync/readback before operational eviction.
- Local identity reservation — modify: monotonically advance across live and archived history.
- Replication — modify: operational eviction sends no deletion tombstone; archived current projections remain repairable.
- Peer import — add invariant: known peer, allowed URL, no redirects, bounded response, full shape/digest validation.
- Retry — add invariant: bounded pages/time, per-peer exclusion, durable failure/cooldown/park at six.
- Pressure — add signal: deduplicated operational warning; no notification or work cancellation authority.

## 1. Over-block

Corrupt archives stop new ID allocation because continuing could reuse a historic reference.
They hold eviction and preserve the hot list. Unknown or invalid targets retain records.
An oversized archive holds import/eviction instead of destroying memory. These are deliberate
conservative failures; no legitimate message, dispatch, session, or active work is blocked.

## 2. Under-block

Targets remain soft: active work, including restored held actions, can exceed them. No hard
whole-store capacity guarantee is claimed. Archive replication is eventual; loss of a source
before peers catch up remains a partition window. Old peers without the new route report
failed sync and park; they are not claimed to have full replicas. Capacity/corruption failures
remain visible, with the source retained. Historic ID reuse before adoption cannot be undone.

## 3. Level-of-abstraction fit

Retention belongs in EvolutionManager's four save funnels. Custody reuses #2468's existing
archive rather than another store. Operational puts reuse existing reconciliation and union
identity. Full archive content cannot use those projected/clamped records, so the custody
copy rides the existing peer-presence callback with no new timer or workflow engine.

## 4. Signal vs authority compliance

Reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

No brittle judgment authority is introduced. Status eligibility, finite integer arithmetic,
content digest validation, ID reservation and custody-before-eviction are hard invariants.
Pressure produces a signal only; no active-work cleanup or outbound operator notice follows.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. The existing optional pending
auto-expiry policy is unchanged, including critical/high/pinned/future-due/hold protections.
Record age is not introduced as retention authority.

## 5. Interactions

Archive writes preserve unknown fields and all prior versions, including expiry/restoration
metadata. Imports re-read after every await so they cannot overwrite an intervening save.
Crash between archive and hot save leaves a duplicate recoverable source, never lost content.
Existing retry repair sees one current projection per actual replication identity: live wins,
latest archive otherwise; auto-expired pending snapshots remain cancelled on the wire.
Retention no longer sends tombstones. Restoring a terminal action holds it hot, so success
cannot immediately re-evict it. Per-peer sync concurrency is excluded and shutdown aborts it.

## 6. External surfaces

New authenticated GET /evolution/retention reports per-machine pressure, partial coverage and
unknown stores. GET /evolution/archive serves bounded full-content local memory with origin,
digest and pagination, including peer replicas. Replicated text is untrusted data; importing
it never creates local work, local ID allocation, instructions or execution authority.
Old max settings retain meaning as deprecated soft-total aliases; zero is respected.
Agent awareness is included in new templates, capability discovery, and existing migration.
No constitution, approval policy or unrelated proposal is changed.

## 7. Multi-machine posture

Memory is replicated as full immutable origin/kind/record envelopes into the SAME
state/evolution/action-archive.json (replicaEntries). The existing peer-presence cadence pulls
bounded pages and relays previously received content, so B can seed C when A is offline.
Local archive reads require no owner network access after catch-up. Durable content precedes
cursor movement; incarnation changes rescan; repeated pages deduplicate by content digest.
Operational pressure uses the existing allowlisted pool reader and records missing peers.
No claim of instantaneous redundancy or healthy absent measurements is made.

## 8. Rollback cost

Code can be reverted, but a revert alone does not repopulate hot lists. Archived records must
be copied/restored from full preserved versions if the older operational view is required.
Never delete the archive. Unknown metadata remains compatible with older action archive reads;
older writers do not preserve new fields, so stop archive writers during an operational
rollback and restore the state-directory backup if needed. No memory migration deletes data.

## Conclusion

The four arithmetic corrections ship with honest targets, post-retention population metrics,
full-content archive custody, stable references and bounded replication. All preservation
failures retain source content and remain visible. Independent review and exact-head Local
Verify are required before the authorized safe merge.

## Second-pass review

Independent correctness reviewer: Concur after fixing fresh restore-history merge and durable
pre-network budget reservation; independently ran the four regressions. Gaps reviewer found
legacy-origin, repeated-restore and cursor-skip issues; each has a permanent regression.
Archive implementer independently reviewed root boot/HTTP/retention/projection wiring: pass.
Final combined archive/retention/self-action tests: 596/596 pass. Broader checks continue.
The first local full-suite attempt encountered denied writes to real home-directory fixtures
inside this restricted session, plus source/build changes made while it ran. It is not claimed
as a green full-suite result. Exact-head Local Verify remains the merge authority.

## Local Verify compatibility correction

The first completed exact-head peer run passed 58598 unit tests and found one failure in
`evolution-manager-evidence.test.ts`: the new numeric-only read validator rejected the
pre-existing `EVO-LEGACY` fixture. Reproduced locally, then extended to all four stores:
5 compatibility tests failed before the correction. Preserve historical opaque ID labels
verbatim across hot reads, archive and restart; only new allocations use monotonic numeric
suffixes. Numeric recognition is anchored to digits, so `EVO-1e3` stays an opaque label.
A shared bounded, nonempty, no-NUL validator keeps the hot and archive contract aligned.
The independent reviewer concurred: changing the old fixture would hide a real regression.
After correction, all 619 tests in the evidence, retention, archive and self-action files pass;
HTTP integration 4/4 and authenticated server/restart 1/1 pass. TypeScript checking passes.
The corrected exact head still requires a new complete Local Verify result before merge.

## Evidence pointers

- docs/specs/reports/evolution-retention-cap-saturation-convergence.md
- tests/unit/evolution-retention-cap.test.ts: all four below/at/past boundaries, zero/invalid values, corruption, IDs, restore and crash retry.
- tests/unit/evolution-archive.test.ts: durable custody, full gossip, cursor/restart/backoff/parking, bounded inputs.
- tests/integration/evolution-retention-api.test.ts: HTTP pressure/content/restore/pagination/unknown coverage.
- tests/e2e/evolution-retention-lifecycle.test.ts: authenticated production server and restart.

## Class-Closure Declaration (display-only mirror)

unbounded-self-action, closure guard, ratchet tests/unit/self-action-convergence.test.ts.
The archive sync retry edge is the self-action: under unchanged permanent peer failure,
a maximum of six failed pulls occurs, durable parked state survives restart, and no later
presence tick can rearm it without new transport evidence or explicit reset. The existing
ratchet and real worker tests exercise the settling brake. No new defect-class semantics.
