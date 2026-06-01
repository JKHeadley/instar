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

**The pre-messaging honesty guard now recognizes your agent's other machines as
its own.** A multi-machine instar agent runs on more than one machine, each
exposed at its own subdomain under the operator's tunnel domain (for example the
laptop and the Mac Mini each get a subdomain of the same tunnel domain). The
URL-provenance check — which blocks messages containing made-up-looking links —
previously trusted only the agent's exact own tunnel host, so a legitimate
operation addressing a sibling machine of the same agent was falsely flagged as
an "unfamiliar domain" and blocked.

It now also trusts hosts that share the agent's tunnel parent domain, so sibling
nodes are recognized — while still blocking genuinely fabricated links. Two
guards keep it safe: the parent domain is derived only when the own host has at
least three labels (never trusts a bare public-suffix apex), and the match is a
true DNS-suffix test (a look-alike like echo.dawn-tunnel.dev.evil.com stays
blocked because it actually ends in evil.com). Single-machine agents are
completely unaffected.

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

Nothing to configure. If your agent runs across more than one machine, it can
now perform legitimate cross-machine operations (like the multi-machine reply
relay) without its own honesty guard blocking the request — while still catching
invented links. If you only run one machine, nothing changes at all.

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

- `convergence-check.sh` URL-provenance guard trusts sibling-node tunnel hosts
  (any host under the agent's tunnel parent domain), in addition to the agent's
  own host, Cloudflare quick tunnels, and the static allowlist. Deploys to
  existing agents via the standard `migrateScripts()` template path (the template
  content is the migration — no `PostUpdateMigrator` code change).

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

- Reproduction (live, 2026-06-01): proving the multi-machine reply relay, the
  command `POST https://echo-mini.dawn-tunnel.dev/telegram/reply/8882` (laptop
  driving the mini's tokenless-standby relay) was blocked by the
  `grounding-before-messaging` hook because its convergence-check URL-provenance
  guard flagged `echo-mini.dawn-tunnel.dev` as unfamiliar — it knew the laptop's
  own host `echo.dawn-tunnel.dev` but not its sibling. The mini's LAN address was
  firewalled, so the tunnel host was the only path, and the proof was blocked.
- Before/after (the guard decision, real shipped template): own host
  `echo.dawn-tunnel.dev` → parent `dawn-tunnel.dev`; sibling
  `echo-mini.dawn-tunnel.dev` BLOCK→PASS (the fix); own host PASS→PASS;
  `totally-fake-host.xyz` BLOCK→BLOCK; look-alike `echo.dawn-tunnel.dev.evil.com`
  BLOCK→BLOCK; arbitrary host with a 2-label apex config BLOCK→BLOCK (apex not
  over-trusted).
- Tests: `tests/unit/convergence-check-sibling-trust.test.ts` (6) execute the
  real shipped `convergence-check.sh`: `bash -n` valid; sibling trusted; own
  unchanged; fabricated blocked; look-alike suffix blocked; 2-label apex not
  over-trusted. 6/6 green; `tsc` clean.
