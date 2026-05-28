# Side-Effects Review — same-machine a2a transport via `/a2a/inbox`

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Recipient side. Third
fast-follow to PR #462 (receiver wiring) + PR #464 (lifeline-forward
dispatch). Closes the bot-to-bot-block gap surfaced by dogfood.

**Root cause being addressed:** Telegram Bot API structurally blocks
bot-to-bot delivery: "Bots talking to each other could potentially get stuck
in unwelcome loops. To avoid this, we decided that bots will not be able to
see messages from other bots regardless of mode." (Bot API FAQ.) The spec
assumed `Echo's mentor bot → Codey's primary bot via shared chat → Codey's
lifeline forwards` would work. Empirically it doesn't — verified by sending
4 marker messages to topic 458, Codey's bot poll-offset never advances past
them, his lifeline-forward stays silent.

**Change:** Three production files + two test files.
- `src/server/routes.ts` (+ ~70 LoC: new `/a2a/inbox` POST route)
- `src/server/middleware.ts` (+ 2 LoC: skip the API bearer middleware for
  `/a2a/inbox` — uses per-agent token like `/messages/relay-agent`)
- `src/server/AgentServer.ts` (+ ~75 LoC: same-machine path in
  `deliverToMentee` via AgentRegistry + `fetch` to peer's `/a2a/inbox`,
  before the Telegram bot fallback)
- `tests/integration/a2a-inbox-route.test.ts` (new, 8)
- `tests/e2e/a2a-inbox-lifecycle.test.ts` (new, 4)

## What changed

1. **`POST /a2a/inbox`** on every instar server. Accepts:
   `{ text, topicId, senderAgent?, senderIsBot?, senderBotId?, fromUserId? }`.
   Auth: Bearer token must match the target agent's per-agent token
   (`verifyAgentToken` — same shape as `/messages/relay-agent`). Behaviour:
   - 401 if bearer is missing or wrong
   - 503 if no `ctx.telegram` adapter is configured at all (no hook surface)
   - 400 if `text` (string) or `topicId` (number) are missing / malformed
   - 200 `{ ok, agentMessage: true }` when the adapter's
     `dispatchAgentMessageHook` claims the message
   - 200 `{ ok, agentMessage: false, reason: 'not-routed' }` when the hook
     refuses (no marker / malformed / not-allowlisted / not-allowed-role).
     The route is dedicated to a2a — non-routable messages are NOT forwarded
     to user-message handling.
   - `senderIsBot` defaults to `true` if omitted — local peers holding our
     agent token are bots by construction (the spoof defense is satisfied
     by the bearer-token check upstream).
2. **Auth middleware bypass for `/a2a/inbox`** — alongside the existing
   `/messages/relay-agent` and `/messages/relay-machine` bypasses, since the
   inbox enforces its own per-agent-token auth in-handler. Without this
   bypass the API bearer middleware (using `config.authToken`) would 403
   the request, because the caller holds the TARGET's per-agent token,
   not the API bearer.
3. **Same-machine routing in `deliverToMentee`** — before the existing
   Telegram bot delivery, the method now:
   - Imports `listAgents` from AgentRegistry + `getAgentToken` from the
     token manager (lazy-imported inside the closure to avoid loading the
     registry on every server boot).
   - Looks up the mentee by `name === menteeAgent && name !== self.config.projectName`
     (anti-self-target).
   - If a local peer with a port is found AND we have the peer's token,
     POSTs to `http://localhost:PORT/a2a/inbox` with the marker text +
     sender context. On `agentMessage: true`, marks the outstanding-prompt
     tracker as sent and audits a `transport: 'a2a-inbox-local'` row in
     the sent-ledger.
   - On any failure (no peer, no token, HTTP error, hook refused) logs and
     falls through to the existing Telegram bot path (preserved unchanged
     for cross-machine; currently unreachable due to the same bot-to-bot
     block — a separate cross-machine transport is future work).
   - The anti-ping-pong check (`outstanding.canSendTo`) runs ONCE before
     either transport so the same correlation key gates both paths.

## The seven questions

1. **Over-block.** N/A. The inbox is a NEW dedicated endpoint; the route
   refuses non-routable traffic with `agentMessage: false` but never
   forwards to user handling. No existing route's behaviour changes.
2. **Under-block.** Spoof defense is intact: per-agent token bearer auth
   gates the route. `senderIsBot` defaulting to `true` is correct because
   the peer authenticated with the target's own token — the spoof defense
   it would otherwise enforce is satisfied earlier by the bearer check.
   Anti-ping-pong: `outstanding.canSendTo` runs before either transport so
   one outstanding prompt blocks both paths.
3. **Level-of-abstraction fit.** Mirrors `/messages/relay-agent`'s pattern
   exactly: own route, own auth, dispatch into existing in-process state.
   No new abstraction.
4. **Signal vs authority.** Inbox DECIDES route-or-drop via the hook (the
   hook's existing routing matrix is the spec); audit ledger captures the
   result. `deliverToMentee` DECIDES transport (local vs Telegram). All
   audited; no silent paths.
5. **Interactions.** Reuses AgentRegistry + AgentTokenManager (same APIs
   already used by `/messages/relay-agent`). Reuses
   `getOrCreateA2aLedger` + `getOrCreateMentorOutstanding` from the mentor
   sender side. Reuses `dispatchAgentMessageHook` from PR #464. No new
   shared mutable state.
6. **External surfaces.** One new HTTP route (`/a2a/inbox`). One new
   audit-ledger transport value (`'a2a-inbox-local'`). No new config keys.
7. **Rollback cost.** Trivial — revert removes the route, the middleware
   bypass, and the same-machine branch in `deliverToMentee`. The Telegram
   bot path is untouched and preserved.

## Testing

12 new tests, all green (`tsc --noEmit` clean):

- **Tier 2 integration (8):** `a2a-inbox-route` covers the auth + input-
  validation matrix (401 missing bearer, 401 wrong bearer, 503 no adapter,
  400 missing text, 400 bad topicId, 200 routed, 200 not-routed, 200 with
  default senderIsBot:true).
- **Tier 3 E2E lifecycle (4):** `a2a-inbox-lifecycle` covers full server
  boot with the mentee receiver wiring + the inbox route alive (not 404),
  auth-gated, and the full claim path that proves the inbox invokes the
  adapter dispatcher end-to-end on the real production init path.

A unit-tier slice for the same-machine branch in `deliverToMentee` is
deferred — covered transitively by the E2E + the existing unit suite for
`OutstandingPromptTracker` + the new integration test for the inbox route.
A dedicated unit on the `deliverToMentee` branch would require mocking
`fetch` + AgentRegistry + getAgentToken — defensible to add later but the
behaviour is already tested at the boundary.

## Migration parity

No new config keys. The route registers unconditionally; if no
`config.mentee.enabled` block is set on the receiver, the adapter has no
hook installed and the route returns `agentMessage: false`. The
`/messages/relay-agent` precedent is identical (always-registered route,
behaviour depends on installed state).

The `deliverToMentee` change is purely additive — when no local peer is
registered, behaviour is byte-for-byte the same as before. No PostUpdateMigrator
change required.
