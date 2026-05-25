# Side-effects review — the Usher (rung 4, signal-only)

**Scope**: A signal-only mid-task watcher that re-surfaces faded-but-now-relevant
context. Per the ratified spec (`docs/specs/cwa-usher.md`): on each substantive
inbound turn, query the faded tail of the topic-intent store, ask a cheap LLM
whether the turn re-activates any, and emit re-surface SIGNALS to a read-only pull
surface. It NEVER injects (rung 5, gated on the Usher's measured precision).

**Files touched**:
- `src/core/UsherSignalStore.ts` — NEW. File-backed per-topic store of signals +
  precision metrics (fired/acted); atomic writes; best-effort (never throws);
  capped at 50 signals/topic.
- `src/core/Usher.ts` — NEW. `buildUsherPrompt`/`parseUsherResponse` (anti-injection,
  refId-validated), `createUsherCheckFn` (injected provider, degrade-safe),
  `usherCheckTurn`/`createUsherLoop` (pre-filter reuse, shed/rate gates, faded-tail
  = observation-tier refs, fire-and-forget, never-throws). Reacts to USER turns only.
- `src/server/usherRoutes.ts` — NEW. `GET /usher/signals` + `GET /usher/metrics`
  (with precision = acted/fired). 503-stub when the store is absent.
- `src/server/AgentServer.ts` — new optional `usherSignalStore`; mount the routes.
- `src/commands/server.ts` — construct `UsherSignalStore` (unless disabled); chain
  the Usher loop onto `onMessageLogged` AFTER the capture chain (reusing the
  queued subscription provider + LlmQueue); pass the store to AgentServer.
- `src/server/CapabilityIndex.ts` — `usher` → `INTERNAL_PREFIXES`.
- `src/config/ConfigDefaults.ts` + `src/core/types.ts` — `usher.enabled` default true.
- Tests: unit (Usher + store) + boot-path route tests + the discoverability scan
  now includes `usherRoutes.ts`.

**Under-block**: The Usher only *emits suggestions to a pull surface* — it blocks
nothing. Its checks are gated (pre-filter, shed, rate ceiling) and every gate
fails toward "no signal", so it can't suppress anything either. RefIds are
validated against the candidate set (a poisoned/hallucinated id is dropped).

**Over-block**: None possible — there is no `block`/`inject` path in the code.
A false signal costs one line on a side board the consumer pulls.

**Level-of-abstraction fit**: The Usher reuses the established seam
(`onMessageLogged`), the topic-intent store's faded tail (observation-tier refs),
the queued subscription provider (never a raw client), and the capture loop's
pre-filter — it adds a watcher + a pull surface, not a new subsystem. "Faded" is
defined precisely as below-briefing-tier (observation), the genuine re-warm case.

**Signal vs authority (defining constraint)**: The Usher is a pure signal
producer. Authority to act on a signal (mid-task injection) is withheld for rung
5, which the spec makes conditional on the Usher's measured precision. The surface
is PULL (endpoint/dashboard), never a chat push — so even a noisy Usher can't
train anyone to tune it out (Near-Silent).

**Interactions**:
- Chained AFTER the capture loop on the single-assignment `onMessageLogged`
  property (prior callback preserved — verified by the wiring-integrity source
  guard). Fire-and-forget (`void usherLoop(...)`) so Usher latency never reaches
  the delivery path.
- One fast-tier LLM call per substantive USER turn, background lane on the shared
  LlmQueue, rate-limited (20/60s/topic), skipped under QuotaTracker pressure, and
  skipped entirely when the topic has no faded candidates — same cost envelope as
  capture. Agent turns are skipped (capture handles those).
- `precision = acted/fired` on `/usher/metrics` is the read that rung 5's spec
  will cite as its precondition; pairs with the human-as-detector miss-map.
- Construction broadened nothing — the assembler/capture wiring is unchanged; the
  Usher is purely additive within the existing `sharedIntelligence` block.

**External surfaces**: `GET /usher/signals`, `GET /usher/metrics` (INTERNAL
prefix). New config `usher.enabled` (default true). New modules `Usher.ts`,
`UsherSignalStore.ts`. No injection, no chat push, no change to existing routes.

**Deferred (tracked)**: mid-task injection (`cwa-injection`, gated on this
rung's precision), per-tool-call seam (`cwa-usher-tool-seam`), capability/standards
descriptors as candidates (`cwa-capability-index-context`).

**Rollback cost**: Low, strictly additive. Remove the watcher wiring + routes +
store; nothing depends on it (rung 5 isn't built). Kill-switch `usher.enabled:
false` stops the watcher (routes 503). No data migration.

**Migration parity**: Additive watcher wiring + routes + config default
(existence-checked) + INTERNAL prefix — all server-side (every agent on update).
The signal store is created lazily; no schema migration. No hook/template/skill change.

**Convergence honesty**: Claude-authored + manual review; multi-model tooling
absent on host. The Usher is deliberately the safe half (signal-only, pull
surface, precision-measured before rung 5 earns authority), but a fuller review —
especially of the `acted` precision definition that gates rung 5 — remains
advisable before relying on it.
