---
phase: 01-layer1
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/core/TopicIntent.ts
  - src/core/TopicIntentExtractor.ts
  - src/core/PendingConfirmationManager.ts
  - src/core/topicIntent.types.ts
  - src/server/routes.ts
  - src/server/topicIntentRoutes.ts
  - src/commands/server.ts
  - tests/unit/TopicIntent-projection.test.ts
  - tests/unit/TopicIntent-store.test.ts
  - tests/unit/TopicIntentExtractor.test.ts
  - tests/unit/PendingConfirmationManager.test.ts
  - tests/integration/topic-intent-routes.test.ts
  - tests/e2e/topic-intent-lifecycle.test.ts
  - tests/fixtures/topic-intent/qalatra-9235.json
  - tests/fixtures/topic-intent/gci-luna-365.json
autonomous: true
requirements:
  - L1-DATA-MODEL          # EstablishedRef / EvidenceEvent / PendingConfirmation types
  - L1-PROJECTION          # confidence projection (already implemented + tested)
  - L1-EXTRACTOR           # LLM extractor that emits EvidenceEvent records
  - L1-PENDING-LIFECYCLE   # PendingConfirmation TTL / queue / dedup / retry-with-sharpening
  - L1-STORAGE             # .instar/topic-intent/<topicId>.json append-only store
  - L1-API-DIAGNOSTICS     # GET /topic-intent/<topicId>/diagnostics (Bearer-authed)
  - L1-TELEMETRY           # counters per spec
  - L1-FRAMEWORK-AGNOSTIC  # works under Claude Code AND Codex (no framework-specific deps)
  - L1-TESTS-TIER1         # unit tests, all signal paths
  - L1-TESTS-TIER2         # integration: HTTP routes return real projection data
  - L1-TESTS-TIER3         # e2e: full lifecycle through real server boot path

must_haves:
  truths:
    - "An ingested user message about a new fact creates an EstablishedRef at confidence 0.40 (tentative tier)."
    - "An accumulation of agent-only signals on a refId cannot push confidence at or above 0.7 — the projection clamps to 0.69 and increments confidence_clamp_authority_total."
    - "Two extractor signals from the same sourceMessageId about the same refId count as ONE evidence episode, with the larger absolute delta winning."
    - "A PendingConfirmation queue at depth 3 silently drops the 4th queued item and increments pending_confirm_queue_dropped_total."
    - "Two ambiguous answers in a row to a sharpened question mark the PendingConfirmation status=abandoned and increment pending_confirm_abandoned_total."
    - "GET /topic-intent/<topicId>/diagnostics with valid Bearer auth returns 200 with current projection + recent events + tier distribution + outstanding/queued pending. Missing/wrong auth returns 401."
    - "The qalatra-9235 and GCI-Luna-365 canonical fixtures replayed against the extractor produce the EvidenceEvent records the spec predicts."
    - "Layer 1 is reachable from Codex sessions: a server booted without Claude Code installed exposes /topic-intent/* and the extractor runs against the configured IntelligenceProvider."
  artifacts:
    - path: "src/core/TopicIntent.ts"
      provides: "EstablishedRef + EvidenceEvent + projection + TopicIntentStore (already present; extended with pending-confirmation helpers)"
      contains: "export function projectConfidence"
    - path: "src/core/TopicIntentExtractor.ts"
      provides: "TopicIntentExtractor — LLM-backed evidence emitter (Tier 1 supervised)"
      exports: ["TopicIntentExtractor", "extractFromMessage"]
    - path: "src/core/PendingConfirmationManager.ts"
      provides: "Pending lifecycle: enqueue/dequeue, dedup-by-refId, depth cap, TTL clock at dequeue, revalidation, answer interpretation, sharpen-retry, terminal-state transitions"
      exports: ["PendingConfirmationManager"]
    - path: "src/server/topicIntentRoutes.ts"
      provides: "GET /topic-intent/:topicId/diagnostics route factory"
      exports: ["createTopicIntentRoutes"]
    - path: "tests/unit/TopicIntentExtractor.test.ts"
      provides: "Tier 1 unit coverage for extractor: deterministic prompt shape, validator rejection, dedup at insert time"
      min_lines: 80
    - path: "tests/unit/PendingConfirmationManager.test.ts"
      provides: "Tier 1 unit coverage for lifecycle: queue depth, dedup, TTL-at-dequeue, sharpen-retry, all four terminal states"
      min_lines: 120
    - path: "tests/integration/topic-intent-routes.test.ts"
      provides: "Tier 2 HTTP coverage: 200 with projection, 401 without auth, 404 for unknown topic, real Express mount via createRoutes"
      min_lines: 80
    - path: "tests/e2e/topic-intent-lifecycle.test.ts"
      provides: "Tier 3 lifecycle: production server boot path, ingest synthetic messages through extractor, observe tier transitions through HTTP, replay both canonical fixtures"
      min_lines: 150
  key_links:
    - from: "src/server/routes.ts"
      to: "src/server/topicIntentRoutes.ts"
      via: "createRoutes mounts createTopicIntentRoutes(ctx)"
      pattern: "createTopicIntentRoutes"
    - from: "src/commands/server.ts"
      to: "src/core/TopicIntentExtractor.ts"
      via: "constructor receives sharedIntelligence (IntelligenceProvider) at server startup"
      pattern: "new TopicIntentExtractor.*sharedIntelligence"
    - from: "src/core/PendingConfirmationManager.ts"
      to: "src/core/TopicIntent.ts"
      via: "emits pending-confirm-positive / pending-confirm-negative EvidenceEvents through TopicIntentStore.appendEvidence"
      pattern: "appendEvidence.*pending-confirm-"
    - from: "tests/e2e/topic-intent-lifecycle.test.ts"
      to: "src/commands/server.ts boot path"
      via: "spawns the real server initialization sequence (NOT a mock app.use)"
      pattern: "startServer|bootServer"

user_setup: []
---

<objective>
Ship Layer 1 of the Topic Intent Layer: the confidence-tracking core that converts conversation turns into per-topic semantic state. Projection + types + store are already implemented in `src/core/TopicIntent.ts` and covered by 14 passing unit tests; this plan adds the live extractor, the pending-confirmation lifecycle, the diagnostics HTTP surface, and the integration + E2E test tiers that prove the feature is alive in production boot.

Purpose: Without Layer 1, Layers 2 (resume briefing) and 3 (ArcCheck pre-send) have nothing to read. Layer 1 is the data substrate. It must be framework-agnostic (Claude Code + Codex), survive the existing zero-failure standard, and ship with all three test tiers per the Testing Integrity Standard.

Output: A reachable `/topic-intent/<topicId>/diagnostics` endpoint backed by a running extractor + pending-confirmation lifecycle, with telemetry counters, persisted under `.instar/topic-intent/<topicId>.json`, fully covered by unit + integration + E2E tests.
</objective>

<execution_context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/phases/01-layer1/PLAN.md
</execution_context>

<context>
@CLAUDE.md
@.planning/REQUIREMENTS.md
@.planning/PROJECT.md
@docs/specs/topic-intent-layer.md
@src/core/TopicIntent.ts
@tests/unit/TopicIntent-projection.test.ts

<interfaces>
<!-- Existing exports the executor MUST consume (already on disk, do not redefine): -->

From src/core/TopicIntent.ts:
- export type RefKind = 'fact' | 'decision'
- export type EvidenceKind = 'extract-user' | 'extract-agent' | 'user-reref' | 'agent-reref'
    | 'user-affirm' | 'pending-confirm-positive' | 'pending-confirm-negative'
    | 'contradiction' | 'conflict-mark' | 'sharpen-retry-issued'
- export interface EvidenceEvent { eventId, refId, kind, sourceMessageId, userAuthored, at, delta, meta? }
- export interface EstablishedRef { refId, arcId, topicId, kind, text, confidence, evidence[], lastReinforcedAt, status, createdAt, updatedAt }
- export interface PendingConfirmation { pendingId, topicId, arcId, refId, propositionText, questionText, sentAtTurn, sentAtTime, ttl{turns,hours}, retries, maxRetries, status, queuedAtTime?, dequeuedAtTime?, answeredAtTime?, answerVerdict? }
- export interface TopicIntentFile { topicId, refs, pending{outstanding,queue}, telemetry, schemaVersion }
- export interface TelemetryCounters { extraction_total, evidence_event_total, confidence_clamp_authority_total, pending_confirm_created_total, pending_confirm_queue_dropped_total, pending_confirm_abandoned_total, pending_confirm_expired_total, pending_confirm_answered_total }
- export function projectConfidence(evidence, lastReinforcedAt, nowMs?) → ProjectionResult
- export function buildEvent(refId, kind, sourceMessageId, opts?) → EvidenceEvent
- export class TopicIntentStore { constructor(stateDir); load(topicId); save(file); appendEvidence(topicId, refId, ev, refInit?); getProjection(topicId, refId, nowMs?); getRefsAtOrAbove(topicId, minTier, nowMs?); read(topicId); }
- export const TOPIC_INTENT_CONSTANTS = { DECAY_HALF_LIFE_DAYS, DECAY_GRACE_DAYS, DECAY_LAMBDA, AUTHORITY_THRESHOLD, AUTHORITY_CLAMP, TENTATIVE_THRESHOLD, SIGNAL_CAPS, AFFIRM_PER_REF_PER_24H_LIMIT, AFFIRM_PER_MESSAGE_REF_LIMIT, MS_PER_DAY }

From src/core/types.ts:
- export interface IntelligenceProvider { evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> }
- export interface IntelligenceOptions { model?: 'fast'|'balanced'|'capable'; maxTokens?: number; temperature?: number }
  // Use model: 'fast' for the extractor (Tier 1 supervision per spec).

From src/server/routes.ts:
- export function createRoutes(ctx: RouteContext): Router
- RouteContext exposes: config (with stateDir, authToken), startTime, stopGateDb — extended via DI for new managers when needed.

From src/commands/server.ts startup sequence (lines ~2025-2294):
- sharedIntelligence: IntelligenceProvider | undefined is constructed early; if undefined, extractor must degrade to no-op + telemetry tick (NOT throw). Wire TopicIntentExtractor + PendingConfirmationManager AFTER sharedIntelligence is resolved.

Storage convention (matches existing `.instar/topic-resume-map.json` pattern): single JSON file per topic at `<stateDir>/topic-intent/<topicId>.json`; write through TopicIntentStore.save (already atomic enough for our single-writer awake-machine model per spec §"Append safety").
</interfaces>
</context>

<tasks>

<!-- ───── TASK 1: LLM extractor + insert-time guards ───── -->

<task type="auto" tdd="true">
  <name>Task 1: TopicIntentExtractor with insert-time dedup, validator, and degrade-safe fallback</name>
  <files>src/core/TopicIntentExtractor.ts, tests/unit/TopicIntentExtractor.test.ts</files>
  <behavior>
    - Test 1: Given a substantive user message containing one new decision proposition and an existing topic file with no refs, extractor returns one extract-user EvidenceEvent (delta +0.40, userAuthored=true, sourceMessageId matches input) and appends it via TopicIntentStore.appendEvidence — refId becomes tentative.
    - Test 2: Given an agent message containing a re-reference to an existing refId, extractor returns one agent-reref event (delta +0.01, userAuthored=false); cap enforcement is the projection's job, not the extractor's.
    - Test 3: Given a user message that BOTH re-references AND affirms the same refId, extractor emits BOTH events with identical sourceMessageId — the projection dedup (already tested) collapses them. Verify the extractor does NOT pre-collapse.
    - Test 4: Given a user message that issues a contradiction ("actually we're going with Path B"), extractor emits one contradiction event (delta -0.60) against the contradicted refId AND one extract-user event (delta +0.40) for the replacement proposition. Both episodes count as user-authored.
    - Test 5: Validator rejects extractor output that fails JSON-shape check or anchors to a nonexistent refId in non-extract events; rejection emits NO EvidenceEvent and increments a `topic_intent_extractor_validator_reject_total` telemetry counter.
    - Test 6: If sharedIntelligence is undefined OR throws, extractor returns an empty event array (degrade open), logs a single warning, and increments `topic_intent_extractor_degraded_total`. NEVER throws to the caller.
    - Test 7: AFFIRM_PER_MESSAGE_REF_LIMIT (3 distinct refIds receiving affirmation in one message) is enforced at insert time — a 4th affirmation in the same sourceMessageId is dropped with telemetry. (Defense-in-depth alongside the projection-time per-day cap.)
  </behavior>
  <action>Create `src/core/TopicIntentExtractor.ts`. Class `TopicIntentExtractor` constructor takes `{ store: TopicIntentStore, intelligence?: IntelligenceProvider, logger? }`. Public method `extractFromMessage(input: { topicId, messageId, speaker: 'user'|'agent', text, turn, knownRefs: EstablishedRef[] }): Promise<EvidenceEvent[]>` — builds a deterministic prompt that lists knownRefs by refId + propositionText and asks the LLM (model: 'fast') for a strict JSON envelope: `{ newRefs: [{kind, text, proposition}], references: [{refId, signalKind}], contradictions: [{refId, replacementText?}], affirmations: [{refId}] }`. The Tier 1 supervisor pattern: a second `evaluate()` call with model: 'fast' validates the JSON against the known-ref list and rejects hallucinated refIds. Convert validated output into EvidenceEvent records via `buildEvent()` and append through `store.appendEvidence(topicId, refId, ev, refInit)`. Insert-time guards: deterministic `sourceMessageId` (use input.messageId verbatim); AFFIRM_PER_MESSAGE_REF_LIMIT enforced before insert. Degrade-safe: if `intelligence === undefined`, return `[]` immediately and tick `topic_intent_extractor_degraded_total`. The extractor MUST be framework-agnostic — no Claude/Codex-specific imports. Wire telemetry through the existing TelemetryCounters object on TopicIntentFile (add two counters: `extractor_validator_reject_total`, `extractor_degraded_total`). Unit tests under `tests/unit/TopicIntentExtractor.test.ts` use a stub IntelligenceProvider that returns canned JSON. RED first (write all 7 tests, watch them fail), GREEN minimum (just enough code to pass), REFACTOR if needed.</action>
  <verify>
    <automated>pnpm vitest run tests/unit/TopicIntentExtractor.test.ts</automated>
  </verify>
  <done>All 7 tests pass; extractor degrades safely when IntelligenceProvider is absent; telemetry counters tick correctly; no Claude/Codex-specific imports.</done>
</task>

<!-- ───── TASK 2: PendingConfirmation lifecycle ───── -->

<task type="auto" tdd="true">
  <name>Task 2: PendingConfirmationManager — queue, TTL-at-dequeue, sharpen-retry, terminal states</name>
  <files>src/core/PendingConfirmationManager.ts, tests/unit/PendingConfirmationManager.test.ts</files>
  <behavior>
    - Test 1: `enqueue()` with no outstanding: item promotes immediately to `outstanding`, status='pending', dequeuedAtTime set, sentAtTime/sentAtTurn captured, telemetry `pending_confirm_created_total` increments.
    - Test 2: `enqueue()` with an outstanding item: new item goes to queue (FIFO); queue can hold up to 3.
    - Test 3: Queue depth cap: 4th queued item is silently dropped, `pending_confirm_queue_dropped_total` increments, the affected refId stays tentative.
    - Test 4: Queue dedup by refId: enqueuing a second confirmation for the same refId while one is queued or outstanding is dropped silently with telemetry; no second record created.
    - Test 5: TTL clock starts at DEQUEUE time, not enqueue time. A queued item never dequeued before drop has `dequeuedAtTime` undefined; its TTL is not consumed.
    - Test 6: Revalidation at dequeue: if the refId is no longer tentative (became authoritative or was retracted), drop silently with telemetry counter; the queued item never surfaces.
    - Test 7: Answer 'positive' transitions outstanding → status='answered', emits `pending-confirm-positive` EvidenceEvent via store (+0.50, userAuthored=true) on the bound refId, ticks `pending_confirm_answered_total{positive}`, then auto-dequeues the next queued item (with revalidation).
    - Test 8: Answer 'negative' transitions outstanding → status='answered', emits `pending-confirm-negative` event (-0.70, userAuthored=true), ticks `pending_confirm_answered_total{negative}`, auto-dequeues next.
    - Test 9: Answer 'ambiguous' on retries=0 → sharpen-retry-issued event recorded; retries becomes 1; outstanding stays 'pending' with a new sharpened questionText; no state-moving evidence emitted.
    - Test 10: Answer 'ambiguous' on retries=maxRetries(2) → outstanding transitions to status='abandoned', `pending_confirm_abandoned_total` increments, refId stays in its current tier, auto-dequeues next.
    - Test 11: Answer 'non-responsive' followed by 5 substantive turns OR 24h elapsed → expire(): status='expired', `pending_confirm_expired_total` increments, no evidence emitted, auto-dequeues next.
    - Test 12: Re-entry safety: calling enqueue() then answer() twice on the same pendingId is idempotent — second call is a no-op (status check before mutation).
  </behavior>
  <action>Create `src/core/PendingConfirmationManager.ts`. Class `PendingConfirmationManager` constructor: `{ store: TopicIntentStore, intelligence?: IntelligenceProvider, clock?: () => number }`. Public methods: `enqueue(record: NewPendingInput): {accepted: boolean, reason?: 'queue-full'|'dedup'|'accepted'}`, `dequeueNextIfPossible(topicId): PendingConfirmation | null` (called internally and explicitly by sweep), `interpretAnswer(topicId, userReply: {text, messageId, turn}): Promise<'positive'|'negative'|'ambiguous'|'non-responsive'>` (delegates to intelligence with a strict-JSON prompt and same Tier-1 validator pattern; degrades to 'non-responsive' if intelligence absent), `applyAnswer(topicId, verdict)`, `sweepExpired(topicId, nowMs?)`. All state lives on `TopicIntentFile.pending`; mutate-and-save via the store. Revalidation: read the current projection for the refId; if tier !== 'tentative', drop. Status transitions are guarded; idempotent. Use `clock` for time tests (defaults to Date.now). Unit tests under `tests/unit/PendingConfirmationManager.test.ts` mock the clock and a stub intelligence provider that returns canned verdicts. Per spec §"Pending-Confirmation Records v9–v10" and §"Queue lifecycle (v10)" — every behavior in the table maps to a numbered test above. RED → GREEN → REFACTOR.</action>
  <verify>
    <automated>pnpm vitest run tests/unit/PendingConfirmationManager.test.ts</automated>
  </verify>
  <done>All 12 tests pass; all four terminal states (answered, abandoned, expired, dropped) reachable; telemetry counters accurate; idempotency guard prevents double-mutation; lifecycle runs without an IntelligenceProvider in the degrade-safe path.</done>
</task>

<!-- ───── TASK 3: Store extensions for pending lifecycle + telemetry plumbing ───── -->

<task type="auto" tdd="true">
  <name>Task 3: Extend TopicIntentStore with pending-confirmation persistence and counter helpers</name>
  <files>src/core/TopicIntent.ts, tests/unit/TopicIntent-store.test.ts</files>
  <behavior>
    - Test 1: `setOutstanding(topicId, pending)` and `enqueuePending(topicId, pending)` round-trip to disk and survive a fresh `load(topicId)`.
    - Test 2: `incrementCounter(topicId, counterName, by=1, subkey?)` ticks both flat counters (e.g. pending_confirm_created_total) and keyed counters (e.g. pending_confirm_answered_total['positive']) atomically — load-modify-save.
    - Test 3: A corrupt JSON file at `<stateDir>/topic-intent/<topicId>.json` is recovered to an empty file skeleton (already covered in load(); add a regression test that the recovery resets telemetry to zero and logs a recovery event).
    - Test 4: Two refIds with conflicting authoritative-tier projections trigger `markConflict(refIds, reason)`, emitting `conflict-mark` events on both and setting `status='conflicted'`. The projection (already tested) clamps both to <=0.3 per spec via the existing clamp rule.
    - Test 5: `getDiagnostics(topicId)` returns a serializable snapshot: `{ topicId, refs: [{...EstablishedRef, projection: ProjectionResult}], pending: {outstanding, queue}, telemetry, tierDistribution: {observation, tentative, authoritative}, conflicts: refId[] }` — exactly the shape the diagnostics route will return.
  </behavior>
  <action>Extend the existing `TopicIntentStore` in `src/core/TopicIntent.ts` (do NOT rewrite the file — Edit only). Add methods: `setOutstanding`, `enqueuePending`, `clearOutstanding`, `dropFromQueue`, `incrementCounter`, `markConflict(topicId, refIds, reason)`, `getDiagnostics(topicId, nowMs?)`. Conflict detection helper `detectConflicts(topicId, nowMs?)` scans refs whose projections are both >=0.7 and whose text are flagged as opposites by the LLM (out of scope for Task 3; the helper exists but only fires when caller passes an explicit pair). Add unit tests at `tests/unit/TopicIntent-store.test.ts` using a temp dir per test (vitest's `tmpdir`). Maintain backward compatibility with the existing 14 passing projection tests (no signature changes to projectConfidence/buildEvent/qualifiesAsUserAuthoredEpisode).</action>
  <verify>
    <automated>pnpm vitest run tests/unit/TopicIntent-projection.test.ts tests/unit/TopicIntent-store.test.ts</automated>
  </verify>
  <done>All 5 new store tests pass; the existing 14 projection tests still pass (zero regressions); getDiagnostics returns the exact shape the route expects.</done>
</task>

<!-- ───── TASK 4: HTTP diagnostics route + DI wiring ───── -->

<task type="auto" tdd="true">
  <name>Task 4: GET /topic-intent/:topicId/diagnostics route + server.ts DI wiring</name>
  <files>src/server/topicIntentRoutes.ts, src/server/routes.ts, src/commands/server.ts, tests/integration/topic-intent-routes.test.ts</files>
  <behavior>
    - Test 1 (Tier 2): GET /topic-intent/12345/diagnostics with valid Bearer auth returns 200 + the getDiagnostics() shape; verify against a topic seeded via direct store.appendEvidence calls.
    - Test 2 (Tier 2): GET without Authorization header returns 401 (the existing requireAuth middleware applies — verify it's wired).
    - Test 3 (Tier 2): GET with valid auth but unknown topicId returns 200 with empty skeleton (matches store.load behavior — never 404 for absent state, that's the file-based-state convention).
    - Test 4 (Tier 2): GET with non-numeric topicId returns 400 with `{error: 'invalid topicId'}`.
    - Test 5 (Tier 2): GET /topic-intent/12345/diagnostics never includes raw user message text in evidence.meta beyond what the spec allows; verify a redaction guard is in place (defense against accidental PII bleed through diagnostics).
    - Test 6 (Tier 2): Capabilities endpoint (existing `/capabilities`) advertises `topicIntent: {available: true, version: 1}` so agents can self-discover the feature.
  </behavior>
  <action>Create `src/server/topicIntentRoutes.ts` exporting `createTopicIntentRoutes(ctx: { store: TopicIntentStore }): Router` with one route `GET /:topicId/diagnostics`. Apply input validation (topicId numeric, max 12 digits). Call `ctx.store.getDiagnostics(Number(topicId))` and return JSON. Mount in `createRoutes` (src/server/routes.ts) at `/topic-intent` BEFORE the catch-all 404, AFTER the auth middleware (so Bearer is enforced). Extend the `/capabilities` response with `topicIntent: { available: !!ctx.topicIntentStore, version: 1 }`. In `src/commands/server.ts`, after `sharedIntelligence` is resolved (around line 2062), construct `const topicIntentStore = new TopicIntentStore(config.stateDir!)`, `const topicIntentExtractor = new TopicIntentExtractor({ store: topicIntentStore, intelligence: sharedIntelligence })`, `const pendingConfirmManager = new PendingConfirmationManager({ store: topicIntentStore, intelligence: sharedIntelligence })`. Pass `topicIntentStore` into the route context. Integration test at `tests/integration/topic-intent-routes.test.ts` mounts `createRoutes()` on a real Express app (the established pattern in `tests/integration/messaging-routes.test.ts`), seeds state via store, asserts JSON shape, auth enforcement, edge cases. Per CLAUDE.md: this is the Tier 2 test tier that proves "the API route works when the feature is available."</action>
  <verify>
    <automated>pnpm vitest run tests/integration/topic-intent-routes.test.ts</automated>
  </verify>
  <done>All 6 integration tests pass; route is reachable via Bearer auth; /capabilities advertises topicIntent; server.ts DI wiring constructs the extractor + manager only after sharedIntelligence resolution (or with intelligence=undefined for degrade-open).</done>
</task>

<!-- ───── TASK 5: E2E lifecycle + canonical-fixture replay ───── -->

<task type="auto" tdd="true">
  <name>Task 5: E2E lifecycle test + qalatra/GCI canonical fixtures</name>
  <files>tests/e2e/topic-intent-lifecycle.test.ts, tests/fixtures/topic-intent/qalatra-9235.json, tests/fixtures/topic-intent/gci-luna-365.json</files>
  <behavior>
    - Test 1 (Tier 3 — "feature is alive"): Boot the real server via the production initialization path (mirror `tests/e2e/messaging-lifecycle.test.ts`), hit `GET /topic-intent/9999/diagnostics` with valid Bearer, assert 200 + skeleton shape. This is the single most important test for any feature with API routes (per CLAUDE.md).
    - Test 2 (Tier 3): Inject a synthetic 5-turn conversation through the extractor (with a stub IntelligenceProvider that returns canned JSON matching the fixture), observe the diagnostics endpoint reflect the new EstablishedRefs with the expected tiers.
    - Test 3 (Tier 3): qalatra-9235 canonical fixture replay — load the fixture's pre-canned messages, run through extractor, assert the projection produces the EvidenceEvent records the spec predicts: arc-drift scenario where the user states a goal early and later turns are mosaic tiles; verify the statedGoal extract-user event lands as expected and subsequent user-reref events accumulate confidence into tentative.
    - Test 4 (Tier 3): GCI/Luna-365 canonical fixture replay — load fixture's pre-canned conversation; verify the agent's mid-debugging Path B proposal triggers a contradiction event against the authoritative Path A refId (which got there via prior user-authored episodes seeded in the fixture); assert Path A confidence drops below authoritative and the conflict is surfaced via getDiagnostics.
    - Test 5 (Tier 3): Codex-framework reachability — boot the server with `claudePath` set to a path that does NOT exist (simulates a Codex-only host where Claude Code is absent); verify `/topic-intent/:topicId/diagnostics` still returns 200 (the extractor degrades open via `intelligence=undefined`, but the store + route are framework-agnostic and remain alive).
    - Test 6 (Tier 3): Lifecycle round-trip — ingest a message → confidence 0.40 (tentative) → create PendingConfirmation via PendingConfirmationManager.enqueue → answer 'positive' → assert confidence becomes 0.90 (authoritative) → assert diagnostics reflects the tier transition AND the pending record is in status='answered'.
    - Test 7 (Tier 3): Telemetry persistence — perform 5 ingestions, kill the in-process store instance, re-instantiate it, assert telemetry counters survive (file-based state, not in-memory).
  </behavior>
  <action>Create `tests/fixtures/topic-intent/qalatra-9235.json` and `gci-luna-365.json` as the canonical incident replays per spec §"Daily canonical-fixtures probe" — minimal JSON of the shape `{ topicId, name, messages: [{turn, speaker, text, messageId}], expectedRefs: [{kind, text, expectedTier}], expectedEvents: [{kind, refId, deltaSign}] }`. Both fixtures seed the failure modes described in spec §"Problem" (qalatra arc drift, GCI decision amnesia). Create `tests/e2e/topic-intent-lifecycle.test.ts` using the existing E2E lifecycle pattern (look at `tests/e2e/messaging-lifecycle.test.ts` for the boot-the-real-server-then-hit-routes pattern — DO NOT mock; this is Tier 3 per CLAUDE.md). Use a stub IntelligenceProvider that returns deterministic canned JSON keyed by sourceMessageId so the test is reproducible without network. The Tier 3 "feature is alive" test (Test 1) is non-negotiable per CLAUDE.md.</action>
  <verify>
    <automated>pnpm vitest run tests/e2e/topic-intent-lifecycle.test.ts</automated>
  </verify>
  <done>All 7 E2E tests pass; both canonical fixtures replay successfully and produce the spec-predicted EvidenceEvents; the Tier 3 "feature is alive" check returns 200 (not 503); Codex-host degradation path verified.</done>
</task>

<!-- ───── TASK 6: Zero-failure + framework-parity verification ───── -->

<task type="auto">
  <name>Task 6: Run the full suite, verify zero failures, verify framework parity</name>
  <files>(verification only — no file modifications)</files>
  <action>Run the full test suite (`pnpm test`) and confirm zero failures per the Zero-Failure Standard (CLAUDE.md: "Every session must leave the test suite with zero failures"). Run `pnpm build` to verify the TypeScript compiles cleanly with no new errors. Run `grep -rn "claude-code\|claude_code\|CLAUDE_CODE" src/core/TopicIntent.ts src/core/TopicIntentExtractor.ts src/core/PendingConfirmationManager.ts src/server/topicIntentRoutes.ts | grep -v '^//' | grep -v '\*'` — this MUST return zero matches (Layer 1 must be framework-agnostic; any Claude-specific import or string is a parity violation that breaks Codex hosts). Run the unit + integration + e2e suites in order and confirm each tier passes independently (Testing Integrity Standard requires all three tiers green). If any test fails, treat it as a current failure (no "pre-existing failure" label allowed per CLAUDE.md) and fix before declaring Layer 1 done.</action>
  <verify>
    <automated>pnpm test 2>&1 | tail -20 && pnpm build 2>&1 | tail -5 && (grep -rn "claude-code\|claude_code\|CLAUDE_CODE" src/core/TopicIntent.ts src/core/TopicIntentExtractor.ts src/core/PendingConfirmationManager.ts src/server/topicIntentRoutes.ts | grep -v '^[[:space:]]*//' | grep -v '\*' | wc -l | awk '{exit ($1 > 0)}')</automated>
  </verify>
  <done>pnpm test reports 0 failures, pnpm build succeeds with 0 errors, framework-agnostic grep returns 0 matches in Layer 1 source files. The Tier 3 "feature is alive" test, the canonical-fixture replays, and the degrade-open Codex path are all green.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| HTTP client → /topic-intent/* | Untrusted client crosses Bearer-auth boundary; raw input topicId reaches store |
| User message → extractor LLM | Untrusted natural language reaches a model that emits "structured" JSON that mutates durable state |
| Extractor output → store.appendEvidence | LLM output is parsed as JSON and converted to EvidenceEvent records that affect confidence |
| Standby machine → store file | Spec disallows cross-machine writes; standby attempts should 409 (deferred to Layer 2/3) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-01 | Tampering | Extractor LLM hallucinates a refId in `references`/`contradictions`/`affirmations` and mutates the wrong ref | mitigate | Tier-1 validator (Task 1, Test 5) rejects events whose refId is not in the known-refs list. Telemetry on validator rejects. |
| T-01-02 | Elevation of Privilege | Politeness laundering: many agent-reref events push confidence into authoritative without user evidence | mitigate | Authority hard rule already enforced in projection (clamp at 0.69 without qualifying user-authored episode); existing test coverage; new agent-reref cap test in Task 3. |
| T-01-03 | Information Disclosure | Diagnostics endpoint leaks raw user message PII via evidence.meta | mitigate | Task 4 Test 5 — redaction guard on getDiagnostics; spec §"External surfaces" Bearer-auth only; no user-facing write endpoints. |
| T-01-04 | Denial of Service | A single user message that names 50 distinct refIds spams the per-message affirmation channel and dominates the projection | mitigate | AFFIRM_PER_MESSAGE_REF_LIMIT=3 enforced at insert time (Task 1 Test 7), defense-in-depth alongside projection-time caps. |
| T-01-05 | Repudiation | Conflicting writes from two machines produce silent state divergence (spec failover-split-brain case) | accept | Out of scope for Layer 1 per spec — single-writer awake-machine model. Layer 2/3 will address; conflict surfacing already in store.markConflict for Layer 3 consumption. |
| T-01-06 | Spoofing | An attacker hits /topic-intent/* without Bearer to fish for topic IDs | mitigate | Existing requireAuth middleware applied via createRoutes mounting position (Task 4 Test 2). |
| T-01-07 | Tampering | Corrupted JSON file at .instar/topic-intent/<topicId>.json poisons subsequent reads | mitigate | Store.load() already recovers to empty skeleton on parse error; Task 3 Test 3 adds regression coverage and a recovery telemetry tick. |
| T-01-SC | Tampering | npm package install for this phase | accept | No new npm packages required — feature uses only existing dependencies (node:crypto, node:fs, existing IntelligenceProvider). No supply-chain surface added. |

## Mitigation references
- Authority hard rule: src/core/TopicIntent.ts lines 259-265 (clamp logic) — verified by tests/unit/TopicIntent-projection.test.ts lines 112-136
- Insert-time guards: TopicIntentExtractor.extractFromMessage (Task 1)
- Bearer auth: existing middleware in src/server/middleware.ts mounted via createRoutes
- Telemetry counters on every guard fire — visible via /topic-intent/<topicId>/diagnostics
</threat_model>

<verification>
Overall phase checks (run in this order):

1. `pnpm vitest run tests/unit/TopicIntent-projection.test.ts` — the 14 baseline tests still pass (no regressions in projection math).
2. `pnpm vitest run tests/unit/` — all Layer 1 unit tests green (projection + store + extractor + pending manager).
3. `pnpm vitest run tests/integration/topic-intent-routes.test.ts` — Tier 2 HTTP coverage green; Bearer auth enforced; capabilities advertises topicIntent.
4. `pnpm vitest run tests/e2e/topic-intent-lifecycle.test.ts` — Tier 3 lifecycle green; "feature is alive" test returns 200; both canonical fixtures replay; Codex-host degrade-open verified.
5. `pnpm test` — full suite green (Zero-Failure Standard, CLAUDE.md).
6. `pnpm build` — clean TypeScript compile.
7. Framework-parity grep (see Task 6) returns 0 matches in Layer 1 source files.
8. Manual: `curl -H "Authorization: Bearer $AUTH" http://localhost:PORT/topic-intent/9999/diagnostics` against a running dev server returns the documented JSON shape.
</verification>

<success_criteria>
Layer 1 is complete when:

- [ ] All 6 must_have truths are verifiable via automated tests
- [ ] All artifact files exist with at least the documented min_lines
- [ ] All key_links exist (grep patterns find matches in source)
- [ ] All three test tiers (unit / integration / E2E) pass green
- [ ] The Tier 3 "feature is alive" E2E test returns 200 (not 503) — non-negotiable per CLAUDE.md
- [ ] Framework-parity grep returns 0 matches in Layer 1 source files (works under Claude Code AND Codex)
- [ ] Authority hard rule enforced: agent-only signals cannot cross 0.7 (existing projection test + new extractor/store coverage)
- [ ] PendingConfirmation reaches all four terminal states (answered / abandoned / expired / dropped) via real lifecycle code paths
- [ ] qalatra-9235 and GCI/Luna-365 canonical fixtures replay successfully
- [ ] All Layer 1 telemetry counters tick at least once during E2E lifecycle test (visibility verification)
- [ ] Degrade-open path verified: server boots and /topic-intent/* responds 200 even when IntelligenceProvider is absent (extractor returns [] safely)
- [ ] STRIDE threat register T-01-01 through T-01-07 + T-01-SC all have mitigations verified by test
- [ ] `pnpm test` reports 0 failures (Zero-Failure Standard)
- [ ] No new npm dependencies introduced (audit gate)

Out of scope for Layer 1 (will appear in subsequent phase plans, do NOT plan here):
- Layer 2 resume-briefing header rendering
- Layer 3 ArcCheck pre-send classifier + redraft
- Daily probe scheduler (the fixtures and replay tests exist; the cron job that runs them daily is a Layer 2/3 concern)
- Operator-admin recovery routes (separate auth token, out of scope per spec §"External surfaces")
- Materialization to SemanticMemory at the 0.7 transition (Layer 2 — Layer 1 only emits the events; consumption is downstream)
- CLAUDE.md template updates per Agent Awareness Standard (will happen when /capabilities advertising is shipped — covered in Task 4 but template-doc updates land with Layer 2 surface)
</success_criteria>

<output>
On completion, write `.planning/phases/01-layer1/01-01-SUMMARY.md` recording:
- Files actually created vs the files_modified list (any deviation explained)
- Final test counts: unit / integration / e2e
- Telemetry counters observed during E2E run
- Any STRIDE threats whose mitigation diverged from the plan
- Carry-forward items for Layer 2 (e.g. SemanticMemory materialization hook, header projection consumer interface)
</output>
