---
title: Stop a Slack Socket-Mode reconnect race from crashing the whole agent
slug: slack-reconnect-crash-guard
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-plus-adversarial-self-review-2026-05-31
approved: true
approved-by: Echo under the 12h autonomous deploy mandate (self-approved; flagged in PR). Found via the mandate's "watch my own operation — fix anything blocking autonomous operation" task in Echo's own server.log; reported to Justin (topic 13435, 2026-05-31).
approval-note: >
  An uncaught exception that crashes the whole agent (closing its SQLite databases) is squarely the
  "fix anything blocking autonomous operation" mandate. Found live in Echo's own log after a
  sleep/wake. The fix is small + low-risk: a readyState guard at the root + a precedent-matching
  allowlist entry as a backstop.
second-pass-required: false
second-pass-status: n/a-small-guard-plus-behavior-preserving-extraction-adversarially-reviewed
eli16-overview: slack-reconnect-crash-guard.eli16.md
---

# Slack reconnect crash guard (#43)

## The crash, grounded

Echo's own `server.log` recorded a `[FATAL] Uncaught exception — closing databases before crash:
Sent before connected.` immediately after a sleep/wake Slack reconnect:
```
[slack] Reconnecting Socket Mode...
[SleepWake] Slack reconnected
[FATAL] Uncaught exception — closing databases before crash: Sent before connected.
```
Sequence: `SleepWakeDetector` wake → `SlackAdapter.reconnect()` (try/caught) succeeds → then a
WebSocket send fired on the freshly-reconnecting socket and threw "Sent before connected". The throw
was in an **async message handler** (`SocketModeClient._handleRawMessage`), so it escaped the
reconnect's try/catch and reached the process-level `uncaughtException` handler, which crashes
(closes databases, `process.exit(1)`). For a laptop agent that sleeps/wakes constantly, this is a
recurring-outage risk.

## Root cause

`SocketModeClient._handleRawMessage` acks every inbound event:
```ts
if (envelope.envelope_id) {
  this.ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
}
```
It checked `ws` is non-null (`?.`) but NOT `readyState === OPEN`, and was not in a try/catch — unlike
the guarded `queueOutbound` (readyState check) and the liveness probe (try/catch). During a reconnect
race the socket can be CONNECTING/CLOSING, so `ws.send()` throws.

## Fix — two layers

**Root** — guard the ack send (mirrors `queueOutbound` + the probe):
```ts
if (envelope.envelope_id && this.ws && this.ws.readyState === WebSocket.OPEN) {
  try { this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id })); }
  catch (err) { console.warn(`[slack-socket] Ack send failed (socket mid-transition): ${err.message}`); }
}
```
If the ack is skipped, Slack redelivers the unacked event — no loss. Event processing (after the ack)
is unchanged.

**Safety net** — the process `uncaughtException` handler already suppresses a small allowlist of
isolated, recoverable errors (HTTP double-response races) instead of crashing. Extract that allowlist
into a unit-testable `src/core/uncaughtExceptionPolicy.ts` (`isNonFatalUncaught`) and add
`'Sent before connected'`: an isolated Slack WS race (the `SocketModeClient` self-reconnects with
backoff; Slack redelivers) must never crash the whole agent and close its databases. The handler now
calls `isNonFatalUncaught(err)`; the FATAL path for unrecognized errors is unchanged.

## Safety (adversarial self-review)
- The extraction is behavior-preserving: same 4 HTTP patterns, same `includes()` substring semantics,
  and `isNonFatalUncaught` returns false for an error with no message (matching the old `?.includes`).
  The only behavioral change is the intended new `'Sent before connected'` suppression.
- Over-suppression: `'Sent before connected'` is specific to the Slack WS send race (it does not
  appear elsewhere in src), and it is genuinely recoverable (the client reconnects on backoff). It
  cannot mask the known fatals (e.g. `mutex lock failed`, sqlite-closed) — tested in
  `uncaughtExceptionPolicy.test.ts`.
- The root guard means the throw is normally prevented at source; the allowlist is the backstop for
  any other Slack WS send race.

## Migration parity
N/A — code-only (`SocketModeClient.ts`, `server.ts`, new `uncaughtExceptionPolicy.ts`), compiled into
`dist`. No agent-installed file / config / template change → no `PostUpdateMigrator` pass.

## Agent Awareness
N/A — internal crash-resilience. No new endpoint/trigger/lookup to surface.

## Test plan
- Unit (`uncaughtExceptionPolicy.test.ts`): `isNonFatalUncaught` — Slack WS race + HTTP races →
  recoverable; unknown errors (mutex/sqlite/undefined) → fatal; non-Error inputs robust.
- Source-assertion (`slack-socket-reconnect.test.ts`, the file's established style): the ack send is
  guarded on `readyState === OPEN` + try/catch; the server routes uncaught exceptions through
  `isNonFatalUncaught`.
- Regression: the slack socket reconnect + heartbeat suites stay green.
