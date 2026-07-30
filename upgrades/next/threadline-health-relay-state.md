# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`GET /threadline/health` returned `status: 'ok'` as a hardcoded literal and never consulted the relay at all. On 2026-07-30 the relay was DISPLACED at 04:56:12Z — another machine connected with the same identity key, which disarms reconnect for the life of the process — and this route reported `ok` for the following 6h45m while the agent could neither send nor receive. 131 agent-to-agent messages queued unsent behind it.

Every input needed was already in-process and unread. `relayConnectionObserver` had recorded the loss with a `terminal` flag; `ThreadlineBootstrap` exposed it as `getLastRelayEvent()` and nothing captured it; `threadline_discover` was reporting `staleReason: 'relay not connected (state=unknown)'` at the same moment. This was a wire that was built, documented, and never connected.

The handler now reads live `connectionState` plus the last loss event and reports a `relay` block — `state`, `recoverable`, and `since` — with `status` moving off `ok` when the relay is genuinely down. Both sources are needed: live state gives up/down, but only the recorded event distinguishes an ordinary drop (retries by itself, `recoverable: true`) from a displacement (never self-heals, `recoverable: false`, needs a restart). Treating a permanent outage as a transient blip is the failure being fixed.

Three deliberate non-alarms, so the check stays trustworthy: a relay that is disabled or owned by the listener daemon reports `not-configured` and stays `ok`; a live connection wins over a stale terminal record; and a throwing probe degrades to `not-configured` rather than failing the endpoint.

Peer discovery is unaffected by design. `AgentDiscovery.verifyAgent` gates on `response.ok` + `identityPub` + `protocol` and never on `status`, so a degraded relay cannot make a peer drop this agent — a test pins that contract.

## What to Tell Your User

If you asked me "is my agent-to-agent connection working?" before today, I could only ever answer "fine" — the answer was written into the code as a constant. I said fine for nearly seven hours while that line was completely dead and your messages were piling up unsent. I can now tell you the truth, including whether the problem will fix itself or needs me restarted.

Note the honest limit: this makes the truth available, it does not yet alert you. Nothing proactively tells you the line is down.

## Summary of New Capabilities

`GET /threadline/health` now carries a `relay` block (`state`, `recoverable`, optional `since`) and a `status` that reflects reality: `ok` when connected or when no relay applies, `degraded` for a drop that will retry, `error` for a displacement that needs a restart. Relay states reported: `connected`, `disconnected`, `displaced`, `never-connected`, `not-configured`.

The response is unauthenticated, so the relay's raw reason string is deliberately NOT exposed — only a code-defined state, a boolean, and a timestamp.

## Evidence

- 13 new tests covering both sides of every branch: not-configured (no probe, and probe returning null), connected, disconnected-with-retry, displaced-terminal, never-connected, live-connection-beats-stale-terminal-event, throwing probe, and a no-secret-leak assertion.
- Red-green verified rather than assumed: reintroducing the pre-fix behaviour (`return ok` unconditionally) makes the suite fail (exit 1); restoring gives 13/13.
- Back-compat verified: the pre-existing 20 tests in `ThreadlineEndpoints.test.ts`, which assert `status === 'ok'` with no relay wired, still pass — 33/33 across both files.
- Discovery contract pinned by test: HTTP 200, `protocol`, and `identityPub` all hold while the relay is displaced.
- `tsc --noEmit` clean project-wide.
