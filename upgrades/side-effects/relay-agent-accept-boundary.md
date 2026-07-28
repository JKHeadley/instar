# Side-Effects Review — relay-agent accept-boundary (duplicate-reply root)

**Version / slug:** `relay-agent-accept-boundary`
**Date:** 2026-05-30
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** REQUIRED (inbound agent-to-agent messaging path) — verdict appended below

## Summary of the change

`POST /messages/relay-agent` (`src/server/routes.ts`) now responds at the accept
boundary — `{ ok:true, accepted:true, threadline:{accepted:true, async:true} }`
— instead of awaiting `handleInboundMessage` (a 9-30 s session spawn) before
responding. The spawn runs in the background (`void` + logged `.then`/`.catch`).
This removes the duplicate-reply ROOT: the co-located sender
(`MessageRouter.relay`) uses `AbortSignal.timeout(5000)` and reads only
`response.ok`, so awaiting the spawn past 5 s made it retry with a fresh id →
duplicate spawn. Scoped to the co-located path only; the relay-funnel path is
tracked separately.

## Decision-point inventory

- No decision is added or changed. The accept decision (`relay`) and the
  warrants-reply gate already ran upstream and are unchanged. This only moves
  WHEN the HTTP response is sent relative to the background spawn —
  modify (pass-through of the decision, not a new decision).

---

## 1. Over-block
No block/allow surface added. The change responds *sooner*; it rejects nothing
it didn't reject before (auth, envelope-validation, dedup, and the
warrants-reply suppress path are all unchanged and still run before the
response).

## 2. Under-block
The warrants-reply gate's suppress→short-circuit is preserved and still runs
synchronously before the spawn, so a no-reply verdict still prevents the spawn.
The only thing no longer surfaced synchronously is the spawn OUTCOME
(spawned/handled/error) — which no caller reads (see §5/§6); it is logged.

## 3. Level-of-abstraction fit
Correct layer — the fix is at the HTTP handler that owns the request/response
lifecycle for this path. The decision of WHAT to do (accept, gate, spawn) is
unchanged; only the response timing within the handler moves.

## 4. Signal vs authority compliance
Compliant. No authority added. The handler already held the accept + gate
authority upstream; the change carries no new gate and fails safe (a background
error is logged, never surfaced as a 500 on an already-sent response).

## 5. Interactions
- **Sender (`MessageRouter.relay`, src/messaging/MessageRouter.ts:494-505):**
  reads ONLY `response.ok` within a 5 s `AbortSignal.timeout` — verified. The
  accept-boundary gives it a fast `ok` and never the spawn fields it never
  read.
- **Reply-waiter mechanism:** resolved synchronously BEFORE the response
  (unchanged) — the actual reply path is decoupled from this response. Tests
  for waiter-by-threadId stay green.
- **Content-hash dedup (#573):** runs before the response, unchanged; remains
  the backstop for any retry that still slips through.
- **Keystone gate-before-spawn:** the warrants-reply gate still runs before the
  (now async) spawn; the wiring test asserting that ordering stays green (made
  formatting-robust).
- **No double-fire:** the spawn runs exactly once per accepted message, just
  asynchronously.

## 6. External surfaces
- The `/messages/relay-agent` response body changes from `{ok, threadline:
  <spawnResult>}` to `{ok, accepted, threadline:{accepted, async}}`. Audited
  consumers:
  - `MessageRouter.relayToAgent` (`src/messaging/MessageRouter.ts:486-510`) —
    reads ONLY `response.ok` within `AbortSignal.timeout(5000)`. Fully satisfied
    by the fast `ok`; never read the spawn fields. No behavior change.
  - **`/threadline/relay-send` local fast-path** (`src/server/routes.ts:13824-
    13835`) — the SENDER side of this same co-located hop reads
    `threadline.{injected,spawned,resumed,gateDecision,error,handled}` to build
    an informational `deliveryOutcome` string (logged + returned to the calling
    agent's `threadline_send` MCP result via `mcp-http-client` →
    `ThreadlineMCPServer:575`). With the accept-boundary those fields are
    `undefined`, so `outcome` falls through to the existing default `'accepted'`
    (previously e.g. `'spawned new session'`/`'resumed existing thread'`). This
    is a **cosmetic/observability degradation only**: `delivered` is computed as
    `!outcome.startsWith('error')`, and `'accepted'` is not an error, so
    `delivered` stays `true` exactly as before; `outcome` gates no retry, no
    delivery, no reply-wait. `'accepted'` is also the HONEST value — the local
    send IS accepted and processing async. (Found by the Phase-5 reviewer; the
    original draft of this section wrongly claimed `MessageRouter.relay` was the
    only consumer.)
- The change is invisible to the sender's actual behavior (fast ack) and to the
  user (the real reply still arrives via the session, just without a 30 s sender
  hang and without the occasional duplicate).
- No new route, no new message.

## 7. Rollback cost
Trivial — revert the one handler block (re-await + return the result) and the
test rewrite. No data, no migration. The content-hash dedup stays as the
symptom backstop regardless.

---

## Phase 5 — Second-pass reviewer verdict

An independent reviewer subagent adversarially audited the artifact AND the
actual handler code (not just the claims), and **raised one concern — now
addressed**:

- **Concern (artifact overstatement, not a code bug):** §6's original draft
  claimed `MessageRouter.relay` + the test suite were the only consumers. The
  reviewer found a SECOND consumer — the `/threadline/relay-send` local
  fast-path (`routes.ts:13824-13835`) reads the spawn-outcome fields to compute
  an informational `deliveryOutcome`. **Resolution:** §6 corrected above to name
  this consumer and document that it degrades gracefully to the existing
  `'accepted'` outcome — `delivered` stays `true` (`'accepted'` is not an
  error), no retry/delivery/correctness impact. The CODE is safe to ship as-is;
  only the artifact's honesty needed the fix.

- **What the reviewer verified as correct (the core change is sound):** handler
  ordering preserved — dedup, reply-waiter resolution, and the warrants-reply
  gate's `suppress`→short-circuit all still run synchronously BEFORE the
  response; `handleInboundMessage` is called exactly once (never dropped), its
  rejection caught (can't 500 an already-sent response); the reply-waiter path
  is decoupled and unbroken; the sole co-located sender reads only `response.ok`
  within the 5 s timeout, so the accept-boundary genuinely removes the
  duplicate-reply root; no test breaks; the rewritten test asserts the right
  things (returns before `router-end`, no spawn fields, background completion,
  error → still 200).

Verdict after the §6 correction: concern resolved; change is correct and safe.
