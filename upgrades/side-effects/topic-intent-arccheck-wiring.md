# Side-effects review — topic-intent ArcCheck wiring (Layer 3)

Spec: `docs/specs/topic-intent-arccheck-wiring.md` (approved by justin 2026-05-28).

## What this change does

Wires the topic-intent ArcCheck (Layer 3) classifier, which existed but was
never connected. Two dead spots are closed:

1. `createTopicIntentRoutes` was constructed with no classifier, so the
   `/topic-intent/:topicId/arccheck` route always returned a degrade-open
   `{fire:false}` verdict.
2. No production caller invoked ArcCheck on the outbound path, so the agent
   never got a signal when a draft contradicted a tracked ref.

Live evidence the gap was real: `arccheck_fired = 0` on every topic, including
topic 13481 (258 turns, 81 refs). The founding drift ("we need a second
machine" while a SETTLED ref said the mac-mini was already configured) is the
exact `contradicts-settled` verdict ArcCheck was designed to emit.

## Files changed (in-scope) and their blast radius

- `src/core/TopicIntentArcCheck.ts` — ADD `createArcCheckClassifyFn(intelligence, onDegrade)`.
  Pure addition mirroring `createLlmExtractFn`. Degrade-safe: returns an empty
  classification (→ `{fire:false}`) on no-intelligence or throw, so it can
  never fire a false signal. Subscription transport (`model: 'fast'`,
  attribution `TopicIntentArcCheck`). No existing export changed.

- `src/server/topicIntentRoutes.ts` — route now accepts an `arcCheck` ArcCheck
  instance directly; KEEPS the legacy `arcCheckClassify` param (constructs a
  per-route instance from it) so all pre-existing callers/tests keep working
  unchanged. Backward-compatible; no behaviour change when neither is passed
  (still degrade-open).

- `src/server/AgentServer.ts` — ADD optional `topicIntentArcCheck` to
  `AgentServerOptions` + `RouteContext`; forward it into
  `createTopicIntentRoutes`. Additive; null/undefined preserves prior behaviour.

- `src/server/routes.ts` — `checkOutboundMessage` now collects an ArcCheck
  signal in-process (when `options.topicId` and `ctx.topicIntentArcCheck` are
  both present) under a 200ms hard timeout via `Promise.race`. On timeout or
  throw the signal is simply omitted — identical fail-skip shape to the
  existing dedup detector. ArcCheck is SIGNAL-ONLY: it populates
  `signals.arcCheck`; the MessagingToneGate retains all block authority. No
  new block path. Delivery is never slowed (concurrent-eligible + bounded).

- `src/core/MessagingToneGate.ts` — ADD `arcCheck` field to `ToneReviewSignals`
  + render it in `renderSignals`. Only renders when `fire === true`. The gate
  may fold the rewrite hint into its review; it does NOT gain a new block rule.

- `src/config/ConfigDefaults.ts` + `src/core/types.ts` — ADD
  `topicIntent.arccheck.enabled` (default `true`). Migration parity: existing
  agents pick it up via the canonical `applyDefaults` path in
  `PostUpdateMigrator.migrateConfig` (existence-checked, idempotent). Kill
  switch: `false` leaves the route mounted but the classifier dark and skips
  the in-process call.

- `src/commands/server.ts` — construct ONE `ArcCheck` instance (gated on
  `sharedIntelligence && topicIntent.arccheck.enabled`), reusing the same
  queued-intelligence transport as the capture loop, declared at outer scope
  so it reaches the `AgentServer` constructor. Sets
  `globalThis.__instarTopicIntentArcCheckWired` for the wiring-integrity test.

## Failure modes considered

- **Outbound latency regression** — bounded by the 200ms `Promise.race`
  timeout; ArcCheck runs concurrent-eligible with other signal collection and
  is wrapped in try/catch. Worst case: the signal is absent and the gate
  behaves exactly as today.
- **False block** — impossible by construction: ArcCheck is signal-only; the
  tone gate has no new block rule keyed on `signals.arcCheck`.
- **Cost** — second always-on per-turn LLM path (capture being the first).
  Bounded by the shared `LlmQueue` background lane + daily cap; degrades to a
  no-op on cap breach.
- **Prompt injection** — `buildArcCheckPrompt` renders refs in a structured
  block; the classifier is conservative-by-prompt and parse-tolerant
  (`parseArcCheckResponse` returns empty arrays on malformed output).

## Migration parity

Server-side only. One new config default via the canonical defaults path. No
hook/template/skill/settings change. No `PostUpdateMigrator` surgery beyond the
config default.

## Rollback

Flip `topicIntent.arccheck.enabled = false` (classifier construction is gated;
in-process call is skipped). Code rollback: remove the AgentServer wire, the
classifier creator, and the `signals.arcCheck` channel — everything else
reverts to inert, as today.

## Tests

- Unit: `createArcCheckClassifyFn` degrade paths + transport attribution
  (tests/unit/TopicIntent-arccheck.test.ts, +4).
- Unit: MessagingToneGate renders/omits the ArcCheck signal
  (tests/unit/MessagingToneGate.test.ts, +2).
- E2E: mac-mini-drift regression pin + wiring-integrity source guards
  (tests/e2e/topic-intent-arccheck-lifecycle.test.ts, new, 5 tests).
- All 7 pre-existing topic-intent test files remain green after the
  backward-compatible route reshape.
