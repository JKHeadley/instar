# Multi-machine seamlessness — preferences pool (WS2.1)

## What Changed

- **Learned preferences replicate across your machines.** A preference the
  Correction & Preference Learning loop captures on machine A (e.g. "lead with the
  action, no preamble") is now honored on machine B. New `preferences-sync` mesh verb
  (read/observe class, any registered same-operator peer), riding the existing
  authenticated MeshRpc envelope and the PeerPresencePuller cadence exactly like
  `commitments-sync`.
- **Serve side** — `buildPreferencesSyncPage`: seq-windowed delta pages
  (`lastMutatedSeq > sinceSeq`, exclusive cursor, byte-capped), incarnation-fenced
  (a restored/rewound store re-mints its incarnation so peers re-pull wholesale), and
  the free-text `learning` is credential-shape-redacted at serve time. The local-only
  `violationPattern` (the user's self-violation detection regex) is NEVER replicated.
- **Receive side** — `PreferenceReplicaStore`: one single-writer file per peer,
  first-hop sender-binding (a row claiming a third machine is rejected + counted),
  corrupt→quarantine+re-pull, per-peer bound (default 500).
- **Merged read** — `GET /preferences/session-context?` collapses own + replicas by
  `dedupeKey` (the same lesson seen on two machines is ONE row): newest `recordedAt`
  wins the fields, `dedupeCount` sums across machines. A grossly-future timestamp
  (beyond a 24h skew tolerance) is treated as untrustworthy and loses, so a
  clock-skewed peer can't silently override your real preferences.
- Ships **DARK** behind `multiMachine.seamlessness.ws21PreferencesPool` (default
  false). Single-machine / flag-off = byte-identical to today (own-only). CLAUDE.md
  template + idempotent PostUpdateMigrator bullet so deployed agents learn it.

## Evidence

- `tests/unit/PreferencesSync.test.ts` (18) — serve fence/delta/byte-cap/redaction,
  receive forged-row/incarnation/quarantine/per-peer-bound, merge collapse-by-dedupeKey
  + dedupeCount-sum + recency, and the security-review fixes (violationPattern never
  replicated; future-skewed peer loses; legit-newer peer still wins).
- `tests/unit/PreferencesManager-replication.test.ts` (6) — seq machinery, advert,
  highWaterSeq rewind detection, legacy-store seeding, end-to-end getAllForSync→serve.
- `tests/unit/ws21-preferences-pool-wiring.test.ts` (11) — serve handler registered,
  puller drives, flag default, MeshRpc verb+RBAC, the flag-gated union over the live
  route (off→own-only; on+replicas→merged `scope:mesh`; on+no-replicas→own-only), and
  the real-`meshSelfId` guard.
- `tests/integration/preferences-sync-roundtrip.test.ts` (3) — real signed MeshRpc
  round-trip: paged delta, dedupeKey-collapse, mixed-version 501.
- 72 WS2.1 tests green; `pnpm build` clean. Reviewed by a 4-dimension adversarial
  Workflow (16 agents) — 7 confirmed findings fixed before ship.

## What to Tell Your User

When you run the agent on more than one computer, the little things it learns about
how you like to work now follow you to every machine — you don't have to re-teach it
on each one. It's careful about it: a machine with a wrong clock can't hijack your
preferences, the agent's own private detection rules never leave the machine they're
on, and if the same lesson was learned in two places you see it once, not twice. Off
by default; a single-machine setup is completely unaffected.

## Summary of New Capabilities

- Cross-machine replication of learned preferences (`preferences-sync` mesh verb).
- `GET /preferences/session-context` returns the merged pooled view when the pool flag
  is on, each lesson de-duplicated across machines with a clock-skew-resistant winner.
