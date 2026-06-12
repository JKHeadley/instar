# Upgrade Guide — One voice: exactly one machine speaks for each conversation

<!-- bump: patch -->

## What Changed

On a multi-machine pool, two of the agent's background voices had no machine
coordination: the 🔭 standby notices (PresenceProxy) had no machine-ownership gate at
all — every machine could answer for the same conversation — and the ⏳ commitment
heartbeats (PromiseBeacon) HAD a gate, but it compared against a field
(`ownerMachineId`) that nothing ever populated, so it was silently inert on every
deployed agent (audit findings F18/F19, MULTI-MACHINE-SEAMLESSNESS-SPEC WS3.1/3.2).

This ships the one-voice layer: a shared deterministic `SpeakerElection`
(`src/monitoring/SpeakerElection.ts`) consulted by both sentinels at their single
emission chokepoints. The topic's owner machine speaks; unknown ownership FAILS TOWARD
SPEECH (lease-holder, then a deterministic lowest-online-id tiebreak) so the pool is
never silent — the failure mode the convergence review proved is worse than
double-voice. A lease-stability dwell defers decisions during a lease flap (bounded,
then tiebreak) and holds a chosen speaker's identity so the voice can't alternate.
Commitments now record `ownerMachineId` at creation, the beacon re-resolves the LIVE
owner at speak time (the stamp is only a fallback), and a PostUpdateMigrator backfill
stamps existing open commitments on deployed agents (idempotent; skipped-not-marked
when no machine identity exists yet).

Ships DARK behind `multiMachine.seamlessness.ws3OneVoice` (default false — verdicts
are byte-for-byte today's behavior). Single-machine agents are structurally inert at
every layer (election never engages below 2 online machines), locked by tests.

## What to Tell Your User

- "When your agent runs on more than one machine, exactly one machine now speaks for
  each conversation's background notices — no more two machines answering the same
  question, and (just as important) never both staying silent because each assumed
  the other had it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One-voice gating for standby + commitment notices | Enable `multiMachine.seamlessness.ws3OneVoice` (multi-machine pools only; dark by default) |

## Evidence

- `tests/unit/SpeakerElection.test.ts` — 13 tests including the exactly-one-speaks
  invariant simulated across whole pools (owner known, owner unknown, no lease-holder,
  OFFLINE lease-holder, flapping lease with bounded defer, dwell hold) and the strict
  legacy/no-op guards.
- `tests/unit/ws3-one-voice-wiring.test.ts` — 11 tests: creation stamp defaults,
  gate seams in both sentinels, one shared election wired server-side, local-only
  ownership reads on the hot path, migration idempotency + the
  no-identity-skips-without-marking retry path.
- All affected suites green (PromiseBeacon ×3, PresenceProxy ×5, CommitmentTracker ×2,
  beacon integration ×3); `tsc --noEmit` clean; full build green.
- Side-effects artifact: `upgrades/side-effects/multi-machine-seamlessness-ws3.md`
  (second-pass review: required and recorded in the artifact).
- Spec: `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md` (converged + approved, on main).
