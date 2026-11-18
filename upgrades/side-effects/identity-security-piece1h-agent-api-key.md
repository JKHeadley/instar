# Side-Effects Review — A missing or unreadable agent API key

**Version / slug:** `identity-security-piece1h-agent-api-key`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (authentication robustness). Spec `docs/specs/identity-security-piece1h-no-token-refusal.md` (2 internal rounds plus Astra, redesigned after round 1: no automatic key creation, no switch).

- A key the secret store did not load (a `{ secret: true }` placeholder) is refused with `503 agent-credential-unavailable` at the key comparison point. Every exemption before it still runs with its own proof. Today the compare hashes an object and throws (`ERR_INVALID_ARG_TYPE`, a 500).
- The same check covers `bearerMatches`, the WebSocket upgrade, `/jobs/events`, view-link signing and verifying, the dashboard unlock route, the feedback-drain key and the keychain revision witness. A unit test scans `src/` for unguarded hashing of `authToken`.
- `AgentKeyHealth` (new, `src/server/agentKeyHealth.ts`) re-reads the key through `loadConfig`:
  - backoff 1, 2, 4… minutes, capped at 30;
  - one owner item (`agent-api-key-unreadable`) after 3 failures;
  - stops after 24 hours with a final notice;
  - applies the key live (the middleware reads `this.config.authToken` through a getter), and closes the item.
- No key at all: served as today, and counted (`security.agentApiKey`, at most one evidence row a minute). The existing "Reply fix auth" notice remains the one notice.
- The "fix auth" reply (`src/commands/fixAuth.ts`):
  - creates a 32-byte key (was 16);
  - checks the write (LiveConfig.set only logs failures);
  - applies the key to the running config;
  - posts no part of it (it posted 8 characters);
  - refuses to set a key on one machine of a multi-machine agent.
- The Telegram lifeline sends `Authorization` only for a string key (never `Bearer undefined` / `Bearer [object Object]`). It re-reads the key on a 401 (not a secret refusal), a 403 `Invalid auth token`, or a 503 `agent-credential-unavailable`:
  - once per forward or callback, and at most once every 5 seconds;
  - still refused after the re-read: `ForwardKeyRefusedError` (new, terminal for the retry loop) re-queues the message without burning replay budget and logs once a minute; unlike a lifeline-secret refusal it raises no "/lifeline restart" notice (the server tells the owner about its own key).
- Sessions get `INSTAR_AUTH_TOKEN` only for a string key, and an explicit empty value otherwise (was the literal `"undefined"`).

## Decision-point inventory

- Auth middleware key comparison — modify — a non-string key refuses with 503 instead of throwing; no-key path unchanged (plus a counter).
- `bearerMatches`, WebSocket `authenticate`/`verifyToken`, `/jobs/events` — modify — same rule.
- Lifeline forward/callback response handling — modify — key refusal re-read; 503 `agent-credential-unavailable` no longer read as "server booting".
- "fix auth" — modify — multi-machine refusal, checked write.

---

## 1. Over-block

With a placeholder key, requests that today crash with 500 now get 503. A request that relied on a broken key crashing does not exist, so nothing is newly blocked. Exempt routes (health, device-signed, mesh, Threadline peers, documents, pairing, Secret Drop, PIN unlock-check) are unchanged.

The "fix auth" reply on a multi-machine agent now declines instead of creating a key. Today it creates one that the agent's other machines cannot present, so their calls would be refused. Declining blocks less than today.

## 2. Under-block

No-key agents stay open, as today, by design: umbrella section 10 leaves that to the owner's per-agent card (piece 5). The count makes the exposure measurable.

## 3. Level-of-abstraction fit

The rule lives in the middleware helpers (`isUsableToken`, `isUnreadableToken`) that every compare site imports. The lifeline has one header helper. The re-read watcher is one small class with injected seams. No parallel mechanism.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is deterministic over a credential's type: a placeholder is never a valid credential (known-invalid authentication, umbrella section 10). No judgment is replaced.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check (Judgment Within Floors standard)

The retry numbers (1→30 minute backoff, notice after 3, stop at 24 hours; lifeline re-read at most every 5 seconds) are bounded floors for one cheap local read. Their evidence is in the spec's decision points. No model decides anything here.

## 4c. Self-action convergence (Capacity Safety — No Unbounded Self-Action)

`AgentKeyHealth` is a self-triggered retry loop. It is registered as `agent-key-reread` in `src/testing/selfActionRegistry.ts`, and `tests/unit/self-action-convergence.test.ts` proves it settles:
- one timer at a time;
- the wait doubles from 1 minute to a 30-minute cap;
- all re-reads stop 24 hours after the first failure.

The window (first failure, failure count, gave-up) is kept in `state/agent-key-reread.json`, so a restart continues it instead of resetting it, and a give-up stays given up. That bounds an unreadable-key episode to about 54 local file reads and at most two owner notices. Declared in the trace as `unbounded-self-action`, closure `guard`, ratchet-enforced.

## 5. Interactions

- Hooks and reply scripts read `${INSTAR_AUTH_TOKEN:-<config>}`. With an explicit empty value they read the config, so sessions started after this release keep working after "fix auth".
- A forward still refused after the re-read raises `ForwardKeyRefusedError`, which re-queues like `ForwardSecretRefusedError` but sends no owner notice of its own, so the owner hears about an unloaded key once (the server's item), not twice.
- While the key is unreadable, dashboard `dst_` tokens still authenticate HTTP routes, but `/ws` and `/jobs/events` (which compare only the agent key) refuse them. Today those crash, so nothing works less than before.
- "fix auth" judges the running server's key first: on a healthy agent whose key lives in the secret store the settings file holds a placeholder, and the reply correctly says a key exists.
- The middleware getter is live, so the watcher's `apply` takes effect at once.
- `SlackLifeline` has no caller on main (`routes.ts:~24429`); its header line gets the same check.

## 6. External surfaces

- A new 503 body `agent-credential-unavailable` for the placeholder case (was a 500).
- One new owner attention item (`agent-api-key-unreadable`), only in that case.
- The "fix auth" Telegram reply text changes and no longer contains key characters.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The owner item says:
- what is wrong: the API key could not be loaded;
- the effect: the API is refusing requests, and Telegram messages wait;
- what the agent is doing: retrying, or has stopped after a day;
- the one ask: ask the agent to repair the secret store.

## 7. Multi-machine posture (Cross-Machine Coherence)

The key is not created, copied or rotated automatically, so no divergence is introduced. The watcher and counter are per machine (they describe this machine's listener); attention items merge with `?scope=pool`. "fix auth" refuses on a multi-machine agent, and the awareness note gives the all-machines route (secret store on the lease holder, secret sync, restart).

## 8. Rollback cost

Revert and ship a patch. No data migration. What persists: one attention row, evidence rows, and `state/agent-key-reread.json` while a key is unreadable, which is cleared once the key loads.

## Conclusion

Clear to ship once the second pass concurs.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5), 2026-11-18
**Independent read of the artifact: concur**
Exemptions still run before the new 503, a no-key agent behaves as today on every path, and the watcher stays within its limits. Re-check of the two earlier defects: `fixAuth` now checks the running server's key before the settings file, so a key held in the secret store no longer reads as unloaded. A forward refused after the re-read now throws `ForwardKeyRefusedError` (terminal); it is re-queued with a once-a-minute log and no longer reaches `noteSecretRefusal` or its "/lifeline restart" notice. No remaining defects: tsc shows no errors in the touched files, and the unit file passes 21 tests (the artifact says 22).

## Evidence pointers

- Unit: `tests/unit/identity-piece1h-agent-key.test.ts` (21), plus middleware, fix-command, WebSocket, lifeline and session-spawn suites (187 tests passing locally).
- Integration: `tests/integration/identity-piece1h-agent-key.test.ts`. E2E: `tests/e2e/identity-piece1h-agent-key-alive.test.ts` (Local Verify runs them).
- Throwaway: agent home `.instar/state/identity-build-144636/p1h-throwaway-proof.md` (unreadable key 503 → owner item → key loaded live, no restart; real lifeline forward with no key, then after a key change via one re-read; Telegram API answered by a fetch shim).
- Guards before push: no-silent-fallbacks (the new owner-notice helpers sit after raiseLockedSecurityItem so an existing catch keeps its detection window), feature-ladders-coverage, awareness-entry-registry, html-site-ratchet, the 21 other ratchet files, self-action-convergence, the state-registry lints: all pass.
