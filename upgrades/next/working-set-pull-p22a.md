# Working-set pull verb + pending-pull ledger (P2.2a) — the transfer machinery

## What Changed

Second build slice of the Working-Set Handoff spec (P2 of multi-machine
coherence): the chunked `working-set-pull` mesh verb (both sides), the
durable pending-pull ledger, and never-clobber landing. Nothing schedules a
pull yet — the receiver trigger, reflex route, and staggered drain are
P2.2b. Dark by default: the serve side constructs only where
`multiMachine.coherenceJournal.replication.enabled === true`.

- `working-set-pull` verb (three lockstep edits mirroring journal-sync):
  fresh-manifest-as-allowlist serving, O_NOFOLLOW + fd-identity TOCTOU
  defense, 1 MiB chunked responses (the documented event-loop-starvation
  root cause stays dead), offset-0 whole-file sha256 + cheap fstat
  generation anchor so a file rewritten mid-transfer can never assemble
  into a chimera — bounded restart-from-0, then one honest `unstable`.
- `WorkingSetPuller`: sequential offset cursors with per-tick yields,
  busy-is-retry-without-penalty (a just-woke producer's throttle never
  exhausts recovery records), assembled-bytes budget (discarded restart
  chunks don't count), hostile-relPath jail, and never-clobber landing —
  divergent local files keep their place; the incoming copy lands ALONGSIDE
  (hash-suffixed, capped at 2, eviction through SafeFsExecutor).
- `PendingPullLedger`: the durable EXO-case record. Single-writer
  serialized mutate() funnel (the exact lost-update shape that caused
  topic-flood #3, closed at birth), corrupt-parse quarantine that is NEVER
  silently read as empty, TTL sweep with one honest expiry notice,
  supersession clearing ALL lower-epoch records across nominees, and the
  (peer,topic,epoch) attempt-cap breaker.
- Config: `coherenceJournal.workingSet` block (12 bounded-behavior dials,
  no enable flag — the feature rides the explicit replication gate).
- State-Coherence Registry: new `pending-pulls` category (machine-local,
  single-writer).

## What to Tell Your User

Nothing user-visible yet — this is the transfer machinery for "moving a
conversation between your machines moves its working files too." The piece
that actually fires it on a move (and the on-demand "go fetch that
workspace" reflex) lands in the next slice.

## Summary of New Capabilities

- `working-set-pull` MeshCommand — chunked, bounded, fresh-manifest-gated
  file serving between registered same-operator machines (dark until
  replication is explicitly enabled).
- `WorkingSetPullServer` / `WorkingSetPuller` (`src/core/WorkingSetPull.ts`)
  — the serve/receive engine with generation-anchor consistency, busy
  throttling, and never-clobber landing.
- `PendingPullLedger` (`src/core/PendingPullLedger.ts`) — durable,
  single-writer pending-pull records surviving restarts; the offline-
  producer case re-fires instead of dying at a breaker.
- `coherenceJournal.workingSet` config defaults (ConfigDefaults +
  CoherenceJournalUserConfig).

## Evidence

- `tests/unit/WorkingSetPull.test.ts` — 16 passing (anchor restart lands
  the new content; never-sits-still → `unstable` with nothing landed; busy
  exhaustion re-files without penalty; alongside cap-2 eviction; malicious
  manifest relPaths refused; ownership-recheck abort; assembled-bytes
  budget; serve refusal matrix + TOCTOU symlink swap).
- `tests/unit/PendingPullLedger.test.ts` — 13 passing (concurrent mutate()
  drops no record; corrupt → quarantine + one notice, never silent-empty;
  supersede clears all nominees; breaker + new-epoch reset; TTL once).
- `tests/integration/working-set-pull-roundtrip.test.ts` — 4 passing
  (1.5MB near-cap chunked round-trip through the REAL express.json +
  signed MeshRpcClient path, independent content oracle; full-stack
  refusals; divergent-alongside; mixed-version 501 back-off).
- Adjacent mesh/journal suites unchanged (78 total across 8 suites);
  typecheck + lint chain clean.
