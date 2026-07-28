# Side-effects review — dynamic-MCP routes + AgentServer wiring (live-authority)

**Change:** Make the dynamic-MCP feature reachable. Three edits:
- `src/server/routes.ts` — `RouteContext.dynamicMcpService?` field + three routes:
  `GET /mcp/session/:topicId`, `POST /mcp/load`, `POST /mcp/offload`. Bearer-gated
  (global middleware); 503 when the service is absent/disabled (dark by default).
- `src/server/AgentServer.ts` — build `DynamicMcpService` with the host's REAL
  primitives (restart→SessionRefresh via `getSessionForTopic`, isPreapproved→
  `activeAutonomousJobs`) and thread it into `routeCtx`. Construction is fail-safe
  (a throw ⇒ null ⇒ routes 503).
- Integration test (9 cases) over the real createRoutes pipeline.

## 1. Blast radius
Reachable but DARK by default: every `/mcp/*` route 503s unless
`sessions.dynamicMcp.enabled === true` (explicit flag, not the dev-gate yet). The
service construction is wrapped in try/catch → null on any error, so a wiring fault
can NEVER break server boot — it just disables the feature. When dark, `routeCtx`
gains one extra (unused) field; nothing else changes.

## 2. Reversibility
Fully reversible — remove the field/routes/construction. No migration; the on-disk
state the service would write only happens when an enabled change is requested.

## 3. State / data touched
None unless enabled + a change is requested (then McpLoadedSetStore writes under
`.instar/state/mcp-loaded/`). Reads `.mcp.json`. Never mutates `.mcp.json`.

## 4. Failure modes
Service construction fail-safe (→ null → 503). The restart primitive maps a null
SessionRefresh / unbound session to `not_telegram_bound` ⇒ `unsupported-unbound`
(no crash). isPreapproved fails CLOSED on any error. v1 OFFLOAD is conservatively
inert (isMidToolUse ⇒ null ⇒ the driver aborts every offload; captureHeavyPids ⇒ [])
so there is NO leak and NO bad restart until the paneTail probe + reaper pid-capture
land in a follow-up.

## 5. Security / authority — THE load-bearing review
The agent-facing routes are Bearer-gated and ALWAYS act as `{kind:'agent'}` — they
NEVER honor a caller-supplied `nonce` from the request body. This is the C4 fix made
concrete: the agent RECEIVES the nonce in a needs-approval response, so if the route
honored a body nonce the agent could self-approve over the shared Bearer. An
integration test asserts that a body `nonce` does NOT authorize a not-preapproved
change. The only paths that complete a change are (a) a live-preapproved topic
(active autonomous run — the operator's own standing grant) or (b) — FOLLOW-UP — an
operator-authenticated approval route (dashboard PIN / sentinel-bound yes) that
consumes the server-minted nonce. Until that route lands, a non-preapproved change
returns needs-approval and performs no restart. No authority can be self-granted.

## 6. Framework generality
The routes/service are framework-neutral; the Claude-Code-specific surface is the
restart primitive (SessionRefresh, which returns not_telegram_bound for sessions it
can't restart ⇒ unsupported-unbound). The baseline-trim that the restart re-applies
is already claude-code-scoped in buildSessionMcpFlags (prior commit). codex-cli /
gemini-cli sessions are not trimmed and a restart of them carries no mcpFlags.

## 7. Tests
9 integration tests (`dynamic-mcp-routes.test.ts`): 503 absent / 503 disabled / GET
state shape / GET 400 / POST load applied + restart / POST load needs-approval (202,
no restart) / C4 body-nonce-rejected / POST 400 missing server / offload conservative
409 abort. Plus the ~105 unit tests for the underlying blocks. tsc clean.
