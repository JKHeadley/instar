# Codex session-wedge self-recovery (escalating, dark by default)

## What Changed

A codex conversational session can wedge: the server is healthy and messages are
delivered, but the session sits paused with an injected message stuck at the
prompt, never draining into a turn. `StuckInputSentinel` already detects this
(marker-based), but its recovery topped out at keypresses — which, live, weren't
enough; the session needed a full server restart + queue replay, performed by
hand. This adds an **escalating self-recovery** so a codex session heals itself
with no external nudge.

The hard part is a process boundary: the detector (`StuckInputSentinel`) runs in
the server process, but the restart authority (`ServerSupervisor` + queue replay)
runs in the lifeline process. So the fix is split cleanly:

- **`SessionRecoveryChannel`** — a cross-process request/ack channel. The server
  emits recovery requests (sole writer of the request file); the lifeline writes
  acks (sole writer of the ack file) — single-writer-per-file, atomic, so the two
  processes never race.
- **Sentinel escalation** — after the keypress ladder exhausts but the marker is
  still stuck, the sentinel requests a tier-C recovery, polls the ack, verifies,
  and bounds the wait (no restart loop).
- **`SessionRecoveryConsumer`** (lifeline) — reads tier-C requests and performs
  `performGracefulRestart` + `replayQueue`, dry-run-first, guarded by a **durable**
  cooldown (a server restart wipes the sentinel's in-memory bound, so the loop
  guard has to survive the restart).

Ships **dark** behind `monitoring.codexWedgeRecovery` (default off; `dryRun:true`
first). With no config it is byte-for-byte the legacy behavior.

## What to Tell Your User

When one of my codex-driven sessions gets stuck — paused with a message that never
turns into a reply — I can now work myself loose without anyone stepping in:
first by nudging the prompt, and if that is not enough, by cleanly restarting my
own server and replaying the queued message. It is turned off by default and ships
in a watch-only dry-run mode first, with a built-in cooldown so it can never get
into a restart loop. You decide when to turn it on.

## Summary of New Capabilities

- A codex session that wedges (input delivered, not draining) can self-recover by
  escalating from keypresses to a server restart + queue replay — no external agent.
- The escalation is bounded and has a durable cross-restart cooldown, so a wedge
  that a restart can't fix can never cause a restart loop.
- Ships dark + dry-run on the Graduated-Feature-Rollout track
  (`monitoring.codexWedgeRecovery`); absence of config = off, so no migration is
  needed and existing agents are unaffected until explicitly enabled.

## Evidence

- 78 tests across 3 tiers: unit (`SessionRecoveryChannel` 15, `StuckInputSentinel`
  escalation 7, `SessionRecoveryConsumer` 8, plus the existing stuck-input suites)
  + integration (`tests/integration/codex-wedge-recovery.test.ts` 3 — the full
  sentinel→channel→consumer→ack→sentinel loop through the real channel, live +
  dry-run + dark-disabled paths).
- `tsc --noEmit` clean; `pnpm build` clean.
- Dark-by-default verified: with no config, the sentinel never escalates and the
  lifeline never starts the consumer (asserted in unit + integration).
- Spec: `docs/specs/CODEX-SESSION-WEDGE-SELF-RECOVERY.md` (grounded gap-analysis +
  cross-process design + the durable-cooldown finding + the increment plan).
