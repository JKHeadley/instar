# Channel registry — which ways of reaching another agent work right now

## What Changed

New `GET /channels`: every peer-to-peer channel this agent has, each with purpose, when-preferred,
cost, a live verdict and the evidence for it. Adds `src/core/channelRegistry.ts` (pure resolver) and
`src/core/instarChannels.ts` (the four channel definitions with injected probes).

The design property is not the list — a hand-built list was wrong three times in one hour. It is that
**the channel set is code-defined**, so a channel that failed to construct still gets a row saying so;
and that the verdict vocabulary (`working | broken | half-built | reachable-no-credential |
not-configured | unknown`) is wide enough to describe what was actually observed. `unknown` carries a
reason and is counted separately from broken — "could not tell" is not "is down".

Registry First awareness added to the CLAUDE.md template (new agents) and via `PostUpdateMigrator`
(existing agents).

## Evidence

Three refusals, restored to 25/25 green and `tsc` exit 0:

- Drop channels whose probe failed → 5 unit tests fail (`expected […] to have a length of 2 but got 1`).
- Treat an undetermined probe as healthy → 5 unit tests fail.
- Empty the ROUTE's registry → 4 integration tests fail (`expected [] to deeply equal ['a2a-telegram', …]`).

The third was run before the integration test existed: the route served zero channels and all 19 unit
tests passed. The module was guarded; the wiring was not.

## Known limits

Machine-local (no pool-scope merge). One entry (`a2a-telegram` = half-built) is asserted rather than
probed because it is a build-time fact, guarded by a source scan scoped to `src/`. `mutual-ssh`
reports construction, explicitly NOT a completed round-trip. No dashboard rendering. Fixes no
channel. <!-- tracked: CMT-1044 -->

## What to Tell Your User

If you run more than one agent, you can now ask which ways of reaching the others actually work, and
get an honest answer in one place. Each entry says what the channel is for, when to prefer it, what it
costs, and whether it is usable right now — with the reason.

The useful part is what it does when things are wrong. A channel that failed to start still appears,
saying it failed, rather than quietly vanishing from the list. A channel that cannot work out its own
state says so instead of reporting that it is fine. And states like "this can receive but cannot send"
or "reachable, but I hold no key for it" are reported as themselves rather than squashed into working
or broken.

It does not repair anything. It makes the situation legible so a sensible choice is possible.

## Summary of New Capabilities

- Ask which peer channels exist and which are usable right now, with the evidence for each verdict.
