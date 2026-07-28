# Side-Effects Review — HumanAsDetectorLog

**Change**: Ports Dawn's human-as-detector pattern into Instar. Treats every human-caught
coherence break as a first-class signal about which automated layer failed to catch it.

## Files
- `src/monitoring/HumanAsDetectorLog.ts` (new) — singleton, deterministic no-LLM classifier,
  append-only `.instar/metrics/human-as-detector.jsonl`, `summarizeByLayer()` heat map, plus
  the `observeInboundMessage()` gating helper (inbound-human-only).
- `tests/unit/HumanAsDetectorLog.test.ts` (new) — 19 unit tests (classifier/observe/heat-map +
  gating-helper wiring integrity).
- `tests/integration/human-as-detector-routes.test.ts` (new) — 3 tests via real `createRoutes`.
- `tests/e2e/human-as-detector-lifecycle.test.ts` (new) — 2 tests, live HTTP boot + disk.
- `src/server/routes.ts` — adds read-only `GET /human-as-detector/summary` (singleton-backed).
- `src/commands/server.ts` — configure() at startup; `observeInboundMessage()` chained onto
  `telegram.onMessageLogged` (chains prior callbacks; only inbound human messages).

## Side effects
- **New disk write**: appends to `.instar/metrics/human-as-detector.jsonl` only when an
  inbound human message matches a correction signal. Best-effort; wrapped in try/catch; never
  throws into message handling.
- **Console**: one `[HUMAN-AS-DETECTOR]` warn line per detected signal (mirrors
  DegradationReporter's loud-not-silent convention).
- **No network, no LLM, no external calls.** Classifier is pure regex over a conservative set.
- **No behavior change to message handling**: the hook only observes; prior `onMessageLogged`
  callbacks (TopicMemory dual-write, PresenceProxy, keep-watching) are preserved via chaining.
- **New endpoint** is read-only and singleton-backed (always available; no 503 path).

## Risk
- Low. Additive, isolated module. Worst case on a logic bug: a spurious JSONL line or a missed
  signal — neither affects message delivery (observe never throws into the caller).
- False-positive risk on the classifier is bounded by the `totalWeight >= 2` threshold (lone
  weak signals like "actually," are ignored).
- Rollback cost: trivial — drop the module, the endpoint, and the ~6 wiring lines; no schema,
  no migration, no config default.

## Signal vs authority
- Pure signal. The log only *records* and *summarizes*; it has no blocking authority and gates
  nothing. Consumers (a human reading the heat map, or future evolution tooling) decide.

## Verification
- `npx tsc --noEmit` — clean (no new errors).
- `npx vitest run` on the three new test files — 24/24 pass across unit + integration + e2e.
