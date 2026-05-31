# Side-effects — Slack reconnect crash guard

## 1. What files/state does this touch at runtime?
`SocketModeClient.ts` (the event-ack send), `server.ts` (the process uncaughtException handler), and a
new `src/core/uncaughtExceptionPolicy.ts`. No new state, config, or schema.

## 2. Does it change any functional behavior?
- The Slack event ack is now skipped when the socket isn't OPEN (instead of throwing). Slack
  redelivers the unacked event, so no event is lost; event processing is unchanged.
- The process uncaughtException handler now suppresses (logs + continues) one additional error class —
  the Slack WS reconnect race ("Sent before connected") — instead of crashing. All other errors,
  including the existing HTTP-race allowlist, are handled exactly as before.

## 3. What happens on failure / weird config?
The ack guard is a pure readyState check + try/catch — it can't fail destructively (worst case: an
ack is skipped and Slack redelivers). `isNonFatalUncaught` returns false for anything unrecognized, so
an unknown error still triggers the FATAL crash-and-restart (the safe default).

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — code-only, compiled into `dist`. No agent-installed file / config /
template change → no `PostUpdateMigrator` pass.

## 5. Could it spam / flood / burn resources?
No. It removes a crash (and its restart cost). The only new log is a `[WARN]` when an ack is skipped
mid-reconnect (rare) or a recoverable uncaught is suppressed (rare). No new timers/IO/network.

## 6. Rollback / off-switch?
Revert the 3 files (re-inline the allowlist in server.ts, drop the new module, restore the unguarded
ack). No data, no migration, no flag.

## 7. Concurrency / ordering?
The ack guard adds a readyState check + try/catch around an existing synchronous send; the try/catch
also covers the (rare) TOCTOU where the socket changes state between the check and the send. No new
concurrency.

## Blast radius
Small + defensive. One guarded send in `SocketModeClient`, one extracted+extended allowlist used by
the process crash handler. The extraction is behavior-preserving for the existing patterns
(adversarially verified); the only behavioral change is that an isolated Slack WS reconnect race no
longer crashes the whole agent.
