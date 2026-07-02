<!-- bump: minor -->

## What Changed

U4.1 pin persistence lands: the WS1.3 pin machinery is graduated and hardened
instead of rebuilt (spec: `docs/specs/u4-1-pin-persistence.md`, converged 5
rounds + approved). A deliberate placement pin ("run this on the mini") now
survives lease handovers and machine bounces, and the placement read reports
the VERIFIED actuation state, never intent alone.

The seven named defects, fixed against the existing machinery:

1. **Unpin propagates.** Every pin mutation now rides a one-HLC funnel
   (`TopicPinMutation`): ONE stamp on both the local store write and the
   replicated `topic-pin-record` emit. An unpin emits a replicated TOMBSTONE
   (the previously zero-caller `buildTopicPinTombstone` is wired at the clear
   chokepoint + the new `POST /pool/unpin` surface), so a stale replicated PUT
   can never silently re-pin a topic the operator unpinned — the live defect-2
   bug.
2. **Corrupt pin file → quarantine-aside + ONE deduped attention item +
   resolve-to-unknown** — never the old silent wipe-and-persist (success-shaped
   total loss of operator intent).
3. **Answer-complete replication read.** `topic-pin-record` retention is now
   rotate-but-never-delete, and the advisory read is a boot-time full-stream
   FOLD (own + every peer-replica stream, active + archives, no
   `READER_MAX_LIMIT` clamp) + an offset-tracked incremental tail — replacing
   the newest-500 tail window that silently dropped a long-untouched topic's
   winning record (the read-window bug review round 2 caught). Bounded by a
   loud `ws13FoldMaxBytes` byte-guard (newest-first truncation + ONE item
   naming the unfolded ranges — never silent).
4. **HLC skew gate + STICKY durable quarantine.** A future-skewed pin record
   (past the existing `maxDriftMs` clamp) is excluded at the fold — never
   merged, never able to beat an honest tombstone — and quarantined DURABLY
   keyed on the exact `(key, hlc)` pair, immune to clock progress. The
   exclusion acts ONLY at the fold: the applier deliberately
   accepts-and-persists a skewed record (refusing at its door would
   suspect-halt the peer's entire pin stream). Dismissing the attention alert
   never re-admits the record; re-admission is the explicit
   `POST /pool/pin-quarantine/readmit`. Self-clearing is honest supersession
   only.
5. **One convergence engine + actuation verification.** Becoming placement
   router (lease acquisition or boot) triggers ONE immediate reconciler tick
   (epoch-fenced); moves are paced (`ws13MaxMovesPerTick`); and
   `GET /pool/placement` reports `pinState`
   (`actuated`/`pending`/`diverged`/`suspended-pending-owner-return` — the
   U4.2 joint value, tolerated from day one) + `pinHeldSince` (the winning
   record's HLC physical) + `pendingReason` + local-only `pinnedBy`
   provenance. `diverged` raises ONE deduped item per episode.
6. **Pending-pin honesty + the offline-target churn fix.** Pin fulfilment AND
   owner-side transfer initiation require the target SUSTAINED-online
   (`ws13SustainedOnlineMs` hysteresis; boot fail-open) — a pin toward an
   offline/flapping machine yields `pending` with the reason named, never the
   silent transfer→abort churn loop every ~2.5min. A live autonomous run
   defers pin-driven moves indefinitely (no deadline override); a pin pending
   past `ws13PendingPinMaxAgeMs` raises ONE fulfil-or-unpin item.
7. **Durable rollback.** `ws13Reconcile` is removed from the migrator's
   dev-gate strip list: an operator's explicit `ws13Reconcile: false` (the
   documented re-darken lever) now SURVIVES every migrator run instead of
   being silently reverted.

Shipping posture: NO new flag — the `ws13` family itself graduates (dev-gated:
live-in-dryRun on a development agent, dark on the fleet). Both flags are now
`loadBearing: true` in the guard manifest (criticalPath: deliberate placement
persistence) so a stalled dark/dry-run posture classifies loudly per #1318.

## What to Tell Your User

When you deliberately put a conversation on a specific machine ("run this on
the mini"), that choice now sticks — it survives restarts, machine handoffs,
and network hiccups, and unpinning it sticks too (no ghost copy can quietly
re-pin it later). You can always ask "why is this topic not on the machine I
pinned it to?" and get a verified, honest answer: actually there, queued (with
the reason, e.g. that machine is offline), or drifted (which raises one
attention item instead of failing silently). Most of this ships dark for the
fleet and live on development agents first — nothing changes on your setup
today until it graduates.

## Summary of New Capabilities

- `GET /pool/placement?topic=N` now carries `pinState`
  (`actuated`/`pending`/`diverged`/`suspended-pending-owner-return`),
  `pinHeldSince`, `pendingReason`, and length-clamped `pinnedBy`.
- `POST /pool/unpin` `{"topic":N}` — the deliberate unpin; the clear
  replicates as a tombstone (503 when the pool is dark).
- `GET /pool/pin-quarantine` — the sticky skew-quarantine set + fold status
  (503 when pin replication is dark).
- `POST /pool/pin-quarantine/readmit` `{key, hlc}` — the explicit per-record
  re-admission (an authority decision distinct from dismissing the alert).
- New `multiMachine.seamlessness` knobs (§2.G): `ws13DebounceMs`,
  `ws13TransferDeadlineMs`, `ws13SustainedOnlineMs` (120s),
  `ws13PendingPinMaxAgeMs` (24h), `ws13MaxMovesPerTick` (2),
  `ws13DivergedWindowMs` (10min), `ws13FoldMaxBytes` (64MB).
- New machine-local state: `state/session-pool/topic-pin-skew-quarantine.json`
  (registered in the state-coherence registry; bounded by domain cardinality).
- Guard manifest: `ws13Reconcile` + `ws13PinReplicate` registered
  load-bearing; the reconciler self-registers a runtime `guardStatus()`.

## Evidence

All three tiers green locally (the full suite at zero failures): 34 unit tests
across the two u41 files (one-HLC funnel both arms, tombstone ordering,
never-resurrect order-independence, skew quarantine never-merged/never-immortal
+ sticky-across-clock-advance + ack-never-readmits, applier ACCEPTS the skewed
record and the stream stays live (R-r3-1 locked), fold byte-guard episode
semantics, corrupt-store quarantine byte-for-byte, pinnedBy local-only,
lease-acquisition epoch fence, Case-A offline zero-churn, sustained-online
gates on Case-A + Case-D, autonomous-run indefinite deferral, replay bounded +
paced, aged-pending/diverged one-item-per-episode, pinStateOf all four states,
guard-manifest constants + expectRuntime honesty) + 2 PlacementExecutor
fulfilment-hysteresis tests + migrator both-directions tests (the explicit
false SURVIVES; the 4 remaining flags still strip; idempotent). 14 integration
tests: the answer-complete fold over the REAL journal (>600 events, real
rotation, peer-replica stream; the clamped tail read provably MISSES the
long-untouched winner the fold returns), offset idempotency, and the routes
over the real router (pending→diverged flip through HTTP, suspended tolerance,
unpin tombstone, re-admit exact-pair + forced re-fold, 400/404/503 arms). 4
feature-alive E2E tests through the real AgentServer, including THE SPEC'S
LOOP: pin on A → lease moves to B → B's acquisition tick converges → A claims
→ the placement read shows `actuated` on A. The Tier-4 live-user-channel
matrix gates the dryRun-exit/fleet graduation step (it needs the merged build
deployed on a live multi-machine dev agent), not this merge
<!-- tracked: CMT-1875 -->.
