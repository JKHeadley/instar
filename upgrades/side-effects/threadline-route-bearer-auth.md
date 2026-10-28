# Side-Effects Review — `/threadline/*` is no longer a public prefix (fb-829a7161-942)

**Version / slug:** `threadline-route-bearer-auth`
**Date:** `2026-10-27`
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** independent reviewer subagent (required: this is an auth gate on inbound/outbound messaging — see §Second-pass review)

**Tier declared:** 1 (small, fully revertible), declared BELOW the risk floor the gate will signal (auth path). Reasoning: the change is ~50 lines in the bearer middleware plus a token resolver in the stdio helper; a revert restores the previous behaviour exactly with no data, state, or migration left behind; and the operator directed this fix as a complete PR tonight in a non-interactive session where a converged + approved spec cannot be obtained. The below-floor declaration is the audited record of that call. Size: 5 runtime source files (1 new), 4 new test files, 2 existing tests updated; ~140 LOC runtime. Effort: 0 spec rounds, 1 second-pass round (one concern, resolved below), 1 commit attempt expected.

## Summary of the change

`authMiddleware` (src/server/middleware.ts) exempted every path starting with `/threadline/` from the bearer check, on the comment "Threadline protocol endpoints use their own auth". That was true for the peer-protocol routes and false for the agent's OWN control surface under the same prefix: `POST /threadline/relay-send` had no token, loopback or tunnel-header check on its ordinary path, so an unauthenticated POST over the public tunnel reached its field validation (verified 2026-10-27, HTTP 400 "Missing required fields"). The same prefix also exposed relay-discover, hub/bind, telegram-bridge/config (GET+PATCH), observability reads, conversations and status, plus the thread/negotiator/pairing/peer-health reads that happened to carry their own inline bearer checks (those were already safe; the rest were not).

The change replaces the prefix exemption with `THREADLINE_PUBLIC_ROUTES`, an exported exact `(method, path)` allowlist of the six peer-protocol routes (`GET /threadline/health`, `POST …/handshake/hello`, `POST …/handshake/confirm`, `POST …/messages/receive`, `POST …/threads/backfill`, `POST …/secrets/request`) plus the anchored `GET /threadline/blobs/:id` shape. Every other `/threadline/*` route falls through to the ordinary bearer + agent-id check. Callers were audited (table below); the two gaps found were in the stdio MCP helper and are closed here: its `/threadline/status` read now sends the bearer, and `resolveMcpAuthToken` (new `src/threadline/mcpAuthToken.ts`) adds the encrypted vault as a third token source after env and plaintext config, so a hand-started Codex on a secret-externalized install still holds a real token instead of having worked only through the hole. The job-template auth lint now mirrors the exact list, and the one e2e test that had enshrined the old "bearer-exempt by design" assumption for `/threadline/peers/health` now asserts the new posture.

**Audit of every bearer-exempt `/threadline/*` route (38 registrations):**

| Route | Classification | Own auth in handler | After this change |
|---|---|---|---|
| GET /threadline/health | public: peer discovery card | none (read-only identity card; AgentDiscovery, relayForward, localEnvelopeSignature, console read it) | public, exact |
| POST /threadline/handshake/hello, /confirm | public: Ed25519 handshake | handshake manager | public, exact |
| POST /threadline/messages/receive | peer send-in | `threadlineAuth` (Threadline-Relay token + signature + nonce + timestamp) | public, exact |
| POST /threadline/threads/backfill | peer read | `threadlineAuth` | public, exact |
| GET /threadline/blobs/:id | peer read (placeholder 404) | `threadlineAuth` | public, anchored one-segment |
| POST /threadline/secrets/request | self-mint | loopback-only + rejects X-Forwarded-For (sealed-handoff keystone; stdio helper deliberately sends no bearer) | public, exact |
| POST /threadline/relay-send | **state-changing: sends as the agent** | NONE on ordinary path (mesh forward secret only selects the forwarded branch) | bearer required |
| POST /threadline/relay-discover | reads the relay as the agent | NONE | bearer required |
| GET /threadline/status | own read (fingerprint, relay URL, listener state, config flags) | NONE | bearer required |
| POST /threadline/hub/bind | **state-changing: creates/binds Telegram topics** | NONE | bearer required |
| GET+PATCH /threadline/telegram-bridge/config | **state-changing config** | NONE | bearer required |
| GET /threadline/observability/threads, /threads/:id, /search | own private reads (message bodies) | NONE | bearer required |
| GET /threadline/conversations | own private read | NONE | bearer required |
| GET /threadline/peers/health, /peers/:fp/health | own read | bearer only for `?scope=pool` | bearer required |
| GET /threadline/negotiator | own read | inline bearer | bearer required (now redundant, kept) |
| GET /threadline/threads/:id, /:id/health | own read | inline `ownerAuthed` | bearer required (now redundant, kept) |
| all /threadline/pairing/* (14 routes) | own control + PIN steps | inline `pairingRouteAuthorized` (+ PIN where the operator acts) | bearer required (now redundant, kept) |

**Callers of the newly gated routes, and whether they already send the bearer:**

| Caller | Routes | Sends bearer today? |
|---|---|---|
| stdio MCP helper `mcp-http-client.ts` (relay-send, pairing start/invites) | relay-send, pairing | yes (`INSTAR_AUTH_TOKEN` env from the session, else config) |
| stdio `mcp-stdio-entry.ts` discoverer | relay-discover, status | relay-discover yes; **status read did not → fixed** |
| stdio helper on a vault-externalized install started by hand (`instar codex connect`) | all | **no token available → fixed (vault fallback)** |
| mesh forwarder `relayForward.ts` (standby → holder) | relay-send | yes (bearer + boot-secret header) |
| dashboard `pairing.js`, console `agents.js`/`inside.js`/`mandates.js` | pairing, invites, peers/health, conversations, observability, threads, hub/bind, health | yes (`bearer()` after PIN unlock) |
| pool-scope reads from peer machines (`readReaperPoolPeers`) | peers/health, pairing | yes (`ctx.config.authToken`, same as every other pool read) |
| other local agents / peers | health, handshake, messages/receive, backfill | n/a — stay public |
| scaffold CLAUDE.md template (`generateClaudeMd`) | `/threadline/peers/health`, `/threadline/peers/<fp>/health` | **NO — three illustrative curls at templates.ts:2095/2096/2106 were token-less (found by the second pass) → fixed: the template now carries `$AUTH`; `migrateClaudeMd` rewrites the exact bare forms in existing agents' CLAUDE.md (Migration Parity); the auth lint now scans the generated CLAUDE.md for token-less curls to any non-public threadline route so this cannot recur** |
| job templates, hooks, scripts (`src/scaffold/templates/jobs`, `src/data`, `src/templates`) | none hit a gated threadline route | n/a |
| existing e2e tests with a real server (`a2a-*-alive`, `pairing-v2-production-path-alive`, negotiator, peer-health, peer-dark) | relay-send, pairing, peers, negotiator | yes, except one assertion in `a2a-peer-health-alive` that asserted the hole → updated |
| `omitAuthEnv` confined sessions (feedback executor) | none — confinement loads no MCP servers | n/a |

Files: `src/server/middleware.ts`, `src/threadline/mcp-stdio-entry.ts`, `src/threadline/mcpAuthToken.ts` (new), `src/threadline/mcp-http-client.ts` (comment only), `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, `tests/unit/job-template-auth-lint.test.ts`, `tests/e2e/a2a-peer-health-alive.test.ts`, `tests/unit/auth-middleware-threadline-exact-routes.test.ts` (new), `tests/unit/threadline-mcp-auth-token.test.ts` (new), `tests/unit/PostUpdateMigrator-threadlineBearerCurls.test.ts` (new), `tests/integration/threadline/relay-send-bearer-required.test.ts` (new), `docs/specs/threadline-route-bearer-auth.eli16.md`, `upgrades/next/threadline-route-bearer-auth.md`, this artifact.

## Decision-point inventory

- `authMiddleware` threadline exemption (src/server/middleware.ts) — **modify** — a prefix pass-through becomes an exact-route allowlist; the decision "does this request carry the agent's token?" now applies to the agent's own Threadline control routes.
- `resolveMcpAuthToken` (src/threadline/mcpAuthToken.ts) — **add** — chooses WHICH source supplies the stdio helper's bearer (env → config → vault); it decides nothing about requests, only where a token comes from.
- Job-template auth lint `isPublic` — **modify** — a CI signal; no runtime authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Audited above; none found that remain. The specific shapes considered:

- A second instar agent on the same machine probing me: it uses `GET /threadline/health` and the handshake routes, which stay public. It never calls my relay-send (it calls its own).
- A peer delivering a message locally: `POST /threadline/messages/receive` stays public (and keeps its Threadline-Relay auth).
- My standby machine forwarding a send to the relay holder: the forward travels over the signed mesh RPC, and the HOLDER's own mesh handler then calls its OWN loopback `/threadline/relay-send` with its OWN `config.authToken` plus the boot-secret header (relayForward.ts:364, server.ts:25337-25338). No token crosses machines, so divergent per-machine tokens cannot make this 401 (the first draft of this review worried about that; the second pass showed the worry was unfounded).
- The stdio helper in an install whose config carries `{ secret: true }` and whose session env lacks the token: previously its calls only worked because of the hole; now it reads the vault. If the vault is file-keyed or keychain-keyed and readable by the same OS user (it is: `secret-get.mjs` does exactly this from the agent home), it gets the token. A locked vault yields '' and an honest 401 — which is the correct refusal (no token, no send), not an over-block.
- The sealed-handoff self-mint route (`/threadline/secrets/request`) stays bearer-free on loopback, as its own test requires.
- Exact-path matching rejects `/threadline/health/` (trailing slash). Express's `req.path` preserves a trailing slash, so a probe written as `/threadline/health/` would 401. No caller in the tree uses a trailing slash on these routes (grep confirmed). Accepted: a loosened match is how prefix holes start.

---

## 2. Under-block

**What failure modes does this still miss?**

- The bearer token is the ONLY credential: anyone who holds it (every spawned session, the dashboard after PIN unlock, a peer machine in the pool) can still send as the agent. That is the existing authority model for the whole API; this change restores it for Threadline, it does not strengthen it.
- The six public routes rely on their handlers' own auth. `GET /threadline/health` and the handshake routes are intentionally unauthenticated (discovery); they disclose the public identity card, which is by design. `/threadline/secrets/request` remains loopback-only + no-X-Forwarded-For; it does not check `Cf-Connecting-Ip`, but the tunnel sets `X-Forwarded-For`, so a tunnel request is still refused there.
- No `authToken` configured → the middleware is open for every route, as before. Not changed here.
- The inline bearer checks that already existed (pairing, negotiator, threads) remain; they are now redundant with the middleware but harmless, and they protect those routes in test harnesses that mount routes without the middleware.

---

## 3. Level-of-abstraction fit

The bearer gate is the right layer: it is the single funnel every route passes, and the defect was precisely a hole in that funnel. The alternative — adding an inline bearer check inside `relay-send` (as negotiator and pairing did) — would fix one route and leave the pattern that produced the hole (a prefix exemption) in place for the next route added under `/threadline/`. The exact allowlist makes "public" an explicit, per-route, reviewed decision. The allowlist is exported so the template lint consumes the same list instead of a parallel copy that can drift (the lint's own drift guard still checks each entry exists in middleware.ts).

The token resolver belongs in the stdio helper's process, not the server: it is the only caller that runs outside the server's process and must find the token on its own. It reuses `SecretStore` (the same primitive `secret-get.mjs` uses) rather than re-implementing vault reads.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is an exact, enumerable invariant (credential equality), not a brittle content detector.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The principle targets content-based decisions where a low-context matcher cannot tell legitimate input from the failure mode. A bearer check is not that: the domain is fully enumerable (the request either carries the configured token or it does not; the route is either on the explicit public list or it is not), it reads no conversation, and there is no "legitimate input" that looks like the failure. The pre-existing authority for "may this request use the API?" IS this middleware; the change removes an exemption from it rather than adding a parallel blocker.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Does the request hold the token?" has no competing live signals; it is an invariant (a safety floor on who may act as the agent), deterministic by design.

---

## 5. Interactions

- **Shadowing:** the middleware now runs BEFORE the inline `pairingRouteAuthorized` / `ownerAuthed` / negotiator bearer checks and the pool-scope `poolScopeAuthorized`. All compare the same token, so a request that passes the middleware passes them; a request that fails the middleware gets 401 from the middleware instead of the handler's 401/403 — the integration test pins the new response. `checkMandatePin` (PIN) steps are unaffected: they run after the bearer, as the pairing routes already required ("without this an unauthenticated caller could burn the operator's per-IP PIN lockout").
- **Agent-id binding:** the middleware's `X-Instar-AgentId` check now applies to these routes. A header that is ABSENT is accepted (deprecation-window behaviour, logged at most hourly); a MISMATCHED header is refused. The dashboard and the stdio helper send no agent-id header on these calls → accepted. Pool reads send the bearer without the header → accepted.
- **Double-fire:** none. The relay-send route's forwarded branch keys on the boot-secret header, which the middleware ignores; the forwarder already sends the bearer.
- **Races:** none; no shared state.
- **Feedback loops:** the stdio helper logs ONE stderr line when it finds no token; it does not retry or escalate.
- **Lint drift guard:** `job-template-auth-lint` asserts every public path still appears in middleware.ts; the exact strings do.

---

## 6. External surfaces

- **Other agents on the same machine:** unaffected — they use only the public routes.
- **Other users of the install base:** a caller that was relying on the hole (a script curling `/threadline/relay-send` with no token) now gets 401. The shipped CLAUDE.md template DID contain three such curls (`/threadline/peers/health` examples) — fixed in the template, rewritten in existing agents' CLAUDE.md by `migrateClaudeMd`, and guarded by the extended auth lint. No job template, hook or skill does this (audited). A `HEAD /threadline/health` now 401s (only GET is public); no caller sends HEAD.
- **External systems:** the Cloudflare tunnel exposes the same server; after this change a tunnel request without the token gets 401 on the Threadline control routes, matching every other route.
- **Persistent state:** the resolver itself writes nothing, never repairs or rotates, and never returns the `{ secret: true }` placeholder. One pre-existing behaviour of the primitive it reuses must be stated (second-pass finding): `SecretStore.get()` → `read()` → `MasterKeyManager.getCandidateKeys()` can GENERATE AND PERSIST a fresh file master key when a vault file exists but no key resolves (SecretStore.ts:298-325) — the same thing `.instar/scripts/secret-get.mjs authToken` does today, and the seed of the 2026-06-05 key-bifurcation incident. The stdio helper only reaches that path on a secret-externalized install with no session env and no keychain session (a hand-started Codex); on a session-spawned helper the env token short-circuits before the vault is touched. Not new, not widened, but no longer invisible.
- **Timing / runtime:** none.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action is added or changed; the dashboard's pairing/console surfaces already carry the bearer.

---

## 6b. Operator-surface quality

No operator surface is touched (no `dashboard/*` file changes) — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, with one pool interaction verified.** The bearer check runs on the machine receiving the request and compares against that machine's configured token; that is the same posture as the whole API gate. The one cross-machine path that reaches a newly gated route is the A2A relay-forward (standby → relay holder → `POST /threadline/relay-send` on the holder, loopback on the holder's side via mesh RPC); the forwarder already sends the bearer, and pool-scope reads of `/threadline/peers/health` and `/threadline/pairing` already send it. No user-facing notices are emitted, no durable state is held (nothing to strand on topic transfer), no URLs are generated. The stdio token resolver reads THIS machine's vault — correct, since each machine holds its own token.

---

## 8. Rollback cost

- **Hot-fix release:** revert the single commit; the prefix exemption returns and every caller keeps working (every legitimate caller sends the token either way). Ship as the next patch.
- **Data migration:** none; nothing persisted.
- **Agent state repair:** none; no installed files change, no migration added. The stdio helper is launched from the installed package and picks up either direction with the update.
- **User visibility:** none during rollback; the only visible effect of the fix itself is that unauthenticated callers (which should not exist) get 401.

---

## Conclusion

The review confirmed the defect is a prefix exemption in the one funnel every route passes, found two legitimate callers that only worked through the hole (the stdio helper's status read, and the stdio helper on a vault-externalized install started by hand), and closed both in the same change rather than leaving them to break on deploy. The independent second pass found a third: the CLAUDE.md template's three token-less delivery-health curls, which would have had every new agent reporting a broken route — closed with the template fix, a Migration-Parity rewrite for existing agents, and a template-scoped auth lint so the class cannot recur. Design changed during review: the first draft gated by path only; it now gates by `(method, path)` so a POST to the discovery card is not public either, and the list is exported so the template lint cannot drift from it. One pre-existing pool assumption is noted (paired machines share the bearer for forwards and pool reads) — unchanged by this PR, surfaced for the second pass. Clear to ship once the second pass concurs.

---

## Second-pass review (required — auth gate on messaging)

**Reviewer:** independent reviewer subagent (claude, fresh context, 2026-10-27)
**Independent read of the artifact: concern**

- **Public set — correct, nothing extra left open.** Each stays-public route is one that OTHER agents (no bearer) or a token-less loopback process must reach, and each carries its own auth or is read-only by design: `GET /threadline/health` (ThreadlineEndpoints.ts:299 — identity card, probed by peers via relayForward.ts:203); `POST …/handshake/hello` / `confirm` (:362 / :447 — handshake manager); `POST …/messages/receive` (:612), `POST …/threads/backfill` (:815), `GET …/blobs/:id` (:829) — all behind `threadlineAuth` (:497-, Threadline-Relay token + X-Threadline-Agent/Nonce/Timestamp/Signature); `POST /threadline/secrets/request` (routes.ts:25588) enforces loopback AND rejects X-Forwarded-For in the handler. The other 32 registrations (routes.ts:18931-39497) all fall through to the bearer. Mount order is sound: the Threadline router is created inside `createRoutes` (routes.ts:37757), which AgentServer mounts AFTER `authMiddleware` (AgentServer.ts:1421 → 5023-5024); the only routers mounted before auth are `machineRoutes`/`oidcRoutes` (AgentServer.ts:1384/1398) and machineRoutes.ts contains no `threadline` path.
- **Allowlist evasion — none found.** Express 4.22.1; `req.path` excludes the query string and is not percent-decoded, routing is case-insensitive and non-strict. Every variant (trailing slash, `//`, upper-case, `%2d`-encoding, HEAD/OPTIONS) either misses the exact match → bearer-gated (the safe direction) or is byte-identical to a public path → can only reach that public handler. The blobs regex is anchored to one segment (middleware.ts `THREADLINE_PUBLIC_BLOB_ROUTE`). Not noted in the artifact but harmless: `HEAD /threadline/health` is now 401 too (no caller uses HEAD).
- **Newly gated routes vs legitimate token-less callers — ONE MISS (the concern).** Verified fine: mcp-http-client.ts:49/185/308/341 send the bearer; mcp-stdio-entry.ts:124 (status, fixed here) and :146 (relay-discover); relayForward.ts:364 holder-side loopback sends `Bearer ${deps.authToken}` wired from `config.authToken` at server.ts:25338 — the SAME object AgentServer's middleware getter reads (server.ts:29687 passes `config`; AgentServer.ts:1219 `this.config = options.config`; the rotation at server.ts:13208 mutates that object), so a token rotation cannot desync the forward from the gate; `readReaperPoolPeers` (routes.ts:9966-9969) sends bearer + X-Instar-AgentId; dashboard `apiFetch` (index.html:6458), console `bearer()` (agents.js:24/31/42, mandates.js:18, inside.js:29), and the `fetchImpl` injected into pairing.js/mandates.js (index.html:10798/10829) all send the token. **The miss: `src/scaffold/templates.ts:2095, 2096, 2106` (inside `generateClaudeMd`, defined at :275) emit `curl http://localhost:${port}/threadline/peers/health` and `…/peers/<fingerprint>/health` with NO Authorization header** — precisely the route the updated e2e test now pins to 401. The artifact's caller table ("templates reference only `/threadline/health` and bearer-carrying pairing examples") is therefore false: every NEW install's CLAUDE.md will instruct the agent to make a call that 401s. Existing agents received the prose form through PostUpdateMigrator.ts:9088/9108 (`GET /threadline/peers/health`, no curl), so they are less exposed, but the Agent Awareness + Migration Parity standards still apply to the shipped text. The job-template auth lint scans only `src/scaffold/templates/jobs/instar`, so it cannot catch this. **Resolution:** add `-H "Authorization: Bearer $AUTH"` to those three curls (the same file does this 157 times elsewhere), correct the artifact's caller row, and either record that the migrated prose form is covered by the template's general `$AUTH` rule or add an idempotent content-sniffing patch in `migrateClaudeMd`.
- **Tests with a real tokened server.** Static scan of every e2e/integration file that references `/threadline/` and configures an `authToken`: the only two files that also mount `authMiddleware(` are `tests/integration/sealed-handoff-at-rest.test.ts` (public secrets/request only) and the new integration test. `relay-send-honest-delivery.test.ts:161` fetches `/threadline/peers/health` bare but mounts the router WITHOUT the middleware (lines 104-105) — unaffected. Ran here: the three unit files (82 pass), the two integration files (10 pass), and e2e `a2a-peer-health-alive` + `threadline/a2a-cross-machine-route-alive` (the holder-side loopback forward under the real gate) + `threadline-negotiator-alive` (20 pass); `tsc --noEmit` clean. The artifact's "11 e2e files, 42 tests" claim is only partially reproduced (3 files / 20 tests run here); the cited test files, the eli16 doc and the upgrades/next note all exist.
- **Vault fallback — artifact §6 claim is inaccurate.** `resolveMcpAuthToken` itself never writes, never returns the `{secret:true}` placeholder (mcpAuthToken.ts:53-54 type guard, :71 string check), and importing SecretStore in the stdio entry is side-effect-free at module load (SecretStore.ts:18-23 are plain imports/constants; keychain/file access happens only inside `get()`). BUT `SecretStore.get()` → `read()` → `getCandidateKeys()` (SecretStore.ts:162-185): when the vault FILE exists and NO key resolves, line 184 calls `getMasterKey()` → `getFileKey()` (:298-325), which GENERATES a new master key and PERSISTS it (per-agent keychain entry, else `.instar/machine/secrets-master.key`) before `read()` throws "no resolvable key". So "the vault is only READ by the stdio helper, never written, repaired or rotated" is false in that branch: a hand-started Codex whose session environment cannot see the server's keychain (e.g. no Secret Service D-Bus session on Linux) plants a divergent file key — the 2026-06-05 bifurcation seed. This is pre-existing SecretStore behaviour shared with `secret-get.mjs` (templates/scripts/secret-get.mjs:29-79 uses the same class) and the server normally resolves the key first, so it is an accuracy defect in the artifact, not a new hole. **Resolution:** correct §6 and the mcpAuthToken.ts header comment ("may generate a master key if none resolves — SecretStore behaviour"), and optionally guard the call with a non-generating pre-check (attempt only when `store.exists` and a key file/keychain entry is readable). Non-blocking.
- **Signal vs authority — correct.** A bearer-equality check is hard-invariant validation at the API edge (docs/signal-vs-authority.md "When this principle does NOT apply"), not a content judgment; it removes an exemption from the existing single authority rather than adding a parallel blocker. No detector gains blocking power.
- **Multi-machine posture — correct, and the artifact's §1 worry is unfounded.** The only cross-machine path to a gated route is the forwarded relay-send, which runs on the HOLDER's own loopback with the HOLDER's own token (server.ts:25337-25338); divergent per-machine tokens could not 401 it. Only `readReaperPoolPeers`' peer reads depend on the shared-token pool assumption, and that is pre-existing.
- Minor, non-blocking: bearer-only callers under `/threadline/*` (stdio helper, dashboard, pool reads without a matching agent-id) now trigger the hourly `[auth] deprecation: … X-Instar-AgentId` stderr line (observed in the unit run); `mcp-http-client.ts:239-240` still describes `/threadline/*` as an "auth-bypass umbrella" — stale wording.

**Verdict: concern — ship after fixing templates.ts:2095/2096/2106 (bearer on the peer-health curls) and correcting the artifact's caller row and §6 vault claim. The gate change itself is correct and complete.**

**Resolution (author, same day):** all three items done before commit. (1) `src/scaffold/templates.ts` — the three curls carry `-H "Authorization: Bearer $AUTH"`; `migrateClaudeMd` rewrites the exact bare forms in existing agents' CLAUDE.md (idempotent, scoped to `/threadline/peers/`), covered by `tests/unit/PostUpdateMigrator-threadlineBearerCurls.test.ts`; the auth lint gained a test that scans the generated CLAUDE.md for token-less curls to any non-public threadline route (it passed only after the fix). (2) The caller table and §6 now state the template gap and the SecretStore master-key behaviour. (3) §1's divergent-token worry is retracted per the reviewer's reading of the holder-loopback path. The stale "auth-bypass umbrella" comment in `mcp-http-client.ts` is rewritten. The agent-id deprecation line is pre-existing behaviour for every bearer-only caller and is left as is.

---

## Evidence pointers

- `tests/integration/threadline/relay-send-bearer-required.test.ts` — on the pre-change middleware: 5 failures, "expected 400 to be 401" for the empty unauthenticated POST and "expected 503 to be 401" for a forged well-formed send (it reached the send path); with the change: 9/9 pass.
- `tests/unit/auth-middleware-threadline-exact-routes.test.ts` — 25 own-surface routes × (refused without / passed with token), six public routes + blob shape open by exact route, method and prefix/suffix look-alikes gated.
- `tests/unit/threadline-mcp-auth-token.test.ts` — resolver order, placeholder guard, locked vault, real file-keyed vault read.
- `tests/unit/job-template-auth-lint.test.ts` — now flags an unauthenticated `/threadline/relay-send` curl, still passes `/threadline/health`, and scans the generated CLAUDE.md for token-less curls to non-public threadline routes (failed on the pre-fix template with three hits; passes after).
- `tests/unit/PostUpdateMigrator-threadlineBearerCurls.test.ts` — rewrite of the bare curls, idempotency, and no-op on a fresh template.
- Full unit lane on the author's machine: 52606 passed, 10 failed in 5 files none of which import the changed modules; all 10 reproduce as test-rig artefacts (temp-root classification passes with the default TMPDIR; the idle-backoff and port-fallback timing tests pass when run alone; the two `ndrive.sh` refusal tests fail on this WSL box regardless of the diff). Integration threadline lane: 498 passed.
- Real-server threadline e2e suites (11 files, 42 tests): all pass after the one stale "bearer-exempt by design" assertion in `a2a-peer-health-alive` was updated; the other ten files passed unchanged because every legitimate caller already sent the token.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The defect is in server source, not an LLM prompt, hook, config, skill or standards text; and no self-triggered controller is added or modified.)
