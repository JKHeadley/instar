# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

The per-feature LLM metrics now actually collect data. Phase 1a added the ledger
+ `GET /metrics/features`; **Phase 1b adds the funnel tap** — the one shared LLM
call (`CircuitBreakingIntelligenceProvider.evaluate`) now records, per gate/
sentinel, its latency, whether it had to wait out a rate-limit window, and
success/error. So `/metrics/features` goes from empty to live as your checks run.

It's pure observability: a single side-channel `record()` per call, in a
swallow-all try/catch, with the breaker/rate-limit control flow byte-identical.
No gate changes behavior.

New read-only observability: **per-feature LLM metrics**. A new
`FeatureMetricsLedger` (SQLite, like the token ledger) plus `GET
/metrics/features` let you see what each LLM-driven gate/sentinel actually
costs (tokens, latency) and how often it fires — so tuning them is evidence-
based (which to thin, which to strengthen) instead of guessed.

This is **Phase 1a**: the store + endpoint. It changes no existing gate's
behavior and writes nothing in production yet — the single funnel tap that
feeds it lands in **Phase 1b**, on top of the in-flight rate-limit-resilience
change (#638), so the two don't collide.

New per-agent, opt-in config flag **`updates.restartImmediately`** (default
**false**). When true, that agent's update restarts are **never deferred** — not
for active sessions, not for the restart window — so it always rolls onto the
latest version as soon as it is downloaded.

This is intended for the instar developer's own agent (always-current is
required when you build and dogfood the fleet). It is **off by default**, so the
fleet's existing session-aware + window-aware restart deferral is unchanged.

**A moved conversation's reply no longer hangs silently when the other machine
is briefly unreachable.** When you move a conversation to another machine, that
machine relays its replies through the machine that holds the Telegram
connection. That relay had two operational defects, both found by driving the
multi-machine feature live: it had no time limit (so when the receiving machine's
connection was momentarily restarting, the reply hung for over a minute with no
result), and it failed completely silently (a dropped reply wrote nothing to the
log, so there was no way to tell why it didn't arrive).

The relay is now bounded and observable: it gives the receiving machine a fixed
window (15 seconds by default, adjustable) and then fails fast, and every failure
writes one clear line saying exactly what went wrong (no reachable machine, a
rejection with its status code, or a timeout). The relay logic was also extracted
into its own well-tested unit.

It also no longer reports a false success: previously the relay could report
"delivered" even when the message never actually reached the chat (it accepted a
response that carried no real message id). Now the receiving machine returns the
real message id and the relay only counts a reply as delivered when that id is
present — otherwise it's treated as undelivered and surfaced, so a busy or flaky
moment becomes a real, visible failure (and a retry candidate) instead of a
silent loss dressed up as success.

## What to Tell Your User

Nothing required. If asked: the per-feature metrics endpoint now shows real
per-check cost (latency), how often each check runs, and how often it hits a
rate-limit wait — the data that lets us tune the checks with evidence.

Nothing required. If asked: the agent can now report, per safety check, how
much it costs and how often it fires (via a new per-feature metrics endpoint) —
which is what lets us tune the checks with data instead of guesses.

Nothing for almost everyone — this is off by default and changes nothing unless
you explicitly enable it. If you run the kind of agent that must always be on the
latest build, enable the restart-immediately option in your agent config. A
server restart does **not** close your sessions (they resume via CONTINUATION);
the only cost is a brief messaging blip while the server bounces. The updates
status endpoint now reports whether it's on, so you can confirm it.

Nothing to configure. If you run across more than one machine and move a
conversation between them, a reply that can't be delivered now fails quickly with
a clear reason in the log, instead of hanging for over a minute and vanishing
without explanation. Single-machine setups are unaffected.

## Summary of New Capabilities

- `CircuitBreakingIntelligenceProvider` instruments every LLM call into the
  `FeatureMetricsLedger` via a module-level recorder (`setFeatureMetricsRecorder`),
  wired once in the server so it covers all current and future LLM features.
- Per-feature data: call-count, latency (p50/p95), rate-limit wait-rate, error-rate.
  (Fired-vs-noop verdict + token attribution are Phase 2.)

- `GET /metrics/features` (`?sinceHours=` / `?feature=`) — per-feature rollup:
  calls, tokens, fired/no-op, fire-rate, p50/p95 latency, wait-stats.
- `FeatureMetricsLedger` — read-only per-feature LLM observability store.
- Agents learn about it via the CLAUDE.md template (new) + migration (existing).

- `updates.restartImmediately` config flag (default false). `UpdateGate` gains
  `alwaysRestartImmediately` (short-circuits `canRestart` to allow, never starts
  the deferral clock) + a runtime `setAlwaysRestartImmediately` setter; the
  `AutoUpdater` constructs the gate with it, skips the restart-window wait when
  set, and re-reads the flag each tick so a live config edit takes effect without
  a restart. The same-version cooldown + cascade dampener (loop protection) are
  preserved.
- Observability: both `UpdateGate.getStatus()` and `AutoUpdater.getStatus()` /
  `GET /updates/status` surface the active value.

- `relayOutbound` (`src/core/TelegramRelay.ts`) — the tokenless-standby reply
  relay, extracted as a pure injectable unit with a bounded `AbortController`
  timeout and a log line on every failure path. `server.ts` wires
  `telegram.outboundRelay` to it. New optional `multiMachine.relayTimeoutMs`
  (default 15000).

## Evidence

- Spec: `docs/specs/llm-feature-metrics-spec.md` (Phase 1b; approved Telegram 13435).
- Tests: `tests/unit/CircuitBreaking-feature-metrics-tap.test.ts` (+8, incl. an
  end-to-end feed into a real ledger); all 74 existing CircuitBreaking/breaker tests
  pass unchanged; `npm run lint` clean.

- Spec: `docs/specs/llm-feature-metrics-spec.md` (+ `.eli16.md`), review-convergence
  + approved by Justin (Telegram 13435, 2026-05-31).
- Tests (3-tier): `tests/unit/FeatureMetricsLedger.test.ts`,
  `tests/unit/PostUpdateMigrator-metricsFeatures.test.ts`,
  `tests/integration/metrics-features-routes.test.ts`,
  `tests/e2e/metrics-features-lifecycle.test.ts` (feature-is-alive: 200 not 503).
  `npm run lint` clean.

- Spec: `docs/specs/restart-immediately-spec.md` (approved Telegram 13435,
  2026-06-01).
- Tests: `tests/unit/UpdateGate.test.ts` (+7: allow-despite-healthy-session,
  pure-no-deferral, monitor-not-consulted, default-still-blocks, runtime
  toggle both directions) and `tests/unit/AutoUpdater.test.ts` (+2: default
  false; `restartImmediately:true` reflected in status via the real gate). All
  19 UpdateGate + 18 AutoUpdater tests pass; `npm run lint` (tsc) clean.

- Reproduction (live, 2026-06-01): driving the multi-machine reply proof, a
  relayed reply hung 25s then 70s with no result and no log line; root cause was
  the holder's tunnel being mid-restart, and the relay `fetch` having no timeout.
  Once the tunnel was back, the relay completed (a tone-gate response and an `ok`
  came back through the full standby→holder chain), confirming the path itself
  works — but the hang + silence were real operational defects on the way there.
- Tests: `tests/unit/telegram-relay-timeout-observability.test.ts` (7) drive the
  real `relayOutbound` with an injected fetch + logger: 2xx returns messageId and
  posts the right URL + `Bearer` header; self-hold no-ops; no-peer-URL logs;
  non-2xx logs the status; **a hanging holder aborts within the timeout (elapsed
  under 2s) and logs `timeout after Nms`**; a network error logs its message; the
  `silent` flag passes through. 7/7 green; `tsc` clean.
