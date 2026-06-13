# Topic profiles — pin the Claude Code effort level per topic

## What Changed

- Topic profiles gain an optional **`effort`** field (`low|medium|high|xhigh|max`),
  mirroring the existing `model`/`thinkingMode`/`framework` pins. When set, instar
  passes `--effort <level>` to Claude Code at session spawn, so the choice survives
  respawns. Settable conversationally ("set max effort on this topic") and via
  `/topic effort <level>`; exposed on `GET /topic-profile/:id` as
  `resolved.effort` + `sources.effort`.
- Argv injection in both Claude Code launch builders (`frameworkSessionLaunch.ts`):
  interactive (after `--dangerously-skip-permissions`) and headless (after
  `--model`, before `-p`). A direct effort pin wins over the `thinkingMode`→effort
  mapping (exactly one `--effort` emitted). Non-Claude frameworks ignore it.
- Closed enum, **fail-open at three layers** (resolver, launch builder, write API):
  an off-enum / `ultracode` value never reaches the CLI. `ultracode` is not a CLI
  `--effort` value (the harness exposes it only via the UI `/effort` picker — filed
  as framework-issue a06fb2aa); this pin reaches the CLI ceiling `max`.
- `classifyProfileChange` gets a dedicated effort-only row: an effort change is a
  launch-time flag → clean kill + `claude --resume` (none-loss when resume-ready),
  with its own honest reason (not mislabeled as a thinking change).

## Evidence

- `tests/unit/topicProfileResolver-effort.test.ts` (6): valid pin resolves;
  invalid/`ultracode` → fail-open undefined (never throws); absent → undefined;
  config-default honored/clamped; pin wins over config.
- `tests/unit/frameworkSessionLaunch-effort.test.ts` (13): `validateEffortLevel`
  both sides; interactive `--effort` position; headless position; absent → none;
  invalid → dropped; direct-pin-wins-over-thinkingMode (one `--effort`); non-claude
  no-op.
- `tests/unit/classifyProfileChange.test.ts` (+4): effort-only → resume/none-loss,
  not gated on thinking flags, effort-specific reason.
- `tests/integration/topic-profile-routes.test.ts` (+3): POST→store→GET data-flow,
  off-enum 400, `effort:null` when unset. `tests/unit/topic-profile-server-wiring.test.ts`
  (+1): the spawn handoff. `tsc --noEmit` clean; topic-profile suite green.

## What to Tell Your User

You can now pin how hard Claude thinks on a specific topic — say "set max effort
on this topic" and every session I start for it runs at that effort level, and it
sticks across restarts (the same way pinning a model or thinking depth already
does). The five levels are low, medium, high, xhigh, and max. (The "ultracode"
mode you pick in the Claude Code UI is a session-only setting the command line
can't pin yet — this gives you the max effort level it can; I've filed the rest
as a gap.)

## Summary of New Capabilities

- Per-topic `--effort` pin (`/topic effort <level>` or conversationally), durable
  across respawns, exposed on `GET /topic-profile/:id`.
