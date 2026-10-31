# Side-Effects Review — Threadline MCP over local HTTP

**Version / slug:** `threadline-mcp-local-http`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Adds `POST /mcp/threadline`, served by the running agent server over MCP streamable HTTP on loopback, so a session can use the `threadline_*` tools without starting its own stdio helper process. New code: `src/threadline/ThreadlineMcpHttpService.ts` (local secret, admission, per-request tool server, caps, readiness probe, spawn plan, health block) and `src/core/threadlineMcpSpawn.ts` (URL, client entries, version floors, Codex shared-entry detection, deadlines). Wiring: `server.ts` (construct once with the server's live discovery/trust/resume objects), `AgentServer.ts` (route parser, middleware gate, boot probe), `middleware.ts` (exact-path secret rule first; 340 s timeout override for `/threadline/relay-send` and `/mcp/threadline`), `routes.ts` (route, `/health` block, relay-send close-cancellation), `SessionManager.ts` and `frameworkSessionLaunch.ts` (per-spawn transport plan on the four spawn sites), `mcp-http-client.ts` (explicit `originSessionName`, 325 s undici agent, outcome-unknown classification, shared relay discoverer), key-material/credential/state/write-domain registries, the CLAUDE.md template + migrator, and tests in all three tiers. Ships OFF (`threadline.mcpHttp.enabled`, default false). Tier 2 (a credential and a new route); 29 source/test files plus docs; spec converged in 6 rounds (prior session); this session: one rebase conflict pass, measurements, live checks, one second-pass review.

## Decision-point inventory

- Route admission on `/mcp/threadline` (local secret, loopback, no `Origin`, no forwarding headers) — add — deterministic invariant: a constant-time secret compare plus fixed refusals.
- Spawn-time transport choice (HTTP vs stdio) — add — flag off, readiness failed, stripped spawn, unverified client version ⇒ stdio, today's behaviour.
- In-flight caps (32 global / 24 waits / 4 per session) — add — fixed bounds, 429 + Retry-After.
- `/threadline/relay-send` request timeout (30 s → 340 s) and premature-close cancellation of the reply wait — modify — ships live; fixes waits that already 408'd.
- Existing outbound gates behind the tools — pass-through — every tool still calls the same loopback routes as the stdio helper.

---

## 1. Over-block

The route refuses: a request without the local secret (including one carrying only the agent token), a non-loopback peer, any `Origin`, any `Cf-Connecting-Ip`/`X-Forwarded-For`, JSON-RPC batches, and calls beyond the caps. A legitimate session is only affected by the caps (a fifth concurrent call from one session gets 429; the client may retry) and by a secret rotated by hand (sessions keep the old value until restarted; `ThreadlineMcpHttp.callFailure` reports it). A local reverse proxy that adds `X-Forwarded-For` to genuine local traffic would be refused; none exists in instar's own setup. When admission refuses, the session's spawn would already have chosen stdio unless the probe passed, so a broken route costs a fallback, not lost tools.

---

## 2. Under-block

Attribution stays self-asserted: `X-Instar-Session` is whatever the client sends, as `INSTAR_SESSION_NAME` is for the stdio helper today; the per-session cap is therefore a courtesy, the global cap is the real bound (tracked: feedback fb-a9c21fc7-1bd). A process on the same host that can read `.instar/state/local-mcp-secret` (mode 0600, same user) can call the route; it could equally read the agent token, which already grants more. The route does not stop a disconnected caller's message from being sent (deliberate: an abort cannot un-send).

---

## 3. Level-of-abstraction fit

The route is a transport adapter in front of the existing `ThreadlineMCPServer` tool handlers; the tools still call the server's own `/threadline/*` and `/messages/*` routes, so every gate and audit stays where it is. Admission sits in `authMiddleware`, the single auth chokepoint, as one exact-path rule, and is repeated in the handler because Express routing is case-insensitive. The transport choice lives in `SessionManager`'s existing spawn-flag assembly. No parallel gate is introduced.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Yes, with deterministic logic on an authentication boundary — not a brittle content detector.

The blocking surfaces are credential admission (constant-time secret compare, loopback, header refusals) and fixed numeric caps. These are authentication and capacity invariants, not judgments about content, which is the category the principle reserves for smart gates. The transport choice never blocks anything: every negative answer is today's stdio helper.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Admission is an enumerable invariant (has the secret, is loopback, carries no forwarding headers). The transport choice has one conservative answer (stdio) that is always correct; the HTTP answer is taken only when every precondition is verified. The caps are fixed Bounded Blast Radius bounds declared in the spec's Decision points section.

---

## 5. Interactions

- **Shadowing:** the exact-path rule runs first in `authMiddleware`, before the no-token skip and agent-id check, so it cannot be shadowed by them and does not shadow any other path (`req.path === '/mcp/threadline'` only; `/mcp/session/:topicId`, `/mcp/load`, `/mcp/offload` are unaffected, covered by the integration test).
- **Double-fire:** a Codex session whose shared `~/.codex` entry is not detected runs both the HTTP server (`threadline_local`) and the shared stdio helper: duplicate tools, both working, reported once as `codex-shared-entry-not-disabled`. Verified live that a quoted `[mcp_servers."threadline"]` table is detected.
- **Races:** one `AgentTrustManager` instance is shared with the relay (never a second writer to the trust file); with the relay off one instance is built at mount time and held. Capacity slots are released only when the response has closed AND every inner operation has settled. The readiness probe is cached and never awaited by a spawn.
- **Feedback loops:** the readiness probe calls the route itself under the reserved session name `__readiness-probe`, excluded from the per-session cap, first-call record and transport counts. A failing probe retries every 5 minutes; no loop.
- **Dynamic MCP:** when the per-topic strict config is in use, its `threadline` entry is replaced by the HTTP one (one writer, one `--mcp-config`).
- **Sibling work:** the native-hook-events builder touches the same files (SessionManager, routes, AgentServer, PostUpdateMigrator, types); this diff adds disjoint blocks and rebases cleanly onto either order.

---

## 6. External surfaces

- Other agents on the same machine: each agent has its own secret file and port; the route refuses non-loopback and a wrong secret.
- Install base: nothing changes while the flag is off, except (live, intended) the relay-send long-wait fix, `MCP_TOOL_TIMEOUT=360000` on claude-code spawns, `tool_timeout_sec=360` on Codex's stdio override, and the secret file created at first boot.
- External systems: none; loopback only.
- Persistent state: `.instar/state/local-mcp-secret` (key material: gitignored, excluded from backups/file viewer/git sync, never replicated), `.instar/state/session-mcp-config/threadline-http.json` (only a loopback URL and `${VAR}` references), and a `threadlineMcpTransport` field on session records.
- Timing: deadlines 300/320/325/340/360 s ordered so each layer answers before the next times out.
- Operator surface: one config flag, conversationally settable by the agent; read via the authenticated `/health`. No PIN-gated or approval action is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard, approval page or form is touched).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** A session reaches its own machine's server over loopback; serving it from another host is impossible by construction. The secret authorises only loopback calls on its own host, so replicating it would only widen where it can leak; each machine creates its own. The per-agent MCP config file is regenerated per machine from that machine's listen address. A topic moved to another machine is respawned there with that machine's URL. Health counts are per-machine observations on that machine's authenticated `/health`. No user-facing notices; no URLs leave the machine.

---

## Framework generality

The transport choice routes through the framework abstraction: `planSpawn` keys on the framework, and a per-framework verified-floor table (`VERIFIED_CLIENT_FLOORS`) decides which frameworks may get HTTP at all. claude-code (2.1.310) and codex-cli (0.156.1) are verified live, each with its own wiring (Claude: a non-strict `--mcp-config` entry named `threadline`; Codex: a `-c mcp_servers.threadline_local=...` entry plus a conditional disable of the shared stdio table, because Codex merges `-c` overrides into an existing table). gemini-cli, pi-cli, grok-build and any future framework have no floor entry, so they always get exactly today's stdio wiring (`framework-unsupported`, not counted as a fallback). The live long-wait additions are per-framework too: `MCP_TOOL_TIMEOUT` only on claude-code spawns, `tool_timeout_sec` only on Codex's existing stdio override. `frameworkSessionLaunch.ts` gains one optional field (`codexThreadlineHttpArgs`) that only the Codex builders read; other builders ignore it.

---

## 8. Rollback cost

Flag off (`threadline.mcpHttp.enabled: false`, read live per spawn) returns new sessions to stdio immediately; sessions already wired keep working because the route stays mounted, and get stdio when restarted. A code revert removes the route; HTTP-wired sessions then lose their tools until restarted (they get stdio). The secret file and config file are inert leftovers. The live long-wait fix reverts with the code; no data migration.

---

## Conclusion

The preserved implementation matched the converged spec; this session rebased it onto current main (two conflicts: the server.ts AgentServer options line and the stdio entry's relay discoverer, resolved by keeping main's Bearer header on `/threadline/status` inside the shared discoverer), extended the measurement script for macOS physical footprint and server-side growth, and ran the live checks. Measured: about 60 MB private / 96 MB RSS and 165 ms (up to 1.2 s under load) per stdio helper vs no process, server growth within GC noise, and 8–17 ms first reply on HTTP. Both real clients work over HTTP and recover after a server restart. The second-pass review found one real capacity leak and one mislabel, both fixed with tests. The two relay-send close-cancellation integration tests were failing on current main because `/threadline/relay-send` is now Bearer-gated (fb-829a7161-942) and the raw test fetches sent no token; fixed in the test. Clear to ship dark.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only, briefed with the code and the spec, not the conclusions)
**Independent read of the artifact: concur** (after one iteration)

First pass raised a concern: (1) a capacity slot leaked when the client was already gone before the handler ran (the one-shot `close` had fired, so the slot was never released); (2) a headless claude-code session could be labelled `http` when `-p` was missing and the `--mcp-config` was never inserted. Nits: naming the session `__readiness-probe` exempted any caller from the per-session cap; a failed client-version read was cached for the process life; the per-request server close called a `stop()` that does nothing for a never-started server. All five fixed: early-close guard releases the slot and returns before building a tool server (new integration test asserts the slot is freed and no tool handler runs); headless falls back to a stdio label (`mcp-config-not-inserted`); the probe exemption needs a per-process nonce header compared in constant time (new integration test); only a successful version read is cached (new unit test); the close uses `getServer().close()`. Re-check: concur. Left unchanged with reasons accepted by the reviewer: the triage lane's second (idempotent) binary resolution, the case-sensitive timeout-override match, and the relay-off trust manager (the only one built in the server process).

---

## Evidence pointers

- `docs/specs/reports/threadline-mcp-local-http-measurements.md` — numbers, method, live checks.
- `tests/unit/threadline-mcp-local-http.test.ts`, `tests/unit/session-manager-threadline-mcp-spawn.test.ts`, `tests/unit/PostUpdateMigrator-threadlineMcpHttp.test.ts`
- `tests/integration/threadline/threadline-mcp-http-route.test.ts`, `tests/integration/threadline/threadline-relay-send-long-wait.test.ts`
- `tests/e2e/threadline-mcp-http-alive.test.ts`
