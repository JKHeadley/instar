# Side-Effects Review — per-peer homebase backfill + gate default-on

## Summary of the change

Bug (Echo Bugs topic 10000000668): the per-peer homebase topic was only created from the
pairing-confirm route at the moment a pairing became mutual-verified, so peers paired before the
feature merged (pp, paired 2026-10-21) never got one; and creation sat behind the
development-agent gate, so fleet builds (incl. the Mama PC) never created one.

- `src/threadline/peerHomebaseBackfill.ts` (new): `PeerHomebaseBackfill` — `onContact(peer)` and
  `sweep()` both call the existing `ensurePeerHomebase`. Cheap checks first (enabled, lease,
  mutual-verified, already recorded, 10-minute retry quiet period), single-flight per peer.
- `attachPeerContactHook` wraps the recorder's `record` from outside (the canonical store's
  producer file is untouched — no format change): after a NEW leg is appended (inbound or
  outbound) with a known peer it calls `onContact`. Wrapped in try/catch.
- `src/commands/server.ts`: constructs the backfill after the trust manager exists (late-bound
  into the recorder) and runs one sweep ~60s after boot (timer unref'd).
- `src/threadline/peerHomebase.ts`: `peerHomebaseEnabled(config)` — default ON, explicit `false`
  off. Used by the confirm route (replacing `resolveDevAgentGate`) and the backfill.
- Awareness card updated; `migrateClaudeMd` replaces the old card in place when it still says
  "there is no backfill" (idempotent). Spec §6.1 + ELI16 addendum record the gate decision.

Tier 2 (spec-driven: docs/specs/peer-conversation-homebase-topic.md). Size: 6 src files,
~150 LOC src, 3 test files. Effort: no new spec rounds (the backfill was the spec's own §6 cut,
now built); one commit attempt planned.

## Decision-point inventory

- "Should this peer get a homebase topic now?" — deterministic: enabled ∧ lease holder ∧
  pairingState === 'mutual-verified' ∧ no recorded id ∧ not inside retry quiet period. Same
  predicate the confirm route already used, plus the quiet period.
- Gate default flipped from dev-gated to on.

## 1. Over-block

Not a blocking surface. A peer with a recorded homebase, a non-verified sender, a standby, or a
peer inside the 10-minute quiet period simply gets no creation attempt — correct.

## 2. Under-block

- A peer whose message path does not pass `peerFingerprint` to the funnel is covered only by the
  boot sweep (next restart). Acceptable: the sweep covers every mutual-verified profile.
- A standby never creates; if the lease moves later, the next contact on the new holder creates
  (holdsLease is read live). The sweep only runs at boot.
- If the name lookup finds an unrelated human-created topic with the same name, it is adopted —
  the spec's accepted §6 risk, unchanged.

## 3. Level-of-abstraction fit

The canonical thread-log funnel is THE single chokepoint every inbound/outbound A2A leg passes
(enforced by its own wiring-integrity test), so wrapping the contact hook around it covers every
path without touching individual routes. Creation itself stays in `ensurePeerHomebase`, so
there is one creation discipline, not two.

## 4. Signal vs authority compliance

No authority added. The hook observes a message that was already recorded and triggers a
best-effort side-effect; it can never block, delay, or alter delivery (fire-and-forget, all
errors swallowed and logged).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The predicate is an enumerable
invariant (verified pair, no recorded topic, lease holder).

## 5. Interactions

- Confirm route and backfill can race for a peer verifying while a message arrives: both use
  find-or-create by name and `setHomebaseTopic` refuses a different id, so the worst case is the
  same topic found twice; within one process the backfill's single-flight also dedupes its own.
- System-topic adoption / lease: same `!state.readOnly` signal as system topics.
- Topic-creation budget: `findOrCreateForumTopic` with `origin: 'user'`, unchanged from the route.

## 6. External surfaces

Creates one Telegram forum topic per mutually-verified peer lacking one — on Echo, that is pp's
topic on the next contact or ~60s after the next restart. Fleet agents with verified peers now
get these topics (default flipped on). Bounded by human-gated pairing.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local creation BY DESIGN (physical-credential-locality: the bot token's forum namespace),
lease holder only; the recorded id lives on the trust profile, which replicates with the peer
record as before. A standby does nothing.

## 8. Rollback cost

`threadline.peerHomebase.enabled: false` stops all creation immediately (read live by the
backfill). Code revert is clean; topics already created stay (harmless, can be deleted by hand).

## Conclusion

Ships. Closes the spec's own §6 backfill cut and records the default-on decision in §6.1.

## Second-pass review (if required)

Not required: no messaging block/allow decision, session lifecycle, gate, sentinel or watchdog;
a best-effort create-once side-effect off the delivery path.

## Evidence pointers

- tests/unit/peer-homebase-backfill.test.ts (12 tests)
- tests/integration/peer-homebase-create-and-record.test.ts (real funnel → real trust store)
- tests/unit/PostUpdateMigrator-peerHomebaseRefresh.test.ts

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. Self-action convergence for the new self-triggered create:
control edge = message contact → create-once; steady-state bound = at most one successful
creation per mutual-verified peer ever (recorded id short-circuits all later attempts), and at
most one attempt per peer per 10 minutes while failing; settling brake = recorded id +
retry quiet period + single-flight.
