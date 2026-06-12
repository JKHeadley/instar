# Side-Effects Review — SocketModeClient websocket leak fix (#1076)

**Version / slug:** `socketmode-ws-leak-fix`
**Date:** `2026-06-12`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `reviewer subagent (connection-recovery path — see appended response)`

## Summary of the change

Fixes JKHeadley/instar#1076: `SocketModeClient` leaked one live websocket per deliberate `reconnect()` because the "temporarily clear `started`" save/restore was synchronous while websocket close events fire on a later tick — the stale close handler orphaned the replacement socket and double-reconnected. Two mechanisms replace it, both confined to `src/messaging/slack/SocketModeClient.ts`: (1) socket event handlers are closure-bound to their own socket and ignore events when that socket is no longer `this.ws`; (2) a connection `epoch` is bumped on every deliberate teardown (`disconnect()`, `reconnect()`, `_forceReconnect()`, `_handleDisconnect()`, all funneled through a new `_teardownSocket()`), and every in-flight async path (awaited `apps.connections.open`, sleeping `_backoffReconnect`, delayed `too_many_websockets` retry, post-failure MAX_BACKOFF retry) captures the epoch at start and stands down if superseded. Tests: new behavioral file `tests/unit/slack-socket-leak.test.ts` (proven failing first), pattern updates in `slack-socket-reconnect.test.ts` and `slack-socket-heartbeat.test.ts`. No decision-point (gate/sentinel/block-allow) surface is touched; this is transport-lifecycle correctness.

## Decision-point inventory

No decision points touched. The change gates no information flow, blocks no actions, filters no messages, and constrains no agent behavior — it manages the lifecycle of a transport connection. The nearest decision-shaped logic is "should this stale event trigger a reconnect?", which is connection bookkeeping, not agent-behavior authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The new guards drop two classes of events: (a) events from a socket that is no longer tracked, (b) scheduled reconnects whose epoch was superseded. Class (a) risk: a `message` event from a just-replaced socket carrying a real Slack envelope is now ignored instead of processed. This is correct, not over-block: processing it would ack on a dead/stale socket (the un-acked event is redelivered by Slack on the live connection — Slack's documented Socket Mode behavior, and the adapter already dedupes redelivered events). Class (b) risk: a superseded backoff stands down — by construction another path has already opened (or is opening) the connection, so dropping the duplicate dial is the fix itself. No legitimate input is rejected.

## 2. Under-block

**What failure modes does this still miss?**

- A socket that dies without EVER emitting close (silent TCP death) is unchanged — that's the existing heartbeat/liveness-probe path, untouched and still covering it.
- The SleepWake detector's spurious ~10s-gap wakes still trigger frequent (now harmless) redials and tunnel restarts — explicitly out of scope, tracked in JKHeadley/instar#1077. <!-- tracked: JKHeadley/instar#1077 -->
- If Slack's `apps.connections.open` itself returns errors indefinitely, behavior is the existing backoff loop (unchanged semantics, now epoch-guarded).

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The leak is intrinsic to the socket-lifecycle bookkeeping inside `SocketModeClient`; neither `SlackAdapter.reconnect()` (a one-line delegate) nor the SleepWake handler in `server.ts` can fix it — they cannot see which socket an event belongs to. Rate-limiting wake events at the server layer (#1077) is complementary, not a substitute: any caller may legitimately call `reconnect()` at any frequency and the client must stay leak-free.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic?**

Not applicable in the gate sense — the change is not a detector or an authority over agent behavior (see decision-point inventory). Reference reviewed: `docs/signal-vs-authority.md`. The identity/epoch guards are deterministic bookkeeping over objects the module itself owns, the category where plain code is the correct tool.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race with adjacent cleanup?**

- The previous behavior DOUBLE-FIRED `handlers.onDisconnected` for Slack-initiated disconnect envelopes (once from `_handleDisconnect`, once from the late close handler) — visible as duplicated `[slack] Disconnected:` log lines in the incident. The identity guard removes the duplicate; `SlackAdapter`'s `onDisconnected` only stamps `_lastDisconnectedAt` and logs. Honest coverage note (raised by the second-pass reviewer): client-initiated teardowns (`reconnect()`, `_forceReconnect()`) now fire ZERO `onDisconnected` where the old code accidentally fired one via the late close — so `_lastDisconnectedAt` is no longer stamped on those cycles and `_recoverMissedMessages` won't trigger for them. Accepted: the old stamp landed at teardown time (never covering the actual outage window, so the "recovery" it triggered re-read a window with nothing in it), the dominant disconnect paths (natural close, Slack envelopes) still stamp, and Slack redelivers un-acked envelopes on the new connection.
- `_startHeartbeat()` already self-clears before starting; with the open-handler guard a stale socket can no longer restart the heartbeat for an orphan. The heartbeat's `_forceReconnect` now funnels through `_teardownSocket` like every other teardown — one code path, no divergent cleanup to race.
- `connect()` on an already-connected client now tears down a pre-existing socket via the `_openConnection` invariant check instead of silently orphaning it (defensive; no current caller does this).

## 6. External surfaces

**Anything visible to other agents/users/systems? Timing/state dependencies?**

No API, config, message-format, or scaffold/template surface changes; no migration needed (pure `src/` behavior fix shipped by version update). Externally visible effect on Slack's side: the app stops accumulating phantom Socket Mode connections and stops hammering `apps.connections.open` — strictly closer to intended behavior. The fix inherently depends on event ordering (that's its subject); the test harness models the real ordering (close events fired manually on a later tick) rather than assuming benign timing.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Revert the single source file (+ tests) and release a patch — no data, state, config, or migration coupling. Worst plausible failure mode of the fix itself would be an ignored close event on a socket that IS current (impossible by construction: the guard compares against `this.ws`, and only `_teardownSocket`/the close handler itself clear it), with the existing heartbeat as the independent backstop that force-reconnects any non-OPEN tracked socket within 30s. Cheap, clean rollback.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (id a494a8c1260cacf70), 2026-06-12
**Verdict (verbatim):** "Concur with the review." — after walking every requested interleaving class (dual dials at the same epoch resolve via the `_openConnection` invariant teardown; the `reconnecting` flag cannot stick true since `_backoffReconnect` resets it unconditionally after the sleep and before the epoch check; the natural-close-while-sleeper-in-flight case is safe precisely because natural closes don't bump the epoch).

Observations (all non-blocking), and disposition:
1. Section 5's onDisconnected claim was correct as scoped but incomplete — client-initiated teardowns now fire zero `onDisconnected`, reducing `_recoverMissedMessages` trigger coverage on those cycles. **Disposition: section 5 reworded honestly (above); behavior accepted for the reasons stated there.**
2. Theoretical permanent-death strand via a defensive double-`connect()` with a failing API. **Disposition: hardened — `connect()` now tears down any pre-existing socket first (see `connect()` comment).**
3. The epoch deliberately not bumping on natural closes is load-bearing for liveness. **Disposition: documented with a comment in the close handler so a future "bump everywhere for symmetry" refactor can't introduce the permanent-death path.**
