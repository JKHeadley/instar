# Side-effects review — topic-intent auto-capture loop (rung 0)

**Scope**: Wire the topic-intent capture loop so the per-topic store actually
fills from live conversation (closing the "shipped but asleep" gap — the store,
read routes, and session-start briefing all shipped, but nothing ever invoked
`ingest()` on a real turn). Adds the adapter-agnostic capture "clerk", broader
context (rolling summary + established refs) feeding the extractor, cost
controls, prompt-injection-hardened extraction, the live wiring on the inbound
message path, and whole-loop observability. Spec:
`docs/specs/topic-intent-capture-loop.md` (converged iter 3, approved by justin).

**Files touched**:
- `src/core/TopicIntent.ts` — add `CaptureCounters` to `TelemetryCounters`
  (defaulted on read for back-compat) + `defaultCaptureCounters()` +
  `bumpCaptureCounters()` (atomic under the existing per-topic lock). Switch the
  two `withTopicLock` lock-dir removals to `SafeFsExecutor.safeRmdirSync`.
- `src/core/TopicIntentExtractor.ts` — `createLlmExtractFn` gains an optional
  `onDegrade(reason, topicId)` observability hook; still returns `[]` on every
  degrade path (degrade-safety unchanged).
- `src/core/TopicIntentCapture.ts` — NEW. The capture step: `isSubstantiveTurn`
  pre-filter (deterministic, fail-open) + canary; `createQueuedIntelligence`
  (queue-backed, subscription-transport); `captureTurn` + `createCaptureLoop`
  (rate-state-owning closure).
- `src/server/topicIntentRoutes.ts` — NEW `GET /topic-intent/:id/capture-metrics`
  (the whole-loop funnel); `briefing_served` metering on the briefing route;
  `arccheck_fired`/`arccheck_signalled` metering on the arccheck route.
- `src/server/CapabilityIndex.ts` — add `topic-intent` to `INTERNAL_PREFIXES`
  (operator-only; not a discoverable agent endpoint).
- `src/config/ConfigDefaults.ts` — `topicIntent.capture.enabled: true` in
  `SHARED_DEFAULTS` (auto-applies on init AND migration → migration parity).
- `src/core/types.ts` — add optional `topicIntent` to `InstarConfig`.
- `src/commands/server.ts` — construct the queue-backed extractor + capture loop
  and chain it onto `telegram.onMessageLogged` (preserving prior callbacks),
  gated on `sharedIntelligence && config.topicIntent.capture.enabled`.
- Tests: `tests/unit/TopicIntentCapture.test.ts`,
  `tests/integration/topic-intent-capture-routes.test.ts`,
  `tests/e2e/topic-intent-capture-lifecycle.test.ts`.
- `docs/specs/06-state-detector-registry.md` — NEW registry; pre-filter entry.

**Under-block**: The pre-filter is fail-open — when unsure it passes the turn to
the LLM, so it cannot silently swallow a substantive turn on an ambiguous input.
Its only confident skips are empty/whitespace, whole-message bare acks, and
agent sentinel/heartbeat lines (agent turns only). Risk of under-block (a real
turn skipped) is bounded to sentinel-format drift, which the canary guards.

**Over-block**: The only "block"-shaped behavior is the pre-filter skip and the
QuotaTracker shed. Over-skipping costs a missed cheap extraction, never a
delivery failure or a user-visible block. The canary asserts known substantive
turns (including ack-prefixed ones) are NOT skipped.

**Level-of-abstraction fit**: The capture step is adapter-agnostic — it takes a
generic `CaptureTurnEntry`, not a Telegram type; Telegram is merely the first
wiring (other adapters tracked as `cwa-multi-adapter-capture`). The store stays
the single authority for persistence/projection; the extractor owns extraction;
the capture helper only orchestrates. Transport is delegated to the injected
`sharedIntelligence` provider (subscription/REPL-pool) through the shared
`LlmQueue` — capture never reaches for a raw API client.

**Signal vs authority**: Capture only RECORDS (append-only evidence); it has no
blocking authority. ArcCheck SIGNALS; neither blocks a send. The pre-filter is a
brittle low-context detector emitting a skip signal, never a gate. This matches
`[[feedback_signal_vs_authority]]`.

**Interactions**:
- `telegram.onMessageLogged` is a single-assignment property already chained by
  PresenceProxy, human-as-detector, and the keep-watching detector. The capture
  wiring preserves the prior callback (`const before = ...; cb = (e) => { before?.(e); capture(e); }`),
  verified by the e2e chain test (prior callback still fires).
- Capture is fire-and-forget (`void captureLoop(...)`) so extraction latency
  can never reach the delivery path (acceptance #4).
- Extraction is admitted on the LlmQueue **background** lane, so it yields to
  interactive (PresenceProxy/PromiseBeacon) work and shares the daily cap. On
  cap breach the queue throws → `createLlmExtractFn` catches → degrades to a
  `degraded_cap_or_error` tick.
- `bumpCaptureCounters`, `bumpTurn`, and `appendEvidence` each take the per-topic
  lock separately (multiple short acquisitions per turn). Correct under
  concurrency (the concurrency test still passes); accepted minor lock churn for
  v1 since capture runs off the delivery path.
- The briefing route now has a metering side-effect on a GET (writes
  `briefing_served`). Intentional per spec §10; best-effort and never blocks the
  fetch.

**External surfaces**:
- New endpoint: `GET /topic-intent/:topicId/capture-metrics` (operator-only).
- New config field: `topicIntent.capture.enabled` (default true; kill-switch).
- New additive `TopicIntentFile` fields (`telemetry.capture.*`), defaulted on
  read — old files load unchanged.
- New exported symbols in `TopicIntentCapture.ts`; no breaking change to
  existing exports.

**Cost (the one genuinely new ongoing cost)**: This is the product's first
always-on per-turn LLM path. Bounded by: the deterministic pre-filter (most
turns never reach the model), a per-topic rate ceiling (30/60s), the LlmQueue
daily cap (best-effort, per-process), and QuotaTracker load-shedding. ON by
default is ratified.

**Rollback cost**: Low. Config kill-switch `topicIntent.capture.enabled: false`
makes capture inert immediately (store + routes remain, as today). Full revert:
drop the server.ts wiring block + the new file; the store/routes/briefing return
to the inert pre-capture state. Additive store fields are harmless if left.
