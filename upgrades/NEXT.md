# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

This release bundles four changes that landed together.

**1. Per-feature LLM metrics (the measurement layer + the funnel tap).** Instar
runs a growing set of LLM-driven safety/quality checks (sentinels and gates), and
until now there was no way to see, per check, what it costs or how often it
actually fires. A new read-only `FeatureMetricsLedger` plus a `GET
/metrics/features` endpoint hold that data, and the single shared LLM call
(`CircuitBreakingIntelligenceProvider.evaluate`) now records, per calling feature,
its latency, whether it had to wait out a rate-limit window, and success/error.
So `/metrics/features` goes from empty to live as your checks run. Pure
observability — one side-channel write per call, in a swallow-all try/catch, with
the breaker control flow byte-identical.

**2. Primary-developer mode (`updates.restartImmediately`).** A new per-agent,
opt-in config flag (default **false**). When true, that agent's update restarts
are never deferred for active sessions or the restart window — it always rolls
onto the latest version as soon as it is downloaded. Intended for the instar
developer's own agent (always-current matters when you build and dogfood the
fleet). Off by default, so the fleet's existing session-aware restart deferral is
unchanged. A server restart does not close the agent's sessions (they resume via
CONTINUATION); the only cost is a brief messaging blip.

**3. Agent-to-agent reply-waits no longer flood the user's chat.** When an agent
sent a Threadline message to another agent, the reply-tracking commitment was
created with the beacon enabled and the user's topic attached, so `PromiseBeacon`
fired cadenced "awaiting reply" heartbeats straight into the user's chat for a
purely agent-to-agent conversation. The reply already routes back on its own, so
the heartbeat was pure noise. These reply-wait commitments now have the beacon
disabled — a direct application of the Near-Silent Notifications standard.

## What to Tell Your User

Mostly nothing to configure. Three things you might notice:

- The agent can now report, per safety check, how much it costs and how often it
  fires — the data that lets us tune the checks with evidence instead of guesses.
- If your agent talks to other agents, it will no longer fill your chat with
  "awaiting reply" status while it waits for a peer — the peer's reply still
  arrives and lands in the right place exactly as before. Any status pings that
  were already running stop on their own.
- There is a new opt-in mode for an agent that must always run the very latest
  build. It is off by default and changes nothing unless you ask for it; if you
  want it on, just tell your agent and it can turn it on for you. Turning it on
  means the agent updates the instant a new version is ready instead of waiting
  for a quiet moment — your sessions survive the restart, so nothing is lost.

## Summary of New Capabilities

- `FeatureMetricsLedger` + `GET /metrics/features` — per-feature LLM cost
  (latency p50/p95), call-count, rate-limit wait-rate, and error-rate, fed by a
  single instrumentation point in `CircuitBreakingIntelligenceProvider` (covers
  all current and future LLM features). Fired-vs-noop verdict + token attribution
  are a later phase.
- `updates.restartImmediately` (per-agent, default false) — never defer update
  restarts for active sessions or the restart window. `UpdateGate` gains
  `alwaysRestartImmediately` (+ a runtime setter); the same-version cooldown and
  cascade dampener are preserved. Surfaced in `GET /updates/status`.
- `TopicLinkageHandler` creates threadline-reply commitments with
  `beaconEnabled: false` — reply-routing (relatedThreadId + topicId) preserved;
  only the user-facing heartbeat is suppressed. User-facing beacons for genuine
  commitments to the user are unchanged.

## Evidence

- Metrics: `tests/unit/FeatureMetricsLedger.test.ts`,
  `tests/unit/CircuitBreaking-feature-metrics-tap.test.ts` (funnel to a real
  ledger, end-to-end), plus the `/metrics/features` route + lifecycle tests. The
  cost was surfaced live when an unattributed rate-limit could not be pinned to
  any one gate.
- restartImmediately: `tests/unit/UpdateGate.test.ts` (+7 — allow-despite-healthy
  -session, pure-no-deferral, default-still-blocks, runtime toggle both ways) and
  `tests/unit/AutoUpdater.test.ts` (+2 — default false; `true` reflected via the
  real gate). Motivating incident: Echo sat two releases behind for 5+ hours
  behind "active" sessions.
- PromiseBeacon: `tests/unit/TopicLinkageHandler.test.ts` asserts
  `beaconEnabled === false`; `tests/unit/CommitmentTracker-threadline-reply.test.ts`
  confirms the mechanism still honors an explicit opt-in. Observed in the wild as
  dozens of heartbeats burying one user topic.
