# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Agent hard-sleep can now actually stop and wake the server (dark + dry-run).**
The previous step taught an idle agent how to DECIDE whether it is safe to sleep but
never acted. This step builds the mechanism that acts on that decision: when sleep is
enabled and the agent is deeply idle and safe, its heavy background server is
stopped to save the machine's resources, and it wakes the instant a message arrives.

The handshake reuses the proven restart lifecycle: the decision layer writes a
sleep-request file, the supervisor stops the server and marks it intentionally
asleep (so it is NOT treated as a crash and is NOT auto-restarted), and an inbound
message makes the lifeline write a wake-request that the supervisor honors by
respawning the server. The waiting message is held in the existing durable queue and
delivered once the server is healthy, so nothing is lost. A safety marker means that
even if an outside watchdog force-restarts the agent mid-sleep, it reads the marker
on startup and stays asleep instead of fighting it. The existing crash-recovery
behavior is unchanged except in the one case where the agent chose to sleep, proven
by the existing supervisor tests staying green.

## What to Tell Your User

Nothing changes on any normal agent — this ships off by default, and the file that
triggers a sleep is only ever written when sleep is explicitly turned on. The future
ability it builds toward: a completely idle agent quiets its server to save your
machine, then wakes the moment you message it, holding your message until it is back
up. Turning it on is a deliberate step we would validate on one test agent first.

## Summary of New Capabilities

- ServerSupervisor honors a sleep-request by stopping the server and entering an
  intentionally-asleep state that suppresses auto-respawn; honors a wake-request by
  respawning. A slept-marker keeps a rebooted (or watchdog-bounced) supervisor asleep.
- The decision layer writes a TTL-stamped sleep-request only in live mode.
- The lifeline writes a wake-request on the next inbound message when the server is
  asleep; the existing forward-retry queue replays the held message after wake.
- All gated by the existing monitoring.agentSleep config — OFF + dry-run by default.

## Evidence

- `tests/unit/ServerSupervisor-sleep-wake.test.ts` — sleep stops + marks + enters
  slept; no-request no-op; expired-request ignored; wake respawns + clears; wake-when-
  not-slept no-op; idempotent re-sleep; boot-marker signal.
- `tests/unit/agentSleepWake.test.ts` — marker present writes the wake-request; no
  marker is a no-op (steady-state awake never writes).
- `tests/unit/SleepController.test.ts` — sleepRequestWriter writes the TTL-stamped flag.
- Regression: the existing ServerSupervisor-handshake / supervisor-health-check /
  supervisor-cpu-starvation suites stay green — the slept short-circuit is the only
  loop-flow change and is a no-op until a live sleep-request is honored.
- Side-effects: `upgrades/side-effects/agent-hard-sleep-mechanism.md`.
