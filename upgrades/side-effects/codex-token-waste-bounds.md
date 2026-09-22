# Side-Effects Review — Bound two wasteful internal Codex calls

**Version / slug:** `codex-token-waste-bounds`
**Date:** `2026-09-22`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see bottom)`

## Summary of the change

Two background LLM callers spent tokens without getting anything for them. Both are fixed here, and neither adds a new decision point.

1. **Topic-intent capture (`src/core/TopicIntentCapture.ts`).** `captureTurn` rendered *every* ref the topic had ever established, at observation tier or above, into each extraction prompt. The store never prunes refs, so the prompt grows with the topic's lifetime. Live counts on the Studio: one topic has 858 refs and five more have over 300. The average `TopicIntentExtractor` call was 42,103 input tokens, about 7.0M a day on one machine, making it the largest single internal consumer. The new pure `selectPromptRefs` ranks refs by projected tier, then by most recent reinforcement (ties break on refId), and offers the first `MAX_PROMPT_REFS = 40`. The store is not touched.
2. **Session-activity digests (`src/monitoring/SessionActivitySentinel.ts`).** The digest, synthesis and retry calls passed no `timeoutMs`, so the Codex provider applied its 30-second default. Over 24h on the Studio, 143 of 280 calls failed, and every failure had latency ≥ 30,007 ms: all of them were timeouts. Successful calls took 6.4 s to 49.4 s. Each timeout discards a call that had already consumed its input. The calls now pass `DIGEST_LLM_TIMEOUT_MS = 90_000`.

## Decision-point inventory

- None added and none changed. Fix 1 changes what *context* an LLM extractor sees; the extractor's judgment and the store's confidence/evidence rules are unchanged. Fix 2 changes a call budget.
- `TopicIntentArcCheck`, the outbound check against contradicting settled refs, still reads its full tentative-and-above set. It is **deliberately not capped**: capping a contradiction check could hide the very old authoritative ref it exists to protect.

## 1. Over-block

No issue identified; nothing is rejected. The effect closest to over-blocking: a proposal to reref, affirm or contradict a ref outside the 40-ref window is dropped by `translateProposal`, because that refId is no longer in `existingRefs`. The LLM cannot name a refId it was never shown, so such a proposal could only be a hallucinated id, and dropping it is correct.

## 2. Under-block

- An old, low-tier, stale ref outside the window will not be reinforced by a new message that restates it. The extractor may instead propose a `new-ref` with near-duplicate text. This drift is accepted. Dropping below the window requires being observation-tier and older than 40 higher-ranked refs, and duplicates of stale observations carry little weight in `projectConfidence`. Authoritative and tentative refs always rank first, so the load-bearing ones stay anchorable.
- A digest call that genuinely hangs now holds its spawn-cap slot for up to 90 s instead of 30 s. The sentinel runs about 280 calls a day and nothing waits on them, so the host-wide spawn cap (default 8) is not threatened.

## 3. Level-of-abstraction fit

The cap sits at the one place the prompt input is assembled (`captureTurn`), not in the store: other readers (briefing, Usher, WorkingSet, routes) keep their full views. The timeout uses the existing per-call `IntelligenceOptions.timeoutMs` contract, which the Codex, Gemini, Pi and interactive-pool providers already honour and which `IntelligenceRouter` passes through on the primary attempt. No new mechanism is introduced.

## 4. Signal vs authority compliance

Compliant. Neither change holds blocking authority. The capture loop is a signal producer that is fire-and-forget and degrade-safe, and the sentinel writes episodic memory.

## 4b. Judgment-point check (Judgment Within Floors standard)

The ref ranking is a static ordering, but it is not a competing-signals decision point. It bounds the context handed to an LLM judgment, and that judgment remains the decision-maker. The ordering (confidence tier, then recency) is the store's own existing notion of relevance.

## 5. Interactions

- `IntelligenceRouter` swap and queue attempts override `timeoutMs` with their own caps. That is unchanged and correct: the 90 s budget governs the primary attempt.
- The retry queue in the sentinel reprocesses failed digests. With fewer timeouts, the retry backlog shrinks rather than re-failing.
- Feature metrics keep attributing both components, which is how the effect will be measured.

## 6. External surfaces

No routes, config or on-disk formats change. The only visible difference is lower Codex usage and more digests completing.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. Each machine runs its own capture loop and sentinel over its own sessions, and the change applies identically on every machine through the normal update. No replicated state is involved.

## 8. Rollback cost

A code revert through the next release. No data migration: the store is untouched and no config was added.

## Conclusion

Two bounded, low-risk changes that remove measured waste (about 7M tokens a day, plus about 143 wasted calls a day on the Studio) without changing any decision. Clear to ship.

## Second-pass review (if required)

**Concur with the review.** An independent reviewer subagent traced both changes.

- `existingRefs` has three readers in `TopicIntentExtractor.ts`: the refId lookup in `translateProposal` (208), the prompt (285) and the telemetry count (431). A refId outside the window was never shown to the model, so dropping a proposal that names one is correct. The ranking uses the store's own projected tier (`TopicIntent.ts:770`), and the refId tie-break makes it deterministic.
- The 90 s budget reaches the Codex subprocess. The router's primary attempt carries no race cap, so the caller's `timeoutMs` survives the option merge. `SpawnCapIntelligenceProvider` passes options through unchanged, and `CodexCliIntelligenceProvider` uses `options?.timeoutMs ?? 30_000`. The router's race timers wrap only the swap and queue attempts. A longer-held spawn-cap slot is never reclaimed while its process is alive (`hostSpawnSemaphore.ts:123-129`), and the slot is released in a `finally`.
- One minor point this artifact left out, and it does no harm: the prompt's per-ref tier *label* comes from the persisted `confidence` snapshot, while the ranking uses the projected tier. So a ref inside the window can carry a label slightly different from the tier it was ranked by. This behaviour predates the change, and ranking by the projected tier is the more accurate choice.
