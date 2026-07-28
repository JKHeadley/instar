# Code-grounding context for reviewers — Slack Subsystem Error Containment (Net #1)

This note captures the ACTUAL current state of the code (read 2026-06-14, base
`upstream/main` v1.3.567) so reviewers ground their review in reality, not the
seed spec's stale line numbers. The seed spec's root-cause analysis predates two
hardening commits already on main.

## Current state of `src/messaging/slack/SocketModeClient.ts` (357 lines)

Four `.send(` callsites exist today:

1. **`queueOutbound` (L113)** — `this.ws.send(data)`. Guarded by an
   `this.isConnected && this.ws` check, but **NO try/catch** → TOCTOU race: the
   socket can transition between the readyState check and the send.
2. **ACK send (L236)** — `this.ws.send(JSON.stringify({ envelope_id }))`. ALREADY
   guarded: `if (envelope.envelope_id && this.ws && this.ws.readyState === OPEN)`
   + `try/catch` that logs `[slack-socket] Ack send failed`. (Added by a prior
   fix referencing the "Sent before connected" FATAL.)
3. **Heartbeat liveness probe (L321)** — `this.ws?.send('{"type":"ping"}')`.
   ALREADY guarded by `try/catch` → `_forceReconnect()` on throw.
4. **`_drainQueue` (L352)** — `this.ws.send(item.data)` in a `for` loop, invoked
   from the `'open'` event listener. Guarded by a readyState check at L350 but
   **NO try/catch** → a throw mid-loop escapes the un-awaited `'open'` listener.

So vs. the seed spec: the ACK (seed "L193") and heartbeat are ALREADY guarded.
The genuinely-unguarded sends today are **`queueOutbound` and `_drainQueue`**.
Goal 1's `_safeSend` centralization remains fully valid — fold ALL FOUR through
one funnel for (a) consistency, (b) a wiring-integrity grep ratchet so a future
callsite can't regress, (c) a single reconnect-on-failure policy.

`epoch`-based teardown (#1076) is the surrounding concurrency model: every
deliberate teardown bumps `this.epoch` and nulls `this.ws` before close; stale
socket events are identity-guarded (`this.ws !== sock`). `_safeSend` must not
disturb this — it operates on `this.ws` at call time and never resurrects a
torn-down socket.

## Current state of the adapter boundary (Goal 2)

- `src/messaging/slack/SlackAdapter.ts` `start()` (L192) builds `SocketModeHandlers`
  with an `onError(err, permanent)` that logs (does not rethrow), then
  `await this.socketClient.connect()` under a 15s `Promise.race` timeout.
- `SocketModeClient._openConnection()` already catches its own dial errors and
  routes them to `handlers.onError(err, permanent)` — it does not reject out.
- In `src/commands/server.ts` the ENTIRE Slack init block — including
  `await slackAdapter.start()` (L6292) — is already wrapped in a `try/catch`
  (L5789–6427) that reports degradation (`degradationReporter.report`) and sets
  `slackAdapter = undefined`. WhatsApp (L5676) and iMessage (L6446) starts are
  likewise inside try/catch. So the **synchronous boot boundary already exists**.
- The real residual risk is the **async** path: throws inside un-awaited
  WebSocket event listeners AFTER boot — those bypass the boot try/catch. That is
  exactly what Goal 1's `_safeSend` funnel closes at the source.

## Current state of the process guard (Goal 3) — ALREADY EXISTS

`src/core/uncaughtExceptionPolicy.ts` already implements **option (b) + a narrow
audited allowlist** — the shape the seed spec leans toward:

- `NON_FATAL_UNCAUGHT_PATTERNS` is a tight substring allowlist; unknown errors
  crash (the safe default). It already includes `'Sent before connected'` for the
  Slack WS reconnect race, plus HTTP double-response races and the standby
  read-only-write case.
- `isNonFatalUncaught(err)` + `shouldLogStackForUncaught(err)` (first-seen-stack
  dedup, bounded to 200) are unit-testable on both sides.
- `src/commands/server.ts` L17204 `process.on('uncaughtException')` consults
  `isNonFatalUncaught`: log-and-continue for the allowlist, else
  `closeAllSqlite()` + `process.exit(1)`.

**Gaps to weigh in convergence:**
- There is **no `process.on('unhandledRejection')`** handler in server.ts (only
  `TelegramLifeline.ts` has one). An async throw in a `.then` chain (vs a sync
  listener) would currently be an unhandled rejection with no containment.
- The allowlist pattern `'Sent before connected'` is the **`ws` package**'s
  message. Node 22+ built-in `WebSocket` throws `DOMException`/`InvalidStateError`
  with a DIFFERENT message (e.g. `"WebSocket is not open: readyState N"`). A
  non-OPEN send under the built-in WebSocket would NOT match the allowlist.
  Because Goal 1's funnel catches these at the source, the backstop matters only
  for a future un-funneled regression — but broadening the allowlist (or, better,
  tagging contained errors with a structured marker the policy matches on instead
  of brittle message substrings) is a candidate, narrow, audited improvement.

## Signal-vs-authority note

`uncaughtExceptionPolicy` is the canonical "narrow allowlist, fail-toward-crash"
authority. `_safeSend` is a pure signal-producer/​self-heal at the subsystem
boundary (returns boolean, triggers reconnect) — it holds no cross-subsystem
blocking authority. The design must keep the global handler's default-crash
posture (do not broaden into a blanket swallow).
