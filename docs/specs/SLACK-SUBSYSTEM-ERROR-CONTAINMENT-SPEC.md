---
status: draft
parent-principle: "Structure beats Willpower — a single subsystem error must never be able to crash the whole server process. Contain failures at the subsystem boundary; never rely on every callsite remembering to guard a socket send."
tracked_deferrals:
  - "A serialized outbound socket writer (single-writer transport) is recorded as future hardening, tracked separately under dev topic 13481. It is NOT part of the uncaught-throw incident class this spec closes; see Non-goals."
eli16-overview: "SLACK-SUBSYSTEM-ERROR-CONTAINMENT-SPEC.eli16.md"
review-convergence: "2026-06-15T03:47:27.471Z"
review-iterations: 3
review-completed-at: "2026-06-15T03:47:27.471Z"
review-report: "docs/specs/reports/slack-subsystem-error-containment-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "operator (delegated) — decoupled instar-dev build brief / commitment CMT-1351, which pre-authorized Robustness Net #1 and pre-resolved the Goal 3 direction. Applied autonomously in the decoupled run and reported to Telegram topic 13481; not an interactive click."
approved-at: "2026-06-15T03:47:27.471Z"
---

# Slack Subsystem Error Containment (Robustness Net #1)

## Problem (root cause, grounded in code 2026-06-14)

On 2026-06-14 the server process crashed and the recovery nets were also down,
producing a ~2h outage. Robustness nets #2 (in-process ~10s respawn, PR #1164 /
v1.3.567) and #3 (OS launchd watchdog) are now live, so a crash now self-recovers
in seconds. Net #1 closes the remaining hole: **stop a Slack subsystem error from
crashing the whole process in the first place** (defense-in-depth, no longer
load-bearing, but real).

### Concrete failure mechanism (corrected against current code)

`src/messaging/slack/SocketModeClient.ts` calls `WebSocket.send()` from contexts
that are NOT exception-guarded. A `send()` on a socket that is not `OPEN`
(CONNECTING / CLOSING / CLOSED) throws **synchronously** (`InvalidStateError` /
`"WebSocket is not open: readyState N"` for the Node 22+ built-in, or
`"Sent before connected"` for the `ws` polyfill). These callsites run inside
WebSocket *event-listener* callbacks (`'open'`, `'message'`), which are not
awaited — a throw becomes an `uncaughtException` (sync path) **or an
`unhandledRejection`** (the `'message'` listener calls the `async`
`_handleRawMessage`, so an escaping throw there is a *rejection*, not a sync
exception). Either can take the whole process down.

**Current state of the four `.send(` callsites (read 2026-06-14, v1.3.567 — this
supersedes the seed analysis's stale line numbers):**

1. **`queueOutbound` (L113)** — `this.ws.send(data)`. Guarded by an
   `this.isConnected && this.ws` check, but **NO try/catch** → TOCTOU race: the
   socket can transition between the readyState check and the send. **Genuinely
   unguarded today.**
2. **ACK send (L236)** — `this.ws.send(JSON.stringify({ envelope_id }))`. **ALREADY
   guarded** (`readyState === OPEN` + `try/catch` logging `Ack send failed`). Fires
   on every inbound envelope.
3. **Heartbeat liveness probe (L321)** — `this.ws?.send('{"type":"ping"}')`.
   **ALREADY guarded** by `try/catch` → `_forceReconnect()` on throw.
4. **`_drainQueue` (L352)** — `this.ws.send(item.data)` in a `for` loop invoked
   from the `'open'` listener. Guarded by a readyState check at entry but **NO
   try/catch** → a throw mid-loop escapes the un-awaited `'open'` listener.
   **Genuinely unguarded today.**

So the genuinely-unguarded sends today are **`queueOutbound` and `_drainQueue`**.
Goal 1's `_safeSend` centralization is therefore primarily a **consistency +
regression-prevention** measure (one funnel, one policy, one wiring-integrity
ratchet), not an ACK rescue. Folding ALL FOUR through one funnel buys: (a) a single
reconnect-on-failure policy, (b) a grep/lint ratchet so a future callsite can't
regress, (c) one place that respects the epoch/teardown model.

### The surrounding concurrency model (#1076) — must not be disturbed

Every deliberate teardown bumps `this.epoch` and nulls `this.ws` *before* close;
stale socket events are identity-guarded (`this.ws !== sock`). `_safeSend` must
**read `this.ws` at call time** (never a captured/parameter socket), and never
resurrect a torn-down socket. Its reconnect trigger must reuse the existing
`_forceReconnect()` / `_backoffReconnect()` guards (`if (this.started &&
!this.reconnecting)`), not bypass them.

## Frontloaded Decisions

Every decision the build needs is resolved here (Autonomy Principle 2 — a single
autonomous run). The operator's build brief (commitment CMT-1351) carries the
authority; convergence *verifies* these, it does not re-decide them.

**FD-1 — Goal 3 shape: option (b), per-subsystem boundaries + the existing narrow
audited allowlist. No blanket uncaught-swallow.** `src/core/uncaughtExceptionPolicy.ts`
already implements exactly this; net #2 already restarts a truly-dead process in
~10s, so the global default stays **fail-toward-crash** (unknown error → crash).

**FD-2 — Add `process.on('unhandledRejection')`.** server.ts has none today, yet
the primary failure mode (`async _handleRawMessage` escaping a throw) surfaces as a
*rejection*, not a sync exception — the existing `uncaughtException` handler does
not catch it. The new handler routes through the **same** `isNonFatalUncaught`
predicate, the **same** `closeAllSqlite()` + `process.exit(1)` on anything
unrecognized, and the **same** first-seen-stack dedup. No second, looser allowlist;
no rejection-specific patterns. To keep the two handlers byte-identical in policy,
the shared decision is extracted into one function in `uncaughtExceptionPolicy.ts`
that both handlers call:

```ts
handleProcessLevelError(
  err: unknown,
  label: 'uncaughtException' | 'unhandledRejection',
  opts: { onFatalCleanup: () => void; exit?: (code: number) => never },
): 'recovered' | 'fatal'
```

The function **owns the entire sequence** so the two callsites cannot drift: on a
non-fatal match it logs `console.warn` (with the first-seen-stack dedup) and returns
`'recovered'`; otherwise it logs `console.error`, calls `opts.onFatalCleanup()`, then
`(opts.exit ?? process.exit)(1)` and returns `'fatal'`. Cleanup + exit are **injected
callbacks** (server.ts passes `() => { try { closeAllSqlite(); } catch {} }` and the
real `process.exit`) so `uncaughtExceptionPolicy.ts` stays pure decision-logic — it
does NOT statically import `SqliteRegistry` or call `process.exit` directly, which
also lets the unit test inject fakes and assert the fatal path triggers cleanup+exit
under BOTH labels. server.ts's existing `uncaughtException` handler is rewritten to
delegate to this same function (its current inline body becomes the function body),
so adding `unhandledRejection` cannot introduce a divergent policy.

**FD-3 — Backstop matching: add ONE anchored substring `'WebSocket is not open'`
to the allowlist; do NOT use a re-thrown custom-error marker.** Rationale (answers
the cross-model + internal marker advocates): `_safeSend` *swallows* contained
errors at the source — they never reach any process-level handler — so a structured
marker set inside `_safeSend` cannot help the backstop. The backstop allowlist only
ever sees errors that **escaped the funnel** (a future un-funneled `.send()`
regression, or a non-Slack caller); those did not pass through `_safeSend` and so
carry no marker. For *those*, an anchored message substring is the only available
primitive. The Node 22+ built-in `WebSocket` (the default runtime path; the `ws`
polyfill only loads on Node <22) throws `"WebSocket is not open: readyState N"`,
which the current `'Sent before connected'` entry does not match — so the deployed
case is uncovered. Adding the anchored `'WebSocket is not open'` closes it. The
match is **anchored, not the bare `'is not open'`** — that bare form collides with
live user-facing strings (`"<name> is not open for public registration"` in
TelegramAdapter/AuthGate, plus DB-closed messages) and would risk swallowing a
genuinely-fatal error. A negative unit test pins this. The real guarantee against
un-funneled regressions remains the `_safeSend` funnel + the grep ratchet, not the
substring.

**Scope of the allowlist entry (honest residual risk).** `'WebSocket is not open'`
is NOT Slack-scoped — it is a **transport-level** non-fatal class. The tree has
several WebSocket users besides Slack Socket Mode (Threadline relay/client,
`src/server/WebSocketManager.ts`, `SlackLifeline`), and a `send()` on a non-OPEN
socket is an isolated, self-healing transport condition for *every* one of them
(each owns its own reconnect; the dropped frame is best-effort). So swallowing this
class process-wide is correct, not a Slack-specific leak — continuing is safe for
all current WebSocket users. The residual risk is the generic brittle-substring one:
a future Node/`ws` version could change the message and silently disable the
backstop. Mitigations: (a) the funnel + ratchet, not the substring, is the primary
guarantee; (b) the allowlist entry carries a source comment citing the Node origin
of the message string as a maintainer breadcrumb; (c) the negative test guards the
anchor. If a new WebSocket subsystem ever needs a non-OPEN send to be *fatal*, that
is a new decision for that subsystem — not silently granted here.

**FD-4 — `_safeSend` per-callsite reconnect/failure policy (signature
`_safeSend(data: string, context: string, reconnectOnFailure = false): boolean`;
no per-call object allocation on the hot path):**

| Callsite | `reconnectOnFailure` | Behavior on `_safeSend` → false |
|----------|----------------------|---------------------------------|
| `queueOutbound` | `false` | **Enqueue** the item (fall through to the bounded queue) — closes the TOCTOU instead of dropping. |
| ACK send | `false` | Log + move on. Slack redelivers the unacked envelope. **No reconnect** (a failed ACK does not by itself prove the socket is dead, and the 30s heartbeat is the recovery bound; reconnecting per-ACK risks an epoch-churn storm). |
| Heartbeat liveness probe | `true` | The probe IS the liveness signal — a throw means the socket is dead → `_forceReconnect()`. On success, reset `lastEventAt`. |
| `_drainQueue` | `false` | **Break** the loop on first false, **retain** the failed item + remainder in `outboundQueue` for the next `'open'` drain. No reconnect from drain. **Mechanics (avoid mutate-during-iterate):** iterate by index `k` over a captured snapshot; on the first `_safeSend → false`, set `this.outboundQueue = snapshot.slice(k)` once (the unsent tail) and break; if the loop completes, `this.outboundQueue = []`. Remove-only, so length stays ≤ `MAX_OUTBOUND_QUEUE`. |

**FD-5 — `_safeSend` logging is flood-safe by construction.** The `readyState !==
OPEN` precheck branch (the *expected* transient state during reconnect) logs
**nothing** and never reconnects — it just returns false. Only the genuine
`catch` branch (check passed, `send()` threw — a rare race) logs `[slack-socket]
<context> send failed (readyState=N): <msg>`, message-only, never the payload.
Because a non-OPEN socket short-circuits at the no-log precheck, repeated sends
against a dead socket cannot flood; only the single OPEN→threw transition logs.

**FD-6 — Goal 2 is verify-and-test-only.** The synchronous boot boundary already
exists for Slack (server.ts try/catch around the Slack init incl
`await slackAdapter.start()`, sets `slackAdapter = undefined` on failure), and
likewise for WhatsApp and iMessage; `_openConnection` already routes dial errors to
`handlers.onError` without rejecting out. No new shared-boundary refactor ships in
this PR. We add an integration test asserting a Slack connect failure surfaces via
`onError` and server bootstrap continues / `/health` stays 200. The *async*
residual (throws in un-awaited post-boot listeners) is closed by Goal 1, not Goal 2.

**FD-7 — No new config flag; ships live (not dark).** The change has no happy-path
behavior surface to gate, and a flag would incur `migrateConfig` / template-awareness
obligations for negligible benefit. Reversibility is via release rollback (reaches
agents through `instar update`; nets #2/#3 keep them alive meanwhile). This keeps
the Migration Parity claim intact (pure `src/*.ts` + tests).

**FD-8 — E2E "feature is alive" seam (named so it cannot false-green).** A naive
boot-time test is a false-green: server.ts's existing boot try/catch already
contains a `start()` failure, so the regression under test (a throw from an
un-awaited *post-boot* listener) never fires during boot. The E2E instead proves
**process survival of a contained Slack error through the real process-level
guards**: a child process registers the real `uncaughtException` +
`unhandledRejection` handlers (via the shared `handleProcessLevelError` wiring),
emits both a contained error (`"WebSocket is not open: readyState 2"`) AND a
non-allowlisted control error, and asserts the process stays alive for the
contained one and exits 1 for the control. This exercises the genuine
escaped-to-process path, not the boot path.

## Goals

1. **No Slack socket send can throw uncaught.** Route every `.send()` in
   `SocketModeClient` through a single private
   `_safeSend(data, context, reconnectOnFailure = false)`. **Exact sequence (pins the
   identity re-check both reviewers flagged):**
   ```
   const sock = this.ws;                                   // read this.ws ONCE
   if (!sock || sock.readyState !== WebSocket.OPEN) return false;  // no log, no reconnect (FD-5)
   try {
     sock.send(data);                                      // send on the SAME captured local
     return true;
   } catch (err) {
     console.warn(`[slack-socket] ${context} send failed (readyState=${sock.readyState}): ${err.message}`);
     if (reconnectOnFailure && this.started && !this.reconnecting && this.ws === sock) {
       this._forceReconnect();                             // identity re-check: only reconnect the socket we sent on
     }
     return false;
   }
   ```
   `_safeSend` reads `this.ws` exactly once, sends on that captured `sock`, and in the
   catch reconnects **only if `this.ws === sock`** (the socket we sent on is still
   current) — so a throw after a teardown-and-replace cannot force-reconnect a fresh
   healthy socket. It never resurrects a torn-down socket (respects the epoch model).
   Replace the two unguarded callsites (`queueOutbound`, `_drainQueue`) AND fold in
   the two already-guarded ones (ACK, heartbeat probe) so all four share the funnel.
2. **Subsystem boundary at the adapter (verify-and-test-only — FD-6).** Confirm the
   existing adapter connect/reconnect boundary catches a throw during connection
   setup and surfaces it via `onError(err, permanent)` — never rejecting out of
   server bootstrap. Add an integration test; no refactor.
3. **Last-resort process guard (FD-1/FD-2/FD-3).** Keep option (b): per-subsystem
   boundaries + the existing narrow audited allowlist, fail-toward-crash by default.
   Add a `process.on('unhandledRejection')` handler that shares the exact same
   `isNonFatalUncaught` decision (via the extracted `handleProcessLevelError`).
   Broaden the allowlist by one anchored entry (`'WebSocket is not open'`) with a
   negative test guarding against over-broad matching.

## Non-goals

- Reworking Slack reconnect/backoff strategy (already hardened).
- **A single-writer socket-actor abstraction.** Routing all outbound frames through
  one serialized transport writer is the textbook way to eliminate socket-send
  TOCTOU by design (raised by both cross-model reviewers). **Scoping the claim
  precisely:** `_safeSend` + the wiring ratchet **fully closes the incident class
  this spec targets — "an uncaught/un-rejected socket send throw crashes the whole
  process."** It does NOT claim to eliminate the broader socket-concurrency space
  (frame ordering, ACK/send interleaving, lifecycle coupling); a serialized writer
  would address those, but they are a different, larger concern and are not what
  took the process down on 2026-06-14. The serialized-writer redesign is recorded as
  future hardening, tracked separately (see `tracked_deferrals`), and nothing in the
  *uncaught-throw* class is left unaddressed by building `_safeSend` now.
- Touching Telegram/WhatsApp adapters beyond the (already-present) boot boundary.
- Replacing nets #2/#3.

## Signal vs Authority compliance

`_safeSend` is a **pure signal-producer / self-heal at the subsystem boundary**: it
returns a boolean and (on the liveness path) triggers reconnect; it holds **no
cross-subsystem blocking authority**. It is a structural validator at a hard
invariant (a socket must be OPEN to send) — not a judgment call — so it does not
need to route to an LLM authority. The canonical fail-toward-crash **authority**
stays `uncaughtExceptionPolicy`, kept narrow and default-crash (FD-1). The
`unhandledRejection` handler reuses that same authority verbatim (FD-2) — it does
not introduce a second, divergent policy.

## Cross-Machine Coherence (multi-machine posture)

All three artifacts are **machine-local-by-design** — process-level / per-socket
resources with nothing to replicate or proxy:

- **`_safeSend` + reconnect** — the Slack WebSocket is a per-process resource; only
  the machine holding the live socket sends. A standby machine has `this.ws === null`
  and `_safeSend` correctly no-ops. (Which machine owns the socket is governed by the
  existing lease/standby model; `_safeSend` does not change it.)
- **`uncaughtException` / `unhandledRejection` handlers** — crash containment is
  inherently per-process. The allowlist already encodes the standby case
  (`'StateManager is read-only'`), and the new rejection handler consults the *same*
  authority, so lease/standby semantics stay identical across both handlers.

## Observability (no new masking surface)

Contained failures must leave an artifact, never silently mask a persistent fault
(Distrust Temporary Success). `_safeSend`'s `catch` branch logs `[slack-socket]`
with the readyState (FD-5). A *persistent* fault manifests through the existing,
already-visible machinery: `consecutiveErrors` grows on each `_backoffReconnect`,
the heartbeat logs `readyState != OPEN` every 30s and forces reconnect, and a
permanent dial failure routes to `onError`. No new always-on swallow is introduced
that could hide a real corruption — the global default remains crash (FD-1).

## Testing (all three tiers — Testing Integrity Standard)

- **Unit (`_safeSend`):**
  - OPEN → sends, returns true; CONNECTING / CLOSING / CLOSED → no-op, returns
    false, **no throw, no log**.
  - A `send()` that throws on an OPEN socket → swallowed + logged; with
    `reconnectOnFailure` → forces reconnect; without → does not.
  - Reproduce the L236 ACK race: ack while `readyState=CLOSING` → must not throw,
    must not reconnect (ACK path), event still processed.
  - Stale-socket: `this.ws` nulled between check and send → no send, no resurrection,
    no spurious reconnect.
  - N rapid non-OPEN sends → **at most one** in-flight `_forceReconnect` / epoch bump
    (storm guard).
  - `queueOutbound` while CONNECTING → **enqueues** (does not drop, does not
    reconnect).
  - `_drainQueue` where item k of n fails → items `1..k-1` sent, items `k..n`
    **retained** in `outboundQueue`, loop stops at k, no reconnect, queue length
    stays ≤ `MAX_OUTBOUND_QUEUE`.
- **Unit (process guard):** `handleProcessLevelError` log-and-continues for every
  allowlist member (including the new anchored `'WebSocket is not open'`) under both
  `uncaughtException` and `unhandledRejection` labels; crashes (cleanup + exit 1) for
  an unrecognized error; **negative** test: `"Foo is not open for public
  registration"` and a synthetic `"database is not open"` do **NOT** match
  `isNonFatalUncaught`.
- **Integration:** SlackAdapter connect failure surfaces via `onError`, server
  bootstrap continues, `/health` stays 200 (FD-6).
- **E2E (the "feature is alive" test):** the child-process survival test of FD-8 —
  contained `uncaughtException` + `unhandledRejection` keep the process alive; a
  non-allowlisted error exits 1.
- **Wiring-integrity ratchet (supplemental to the behavioral tests above, not the
  primary guarantee):** a unit test that reads `SocketModeClient.ts`, finds every raw
  socket send (`this.ws.send(`, `this.ws?.send(`, and any `<sock>.send(`), and asserts
  they appear **only inside the `_safeSend` method body** — so a future un-funneled
  callsite (in either `.send(` or `?.send(` form) fails the test. Also assert each of
  the four logical callsites references `_safeSend`, and that server.ts registers BOTH
  `uncaughtException` and `unhandledRejection` through the shared
  `handleProcessLevelError`. The real protection is behavioral (the `_safeSend` unit
  tests drive a fake WebSocket whose `send` throws and assert no throw escapes); the
  source-grep ratchet is a cheap regression tripwire layered on top, not a substitute.

## Migration parity

Pure source/runtime fix in shipped code — reaches existing agents via the normal
release/update path. No `.claude`/config/template migration needed (no config flag —
FD-7). If a future change adds a config flag, `migrateConfig()` must seed it for
existing agents.

## Rollback

Back-out = revert the commit + patch release (reaches agents via `instar update`;
nets #2/#3 keep them alive meanwhile). No config kill-switch — the change has no
happy-path surface to disable. The riskiest individual knob is the allowlist
broadening, which is independently revertable.

## Rollout

Ships live (not dark — FD-7) — containment hardening with no behavior change on the
happy path. The one failure-path behavior change (queueOutbound enqueues instead of
dropping on a lost TOCTOU; drain retains instead of discarding) is strictly more
correct. Verify on this agent post-release.

## Open questions

*(none)*
