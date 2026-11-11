# Side-Effects Review — Topic-intent layer as H1/H2, freshness, brakes and ticks (Phase 1 S4)

**Version / slug:** `cb-topic-intent-layer`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

This is Phase 1 slice S4 of `docs/specs/context-budget-layered-summaries.md` (§6 H1/H2 and the freshness rule, §6.3, §6.4, §3.2 item 7, decision 7). It is stacked on S1, the layer store.

New modules under `src/monitoring/contextLayers/`:

- **`layerCadence.ts`**:
  - `TopicLayerBudget`: per-topic and component daily estimated-input-token ceilings that defer and count.
  - The tick policy: the minimum interval grows with recent updates; a tick is skipped mid-turn or when the transcript has not grown.
  - `buildTickDigest`: the last 12 tool names, and the first and last 500 characters of each result. The digest is bounded to what the extractor carries (`MAX_MESSAGE_CHARS`, 4,000 characters, within §6.4's 4K tokens), newest first. Each result is scrubbed whole (`scrubForStore`, then the live-value pass) before it is cut, and the digest discloses how many results it sampled.
  - `readTranscriptTail`: reads at most the last 512 KB of a transcript.
- **`layerProjection.ts`**: H1 (the awareness `currentWork`) and H2 (the active arc, only when a phase exists) written to the layer store with author and as-of. `layerFreshness` produces `as of <time>, <n> messages behind`, or `stale: unknown`.
- **`layerTicker.ts`**: one pass per interval over live topic sessions, with every outcome counted.
- **`layerCaptureWiring.ts`**: the production wiring (budget, `onCaptured` projection, ticker).

Modified:

- **`TopicIntentCapture.ts`**:
  - Optional `layerBudget` and `onCaptured` deps.
  - A new `deferred-budget` status.
  - `captureTick`, an agent-side extraction of a tick digest that honours the shed gate.
- **`TopicIntent.ts`**: counters `budget_deferred` and `layer_ticks`.
- **`TopicIntentBriefing.ts`**: an optional freshness stamp on the CURRENT WORK block.
- **`topicIntentRoutes.ts` and `AgentServer.ts`**: the freshness provider.
- **`TopicMemory.ts`**: `countMessagesAfter`.
- **`contextLayersBoot.ts`**: the shared budget, ticker attachment, `h1Freshness`, and the status additions.
- **`server.ts`**: the capture block wires the layer capture when `_contextLayers` exists, and reports a degradation when the layers are on but no shared intelligence exists.

## Decision-point inventory

- **Layer budget admission** (add). It decides whether to spend on a layer update. Over a ceiling, the update is deferred and counted. It never touches a message or a session.
- **Tick due** (add). It decides whether to run a tick. Same scope: it only decides spend.
- **Capture loop** (modify). Two optional deps. When they are absent (layers off), behaviour is byte-identical to before.
- **Briefing render** (modify). It adds one line when a stamp is supplied.

---

## 1. Over-block

- **Deferrals.** The budget can defer a substantive turn's layer update. The turn itself is delivered and handled normally. Only the summary refresh waits, and it is counted, so it shows on the status.
- **Defaults.** 400K estimated input tokens per topic per day, and 4M for the component. Roughly 100 to 200 updates per topic per day: well above the measured normal and below a runaway.
- **Tick skips.** A skipped tick only delays an H1 refresh.

## 2. Under-block

- **Token estimates are rough.** The budget counts estimated input tokens (characters ÷ 4 plus overhead), not provider-reported usage. A provider tokenizer that differs a lot shifts the ceiling, but in both directions the ceiling still bounds runaway growth.
- **The tick digest scrub uses shape patterns plus the agent's own live values.** A third-party secret with no recognizable shape (or a PEM block whose END line was never written) can still reach the extractor's provider. That provider is the conversation's own model path, which already sees the full transcript.

## 3. Level-of-abstraction fit

- The brakes live where the topic is known: the capture loop and the ticker. Below that, the shared `LlmQueue` still applies its daily cap and lane reserve.
- `enqueueMetered` is the queue-level per-component meter. The extractor calls through `IntelligenceProvider`, which carries no topic, so the per-topic ceiling is enforced one level up, in code.

## 4. Signal vs authority compliance

These are budget and cadence decisions over the agent's own background spend. They hold no authority over messages, sessions or users. Not a brittle blocking check.

## 4b. Judgment-point check

- The ceilings and the tick interval are cost defaults the spec names ("replaced by Phase 1's measured … spend"; the Defaults table). They are not judgments over competing live signals.
- They are tracked as Phase 1 soaks, to be revised from the measured spend. <!-- tracked: CMT-1536 -->

## 5. Interactions

- **Capture loop.** The pre-filter, shed and rate gates run first and are unchanged. The budget runs after context building, so a deferred turn has already counted its `turns_seen`.
- **The extractor.** A tick input is an agent-side message (`fromUser: false`). Awareness evolution treats it like any agent turn: it can refresh the current work but cannot create the anchor.
- **The briefing.** The stamp only appears when the layers are on and an H1 exists.
- **TopicMemory.** `countMessagesAfter` is a read on an indexed column per briefing fetch.
- **Ticker.** It starts with the capture loop (under the same `sharedIntelligence` condition) and its timer is `unref`'d. Each pass reads at most 512 KB per live topic session.

## 6. External surfaces

- The briefing text gains one line on development agents.
- `GET /context-budget/layers` gains `budget` and `ticker`.
- A new degradation, `contextBudget.layers.capture`, appears on machines with the layers on and no shared intelligence.
- No new route, no new switch, no outbound messages.

## 6b. Operator-surface quality

Not applicable. No dashboard file is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **H1/H2 records: unified.** They replicate through the layer kind exactly as S1 describes, dark until `stateSync.contextLayers` is on.
- **Budget and ticker: machine-local by design.** Each machine's spend is its own resource, and each machine ticks only its own live sessions (§14 "owner-acts").
- **Freshness.** Computed against the local TopicMemory. On a machine without the topic's rows it reads `stale: unknown`. The relay-path row carrier (S3) closes that.

## 8. Rollback cost

- `contextBudget.enabled: false` removes all of it at the next restart: no budget, no projection, no ticker, no stamp.
- The counters are additive optional fields.
- A release revert is clean, with no data migration.

## Conclusion

S4 gives the topic-intent layer the brakes, freshness and tick cadence §6.4 and §3.2 item 7 call for, behind the dev-gated switch. It touches no message or session decision.

## Second-pass review (if required)

**Reviewer:** Fable 5.2

**Independent read of the artifact:** concern raised with four blocking items. All four are fixed in this commit, and the reviewer's should-fix items are fixed or recorded below.

Blocking, fixed:

1. **The extractor saw only the oldest quarter of the tick digest.**
   - The digest is now bounded to what the extractor carries (`MAX_MESSAGE_CHARS`) and ordered newest-first.
   - `sampled` counts exactly the results in the digest, and a test asserts this.
2. **The scrub ran after the digest was cut, so a cut secret could leak.**
   - Each result is now scrubbed whole: shape patterns first, then a live-value pass with the agent's own secrets. Only after that is it cut to its edges.
   - Tests cover a token at character 480, a PEM body, and a live value.
3. **H1 could be re-stamped fresh when the awareness had not moved.**
   - The projection runs only when the extractor reports `awarenessUpdated`.
   - The origin comes from the awareness itself: a `tick-` source message means the update came from a tick. A turn and a tick finishing at the same time therefore cannot mislabel each other.
   - A tick carries the previous `lastMessageId` forward.
4. **The ticker blocked the event loop.**
   - Each session gets one async `stat`, and growth and the interval are checked first.
   - The mid-turn probe runs only for a session that is otherwise due, and uses the async `checkSessionWorkState`.
   - The tail is read asynchronously, transcript paths are resolved once per engine session, and the pass yields between sessions.

Should-fix, fixed:

- **Ticker accounting.** A shed or failed tick no longer consumes the growth, returns its budget reservation, waits out the interval before retrying, and is counted (re-check finding).
- **Missing H1.** A topic with no H1 record yet renders `no layer record yet — freshness unknown`, never nothing.
- **Interval growth.** User-turn updates now lengthen the tick interval (`noteTopicUpdate`).
- **Ticks no longer touch refs.** Ticks are awareness-only (`awarenessOnly`): raw tool output never creates or reinforces a ref.
- **H2 updates.**
  - H2 is rewritten only when the phase moves.
  - An ended phase is an explicit `absent` record that replicates, not a local delete.
  - The topic's initial arc is never a phase.
- **Degradation reports.** Also raised when capture is disabled with the layers on, and when the capture wiring throws.
- **Nits.** A `null` JSONL line no longer throws. A throwing session list keeps all tick state. The ticker's stop handle is kept.

Should-fix, recorded <!-- tracked: CMT-1536 -->:

- **The budget is in memory only, with hard-coded limits, and is not yet the `enqueueMetered` extension that attributes calls to `LayerUpdate`.**
  - The limits are decision 7's interim cost defaults.
  - Persisting the budget and attributing calls to `LayerUpdate` belong with S13 (measurement), which adds the `LayerUpdate` component and its `/metrics/features` row.
- **A deferred turn is counted but not retried.**
  - Ticks do retry, and the next user turn retries naturally.
  - The deferral is visible on the status and the card.

## Evidence pointers

- **Unit:** `tests/unit/context-layer-cadence.test.ts` (14 tests). Covers:
  - budget ceilings, deferral and the rolling window;
  - the tick policy and interval growth;
  - the digest's bounds, scrub and disclosure;
  - the transcript tail;
  - H1/H2 projection and the phase rule;
  - freshness, including unknown;
  - the ticker: baseline, mid-turn, growth, budget retry and failure counting;
  - the briefing stamp.
- **Integration:** `tests/integration/context-layer-topic-intent.test.ts` (3 tests). Uses the real TopicMemory, TopicIntentStore, capture loop, briefing route and layer store, and covers stamp movement, deferral and a real tick.
- **E2E:** `tests/e2e/context-layer-topic-intent-alive.test.ts` (3 tests). Covers the dev-agent path, the fleet path and the wired source.

## Class-Closure Declaration (display-only mirror)

Not a defect fix. Class `n/a`, closure `n/a`.
