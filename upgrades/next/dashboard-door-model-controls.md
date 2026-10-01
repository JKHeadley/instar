# Dashboard: pick the door + model for a topic from the Sessions tab

## What Changed

The dashboard Sessions tab gains three controls over the existing topic-profile
system (docs/specs/dashboard-door-model-controls.md):

- **New Session → Door + Model.** Creating a Telegram topic from the dashboard can
  start it on a chosen framework (door) and model. The pick is written as the
  topic's starting pin BEFORE its session launches (a new lock-serialized store seed,
  `TopicProfileStore.mutateIfAbsent`, attributed `system:dashboard-create`), one fixed
  disclosure line is posted into the topic (deterministic producer
  `topic-profile-creation-seed`), and the change is audited to
  `logs/topic-profile-changes.jsonl`.
- **"Door + model" on a session.** A local Telegram session's header gets a sheet
  that switches its door/model through the existing `POST /topic-profile/:topicId`
  (unchanged policy: token trust + bound operator). The badge reads "switching…"
  until `GET /sessions` reports the launched model.
- **"Default for dashboard-created topics."** A per-machine default
  (`state/new-topic-default-profile.json`) that seeds topics created from the
  dashboard with no explicit pick. Topics started in Telegram and existing topics
  are never changed (Telegram seeding is a tracked hold, issue #2085).

New routes: `GET /topic-profile/options` (what the dropdowns may offer here: door
inventory, tri-state availability `verified | assumed | unavailable`, models,
normalized default model, write regime) and `POST /topic-profile/new-topic-default`
(Bearer + `X-Instar-Request: 1`, 5/min, `{clear:true}` deletes; no PIN).

`POST /sessions/create` now accepts optional `framework` / `model`, spawns Telegram
topics through the one spawn chokepoint (`spawnSessionForTopic`, new `silentStart`
option — the session starts idle, as before) under the `spawningTopics` guard,
registers the binding through the Telegram adapter (the raw
`topic-session-registry.json` write that the adapter's next save clobbered is gone),
and on a session pool places ownership on the creating machine (or refuses
`409 placement-not-authoritative-here` naming the machine that places new topics).
The dashboard writes refuse a door that is provably not installed on this machine
(`code: dashboard-unavailable-door`, `chatPinAllowed: true`); chat and API pins keep
today's fail-open behavior.

## Evidence

- `tests/unit/dashboard-door-model-controls.test.ts` (options derivation, validation
  parity, `mutateIfAbsent` atomicity + husk, regime filter, pool seam, spawn thunk,
  migration), `tests/unit/spawn-session-silent-start.test.ts` (real chokepoint),
  `tests/unit/dashboard-door-model-server-wiring.test.ts`.
- `tests/integration/dashboard-door-model-routes.test.ts` — full HTTP pipeline incl.
  the chat-vs-dashboard divergence and the pool place/confirm/release ordering.
- `tests/e2e/dashboard-door-model-lifecycle.test.ts` — production AgentServer:
  options alive, codex-created topic launches on codex in `GET /sessions`, default
  seeding, existing/Telegram topics untouched, pool placement + refusal + release.

## What to Tell Your User

In the dashboard's Sessions tab you can now choose which AI engine and model a new
topic starts on, switch an existing topic's engine and model from its session view,
and set the starting engine and model for topics you create from the dashboard.
Topics you start directly in Telegram, and topics that already exist, are not
changed by that default. A topic you just created can be switched again after its
first message.

## Summary of New Capabilities

- Door + Model selects in the New Session modal (Telegram topics).
- "Door + model" switch sheet on local Telegram sessions.
- "Default for dashboard-created topics" (per machine in this version).
- `GET /topic-profile/options`, `POST /topic-profile/new-topic-default`.
- `POST /sessions/create` accepts `framework` / `model`.
