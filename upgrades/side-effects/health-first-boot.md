# Side-Effects Review — health-first boot (boot health beacon)

**Version / slug:** `health-first-boot`
**Date:** `2026-06-07`
**Author:** `Echo`
**Tier:** 1 (ships DARK behind `monitoring.bootHealthBeacon.enabled`, default OFF — zero behavior change until enabled; additive; both-sides tested)
**Second-pass reviewer:** `Echo (self) — Tier-1; dark/off-by-default, additive, isolated module; the boot-wiring placement was carefully traced (foreground/daemon fork resolved)`

## Summary of the change

The durable cure for the 2026-06-07 "server temporarily down" restart loop (topic
21816, root cause #1 — "Liveness Before Load"). The server boot loads large
TopicMemory/SemanticMemory + reconciles dozens of sessions BEFORE AgentServer
binds its port, so for ~5-6 min under load nothing answers `/health` and the
supervisor can mistake a slow boot for a dead process → restart-before-boot loop.

Adds `BootHealthBeacon` (`src/server/BootHealthBeacon.ts`): a minimal HTTP listener
that answers `/health` 200 (and 503 `warming` to everything else) from the very
start of boot. Wired in `commands/server.ts`: started right after `setupServerLog`
(early, common/universal boot path — daemon mode re-execs into `--foreground`,
verified at server.ts:12463), and **closed at the handoff immediately before**
`server.start()` (AgentServer's listen). `stop()` force-closes lingering sockets +
awaits the socket close, so the real `listen` cannot hit EADDRINUSE and the gap is
sub-second. Config flag `monitoring.bootHealthBeacon.enabled` (default OFF) +
type + ConfigDefaults. The startupGrace bump (#979) covers the window until this is
turned on.

## Decision-point inventory

- Enabled? `monitoring.bootHealthBeacon.enabled` — default OFF; absent ⇒ off (read
  via optional chaining). The only gate.
- Where to start/stop the beacon (boot-order placement) — the load-bearing
  decision; see Blast radius.

## 1. Beacon fails to start

Wrapped in try/catch — non-fatal. Boot proceeds without the beacon (the grace bump
still covers the window). The server is never blocked from booting by a beacon
problem. Both guards (start + stop) log the error and are marked
`@silent-fallback-ok` (intentional best-effort fallback, not a silent swallow) so
the no-silent-fallbacks ratchet stays at its baseline.

## 2. Handoff race (EADDRINUSE on the real listen)

`stop()` calls `server.close()` AND `closeAllConnections()` and awaits the `close`
event, so the port is released before `server.start()` binds it. `keepAliveTimeout=1`
prevents an idle keep-alive socket from holding the port. The unit test asserts a
real server can bind the same port immediately after `stop()`. The `stop()` call is
also try/caught so a stop failure still lets the real server attempt to bind.

## 3. Wrong boot-order placement (silent no-op)

The start is placed in the **common** boot path: the `if (options.foreground)`
block is the universal server boot — daemon mode spawns the server with
`--foreground` (server.ts:12463), so every real server runs it. `bootBeacon` is
declared at the foreground-block body scope (indent-4), in scope at both the start
(after setupServerLog) and the stop (before server.start at the same scope). Started
before the heavy memory/session loads, so it covers the whole window.

## 4. Blast radius

DARK (default off) ⇒ zero behavior change for every existing and new agent until the
flag is explicitly set. When enabled: one extra short-lived HTTP listener during
boot that is closed before the real server binds. It only ever *adds* a liveness
answer during boot; it cannot make a healthy server look unhealthy. Rollout:
dark → canary on Echo (flip flag, watch one boot) → fleet.

## 5. Rollback

Set the flag off (or absent) ⇒ fully inert. Code revert is clean (new module + an
import + two guarded blocks + an optional config field). No state/format change.

## 6. Tests

`tests/unit/BootHealthBeacon.test.ts` (4): /health→200 ok while booting; everything
else→503 warming; **stop() releases the port so a real server binds it immediately**
(the handoff); start/stop idempotent. tsc clean. The boot wiring is exercised by the
existing server e2e on the default (off) path (no behavior change); live canary
verification (flag on, observe /health during a real boot) is the rollout step.
