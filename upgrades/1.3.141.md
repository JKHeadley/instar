# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Foundation for agent hard-sleep: the SleepController decision layer (dark).** The
deepest lever of the Responsible Resource Usage work is letting a deeply-idle agent
drop its server to near-zero footprint and wake instantly on the next message. That
mechanism is risky, so this change ships the SAFE half first: the part that decides
"is it actually safe for this idle agent to sleep right now?" — and nothing else.

The new SleepController returns one of four verdicts — awake, idle-shallow,
keep-awake, or would-sleep — and applies every safety guard before it will ever say
would-sleep: it refuses if this machine currently holds the multi-machine serving
lease, if there is work in flight, or if a scheduled job is about to fire. Each
guard names itself in the reason. It ships OFF by default and, even when enabled,
runs in dry-run: it only records its decision to a log and serves it at a status
endpoint. It has no power to stop a server — that mechanism is a separate slice,
built only once this decision layer has been watched behaving correctly on a real
idle agent.

## What to Tell Your User

Nothing to configure, and nothing changes in how your agent behaves. This is the
groundwork for a future ability where a completely idle agent can quiet down to save
your machine's resources and wake the instant you message it. For now it only
watches and decides — it never actually sleeps anything — so it is safe and
invisible. You can see what it would decide at the sleep status endpoint.

## Summary of New Capabilities

- New SleepController decides whether a deeply-idle agent may hard-sleep, with
  safety guards for held multi-machine lease, in-flight work, and imminent
  scheduled jobs. Pure, exhaustively unit-tested on both sides of every boundary.
- New shared AgentActivityState idle signal, bumped at the inbound-message
  chokepoint so a genuinely-messaged agent never sleeps.
- GET /sleep exposes the live verdict, reason, thresholds, and whether sleep is
  armed. Read-only, Bearer-auth, 503-stub when disabled.
- Decision transitions audited to logs/agent-sleep-events.jsonl (low-noise).
- Config monitoring.agentSleep — OFF + dry-run by default.

## Evidence

- `tests/unit/SleepController.test.ts` — both sides of every guard boundary
  (grace, deep-idle, lease, in-flight, scheduled-job), exact-threshold boundaries,
  most-recent-of-inbound-vs-activity, dry-run-never-acts, once-per-episode latching,
  transition-only audit, plus AgentActivityState.
- `tests/integration/sleep-controller-routes.test.ts` — GET /sleep returns 503
  unwired and 200 with the live verdict + thresholds when wired (feature is alive),
  and surfaces the blocking guard reason.
- Side-effects: `upgrades/side-effects/agent-hard-sleep-controller.md`.
