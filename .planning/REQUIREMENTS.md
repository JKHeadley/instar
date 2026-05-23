# Requirements — Topic Intent Layer

Source: `docs/specs/topic-intent-layer.md` (v14 CLEAN, approved 2026-05-22 by Justin via topic 9413).

## Layer 1 — confidence tracker (THIS PHASE)

Per-topic semantic state that tracks the agent's confidence in candidate facts and decisions, accumulating evidence over multi-turn conversation.

### Data model

**EstablishedRef** — a candidate fact or decision the system is tracking:
- `refId` (string, UUID)
- `arcId` (string)
- `kind` ('fact' | 'decision')
- `text` (string — the proposition)
- `confidence` (number in [0.0, 1.0] — computed on read from evidence array)
- `evidence` (EvidenceEvent[] — append-only)
- `lastReinforcedAt` (ISO8601)
- `status` ('live' | 'conflicted')

**EvidenceEvent** — append-only signal that moves confidence:
- `eventId` (UUID)
- `refId`
- `kind` ('extract-user' | 'extract-agent' | 'user-reref' | 'agent-reref' | 'user-affirm' | 'pending-confirm-positive' | 'pending-confirm-negative' | 'contradiction' | 'conflict-mark' | 'sharpen-retry-issued')
- `sourceMessageId` (string — for per-message dedup)
- `userAuthored` (boolean — determines authority eligibility)
- `at` (ISO8601)
- `delta` (number — the confidence change before caps)
- `meta` (record — optional extra context)

**PendingConfirmation** — record for outstanding conversational confirmation:
- `pendingId` (UUID)
- `topicId`, `arcId`, `refId`
- `propositionText` (verbatim)
- `questionText` (verbatim what the agent asked)
- `sentAtTurn`, `sentAtTime`
- `ttl` ({ turns: 5, hours: 24 })
- `retries`, `maxRetries: 2`
- `status` ('pending' | 'answered' | 'expired' | 'abandoned')

### Confidence scoring (deterministic projection)

The projection function computes confidence from the evidence array:
- Per-message dedup by `(refId, sourceMessageId)` — collisions take the larger applicable delta
- Apply signal-specific caps (e.g. user-reref caps at +0.30 cumulative, agent-reref caps at +0.05)
- Sum the deltas
- Apply exponential decay from `lastReinforcedAt` if more than 30 days old: `confidence × exp(-ln(2)/180 × max(0, daysSince - 30))`
- Clamp to [0.0, 1.0]
- Authority hard rule: if the computed sum would be >= 0.7 AND no qualifying user-authored episode exists in the evidence, clamp at 0.69

### Tiers (emergent from confidence)

- `[0.0, 0.3)` — observation (not surfaced)
- `[0.3, 0.7)` — tentative (surfaced with hedge in Layer 2 briefing; triggers ArcCheck in Layer 3)
- `[0.7, 1.0]` — authoritative (surfaced without hedge; materialized to SemanticMemory)

### LLM extractor (Tier 1 supervision)

A Haiku-class extractor reads new substantive user messages and emits EvidenceEvent records of kind:
- `extract-user` (+0.40, userAuthored=true) — initial extraction from user message
- `extract-agent` (+0.10, userAuthored=false) — initial extraction from agent message
- `user-reref` (+0.10 per distinct user episode, cap +0.30, userAuthored=true)
- `agent-reref` (+0.01 per occurrence, cap +0.05, userAuthored=false)
- `user-affirm` (+0.30, userAuthored=true, caps: 1 per refId per 24h, max 3 distinct refIds per single user message)
- `contradiction` (-0.60, userAuthored=true)

### Pending-confirmation lifecycle

- Created when ArcCheck (Layer 3) emits a confirmation question. (Layer 3 isn't built in this phase, but the lifecycle and store must exist.)
- At most one outstanding per topic; subsequent needs queue up to depth 3 (4th dropped silently, telemetry counter increments).
- Queue dedup by refId.
- TTL clock starts at dequeue time, not queue-entry time.
- Revalidation at dequeue: check refId still tentative + proposition still semantically relevant; stale → drop silently with telemetry.
- Answer interpretation by Tier-1 LLM:
  - `positive` → emit `pending-confirm-positive` event (+0.50, userAuthored=true)
  - `negative` → emit `pending-confirm-negative` event (-0.70, userAuthored=true)
  - `ambiguous` → sharpen and retry up to maxRetries=2; then `abandoned`
  - `non-responsive` → expire after TTL
- TTL: 5 substantive user turns OR 24h, whichever first.

### Storage

- File location: `.instar/topic-intent/<topicId>.json`
- Format: { events: EvidenceEvent[], pending: PendingConfirmation[], lastReinforcedAt: ISO }
- Append-only writes; projection computed on read.
- Persistence pattern matches existing `.instar/topic-resume-map.json`.

### Acceptance tests (MUST PASS for Layer 1 completion)

1. **Decay arithmetic at t=104/105/106:** a refId with confidence 0.4 (accumulated, last reinforced at t=0) decays to:
   - t=104: c≈0.3009 → tentative
   - t=105: c≈0.2997 → observation
   - t=106: c≈0.2986 → observation
   - Exact crossing at t*≈104.7
2. **User-authored-episode authority gating:** evidence accumulation from only agent-origin signals + non-contradiction silence cannot push confidence above 0.69, regardless of count.
3. **Per-message dedup:** two extractor signals from the same user message about the same refId count as ONE event, with the larger applicable delta winning (not the sum).
4. **Pending-confirm queue:** 4th queued confirmation on a topic is silently dropped; telemetry counter `pending_confirm_queue_dropped_total` increments.
5. **Sharpening retry:** ambiguous answer triggers up to 2 sharpening retries, then status=abandoned with telemetry counter `pending_confirm_abandoned_total`.
6. **Daily probe replays (Layer 2/3 dependency, but the probe job runs against Layer 1 classifier):** the qalatra/9235 and GCI/Luna 365 incident replays produce the expected EvidenceEvent records.

### Telemetry counters (Layer 1)

- `topic_intent_extraction_total{kind, userAuthored}`
- `topic_intent_evidence_event_total{kind}`
- `topic_intent_confidence_clamp_authority_total` — counts times the 0.7 → 0.69 authority clamp fired
- `pending_confirm_created_total`
- `pending_confirm_queue_dropped_total`
- `pending_confirm_abandoned_total`
- `pending_confirm_expired_total`
- `pending_confirm_answered_total{verdict}`

## Layers 2 + 3 — out of scope for this phase, will follow in Layers 2-3 build

- Layer 2: resume briefing prepended to bootstrap context (reads Layer 1 projection).
- Layer 3: ArcCheck pre-send classifier + redraft path (consumes Layer 1 projection, creates PendingConfirmation records, integrates with existing outbound gate as SIGNAL-only).

## Out-of-scope explicit (v1)

- Auto-spreading insights across separate conversations
- Retroactive backfill of pre-shipped conversations
- Cross-machine CRDT collaborative state
- Automatic conversation renaming
- Rich dashboard editor (a basic diagnostics view IS in scope)
- User-tunable confidence weights (operator may tune them)
