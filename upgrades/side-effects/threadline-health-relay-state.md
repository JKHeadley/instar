# Side-Effects Review — /threadline/health reports real relay state

**Version / slug:** `threadline-health-relay-state`
**Date:** `2026-07-30`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required — reasoning in section 4`

## Summary of the change

`GET /threadline/health` returned `status: 'ok'` as a LITERAL and never consulted the relay. On 2026-07-30 the relay was displaced at 04:56:12Z — which disarms reconnect for the life of the process — and the route reported `ok` for the following 6h45m while the agent could neither send nor receive; 131 A2A messages queued unsent. Every input needed was already in-process and unread: `relayConnectionObserver` recorded the loss with a `terminal` flag and `ThreadlineBootstrap` exposed it as `getLastRelayEvent()`, which nothing captured; `threadline_discover` was simultaneously reporting `staleReason: 'relay not connected'`.

The handler now consults live `connectionState` plus the last loss event and reports a `relay` block, with `status` moving off `ok` when the relay is genuinely down. Files: `src/threadline/ThreadlineEndpoints.ts` (new exported pure `resolveRelayHealth` + handler), `src/commands/server.ts` (capture `getLastRelayEvent`), `src/server/AgentServer.ts` (option → ctx), `src/server/routes.ts` (ctx type + `relayStatus` probe), `tests/unit/threadline/threadline-health-relay-state.test.ts` (13 tests).

## Decision-point inventory

- `GET /threadline/health` → `status` — **modify** — reports relay state instead of a constant. A STATUS REPORT, not a gate: it blocks nothing and authorizes nothing.
- `resolveRelayHealth()` — **add** — pure mapping from relay state to verdict. No authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — nothing is rejected. The analogous risk is a FALSE FAULT, and three cases are handled explicitly so the check cannot cry wolf:

- Relay disabled, or the listener daemon owns the connection → the probe returns null → `not-configured` and `status: 'ok'`. Reporting a fault for a deliberately relay-less agent would train readers to ignore this check.
- Live connection with a stale terminal event on file → reported `connected`/`ok`. Live state wins.
- Probe throws → falls back to `not-configured`/`ok` rather than 500.

Residual: an agent whose relay is legitimately mid-reconnect at the instant of a scrape reads `degraded`. That is accurate, not a false positive, and `recoverable: true` says it will heal.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Nothing alerts on it.** This makes the truth *available*; it does not notify anyone. The 6h45m outage would still have gone unnoticed unless something read this route. Wiring relay state into the guard-posture/attention surface is the follow-up that turns availability into detection, and is deliberately not bundled here. <!-- tracked: ACT-1611 -->
- **A relay that is "connected" but not passing traffic** still reports `ok`. Reachability is not delivery. The A2A delivery tracker and `/threadline/peers/health` already cover pending/stale sends, so this route is not the right place to duplicate that.
- **Flap frequency is not surfaced.** Four displacements occurred in two days; this reports only the current state and the last event, so a rapidly flapping relay looks the same as a stable one at any single scrape. Recorded rather than silently scoped out. <!-- tracked: ACT-1611 -->
- **The root cause is untouched.** Two machines sharing one identity will keep displacing each other; this only stops the lying. <!-- tracked: ACT-1611 -->

---

## 3. Level-of-abstraction fit

Correct layer, and deliberately the smallest one that works. The observer already owned recording and explicitly documents its scope as "records transitions, does not reconnect"; this consumes that record rather than duplicating or extending it. An earlier draft added connect-tracking and a `getState()` to the observer — reverted, because live `connectionState` already existed on the client and was already consumed elsewhere in `routes.ts`, so extending the observer would have been a second source of truth for a fact the system already had.

The decision logic is extracted as an exported pure function so the boundary is testable without standing up HTTP — the alternative was asserting behavior only through supertest, which would have made the branch coverage clumsier and the failure messages less specific.

---

## 4. Signal vs authority compliance

Compliant. Per `docs/signal-vs-authority.md` this is a pure SIGNAL: a status surface with no blocking power. It does not gate a send, admit a session, or authorize anything. Nothing downstream is given new authority — no caller is changed to act on the new field.

**Second-pass reviewer judged not-required, with reasoning recorded because the call is arguable.** The change is not in any Phase-5 trigger category (no block/allow decision, no session lifecycle, no compaction, no coherence/idempotency/trust gate, no sentinel/guard/gate/watchdog). The one genuine risk — that peers consume this route for discovery and a changed verdict could make them drop this agent — was resolved by inspection (`AgentDiscovery.verifyAgent` gates on `response.ok` + `identityPub` + `protocol`, never `status`; repo-wide grep for `health.status` finds only moltbridge's unrelated endpoint and a `console.log` in `commands/relay.ts`) and then PINNED with a test that fails if HTTP 200 or the identity fields ever change while the relay is down.

---

## 5. Interactions

- **Peer discovery contract preserved.** HTTP 200, `protocol`, `identityPub`, `fingerprint` unchanged. A dedicated test asserts all three hold while the relay is displaced.
- **Back-compat with the existing suite.** The pre-existing 20 tests in `ThreadlineEndpoints.test.ts` construct the router without a `relayStatus` probe and assert `status === 'ok'`; the `not-configured` branch keeps them passing. Verified: 20/20 still pass.
- **New ctx field is optional.** `getLastRelayEvent?` on the routes ctx — several tests build that ctx literally, and a required field would have broken them at type level for no benefit. It is accessed with `?.`, so optional is the honest declaration.
- **No double-firing.** Nothing else computes a relay verdict; `/channels` reads `connectionState` for a different question (which channels exist) and is untouched.

---

## 6. External surfaces

- **`/threadline/health` is UNAUTHENTICATED** (verified by curling it with no credential). So the relay's raw `reason` string — peer-influenced text — is deliberately NOT exposed. Only a code-defined state enum, a boolean, and an ISO timestamp cross the boundary; a test asserts a planted secret in a reason field does not appear in the output and that no `reason` key is emitted. Full detail stays in the durable log and server console, which are already where an operator reads for depth.
- **Visible to other agents**, which is the point: a peer scraping this route can now see that this agent's relay is down.
- **Timing dependence**: the verdict is point-in-time by nature. `recoverable` is what a reader should act on, not the instantaneous state.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and that is the correct posture** — with one caveat worth stating plainly.

The relay connection is a property of ONE process on ONE machine. Each machine has its own connection and must report its own truth; replicating or merging this across machines would be actively wrong, since the whole failure mode is that two machines sharing one identity have *different* relay states — one holds the connection, the other is displaced and dark. A merged view would obscure exactly the asymmetry a reader needs.

Caveat: the incident itself is inherently multi-machine (the displacer was this agent's other machine), so an operator asking "is my A2A working?" on a two-machine agent must check BOTH machines — this route answers only for the machine serving it. No pool-scope read is added here; that belongs with the alerting follow-up. <!-- tracked: ACT-1611 -->

No user-facing notice (so no one-voice gating needed), no durable state that could strand on topic transfer, no generated URL.

---

## 8. Rollback cost

Low. `git revert` restores the literal `ok`; the `relay` field disappears. No migration, no persisted state, no agent repair — nothing writes state in this change. Consumers are additive-safe: the new field is ignorable, and no caller was changed to depend on it.

If only the verdict mapping is wrong (e.g. `error` judged too strong for a displacement), the narrower fix is editing `resolveRelayHealth` alone — a pure function with no callers other than the handler.
