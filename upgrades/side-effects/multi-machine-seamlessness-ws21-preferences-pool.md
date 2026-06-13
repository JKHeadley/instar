# Side-Effects Review — WS2.1 preferences pool: learned preferences replicate across machines

**Version / slug:** `multi-machine-seamlessness-ws21-preferences-pool`
**Date:** `2026-06-13`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `4-dimension adversarial-review Workflow (16 agents) — security / correctness / integration / Phase-C; verdict + fixes appended below`
**Parent principle:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions

## Summary of the change

WS2.1 of the merged MULTI-MACHINE-SEAMLESSNESS-SPEC: the correction-learning
preference store (`PreferencesManager`, `.instar/preferences.json`) becomes
cross-machine. A preference learned on one machine is honored on the others. The
design mirrors the proven `commitments-sync` read-replication pattern: a new
`preferences-sync` MeshRpc verb (read/observe class), seq-windowed incarnation-fenced
delta serve, single-writer per-peer replica store with first-hop sender binding, and a
flag-gated union into `GET /preferences/session-context`. Preferences are ADVISORY
session-start signals (never authority), so this is read replication only — no
write-back, no election, no quorum.

The one genuine design fork vs. commitments (resolved): commitments union on composite
(origin,id) with no cross-origin merge; preferences COLLAPSE by `dedupeKey` (the same
lesson observed independently on two machines is ONE row) so the injected session
block never double-injects the same guidance.

## Decision-point inventory

- Merge winner: newest `(recordedAt, originMachineId)` — HLC-light. `dedupeCount` sums
  across distinct origins.
- Clock-skew: a `recordedAt` beyond `now + 24h` is untrustworthy → loses (treated as
  oldest), not clamped-to-near-now. Within tolerance → normal recency.
- Replication scope: own records only on serve; `learning` redacted; `violationPattern`
  stripped (local-only); per-peer record bound (default 500).
- Gate: `multiMachine.seamlessness.ws21PreferencesPool === true` AND a resolved
  `meshSelfId` AND replicas present → merged; else the untouched own-only path.

## 1. Over-block
None. The feature gates ADD reach (replicated preferences) and never block a message,
a route, or a session. Flag-off / single-machine = strict no-op.

## 2. Under-block (the real risk surface)
The risk is the inverse: replicated preference TEXT is injected into the session-start
block. Mitigations: (a) `learning` is credential-shape-redacted at serve time; (b) the
block already wraps learned preferences as advisory, non-authoritative signals;
(c) first-hop binding rejects forged-origin rows; (d) replicas come only from
registered same-operator Ed25519-authenticated peers. The adversarial review probed
prompt-injection-via-preference-text — accepted residual: a compromised same-operator
machine could inject advisory text, but it cannot escalate to authority, and the
blast radius is one operator's own pool. Recorded as a known bound, not a blocker.

## 3. Level-of-abstraction fit
The engine (`PreferencesSync.ts`) is pure/seam-injected (build/apply/merge are
unit-testable with in-memory fakes). Wiring sits in server.ts/routes.ts/
PeerPresencePuller exactly where `commitments-sync` does. No new transport, no new auth.

## 4. Signal vs authority compliance
Fully signal-only. Preferences never gate or rewrite anything; the merged view only
changes which advisory lessons appear in the session-start block. The mesh verb is
read/observe (adds reach, never authority); the receiver re-binds origin.

## 5. Interactions
- Rides the existing MeshRpc envelope + PeerPresencePuller cadence (no new tick).
- Independent `coherenceJournal.preferences` config section (does NOT couple to
  commitments' tuning — review finding #4/#7).
- Coexists with #1095 (drain) and #1096 (attention pool) — rebased onto both; MeshRpc
  carries `drain` + `preferences-sync` side by side.

## 6. External surfaces
`GET /preferences/session-context` gains an optional `scope:'mesh'` marker + merged
block when the pool is on. `preferences-sync` mesh verb is internal machine-to-machine
(authenticated). No new user-facing HTTP auth surface.

## 7. Multi-machine posture (Cross-Machine Coherence) + Phase C
- **N-machine, no 2-peer assumption:** one replica file per peer; the merge is O(total
  records) across N peers; per-peer bound keeps the merged set bounded; the formatter is
  byte-bounded so the session block can't blow up with N peers.
- **No LAN assumption:** per-peer HTTP over the existing pool fabric; an offline/slow
  peer fails that peer gracefully (the puller doesn't block the tick).
- **Headless / cloud cold-start:** a fresh VM with no replicas pulls fully from seq 0
  (incarnation seeded), no strand.
- **Degraded conditions:** corrupt replica → quarantine + re-pull; rewound store
  (restore) → incarnation re-mint → peers re-pull wholesale.

## 8. Rollback cost
Trivial: flip `ws21PreferencesPool` off (or leave default) → own-only, byte-identical
to pre-feature. The replica files under `state/preference-replicas/` are inert when the
flag is off. No migration of existing data; additive config + entry fields only.

---

## Second-pass review — 4-dimension adversarial Workflow (MANDATORY)

Ran a 16-agent adversarial review (4 parallel dimension reviewers → per-finding
skeptical verification, trust-model-aware). 12 raw findings → **7 confirmed**, ALL
FIXED + tested before ship:

1. **HIGH (security) — violationPattern replicated.** The serve `...r` spread leaked
   the user's local-only self-violation detection regex to peers. **Fix:** explicitly
   strip `violationPattern` from `ReplicatedPreference`. Test: served row has no
   `violationPattern`.
2. **HIGH (security) — clock-skew recency manipulation.** `isNewer` used raw
   `Date.parse` with no bounds; a future-skewed peer won every collision (the spec's
   clock-skew requirement was unshipped). **Fix:** a timestamp beyond `now + 24h` is
   untrustworthy → loses. Tests: future peer loses; legit-newer peer still wins.
   (Full HLC logical counters tracked as follow-up: `<!-- tracked: WS2.1 HLC counters -->`.)
3. **HIGH (correctness) — `meshSelfId ?? 'local'` fallback.** The 'local' sentinel
   mismatched a peer's named origin and corrupted the own-echo filter. **Fix:** the
   merge requires a real `meshSelfId`, else own-only. Test: source-asserted guard.
4/5/7. **MEDIUM/LOW — wrong config section.** preferences-sync read
   `coherenceJournal.commitments` for page sizing. **Fix:** dedicated
   `coherenceJournal.preferences` section + type; both reads repointed.
6. **LOW — meta-sidecar ordering.** Reviewed: `writeAtomic` fsyncs the store fd and
   renames it BEFORE writing the sidecar, so the sidecar is never ahead of the store
   (the rewind fence can't false-trip). No change needed; documented.

Post-fix: 72 WS2.1 tests green; build clean; dark-gate lint clean.
