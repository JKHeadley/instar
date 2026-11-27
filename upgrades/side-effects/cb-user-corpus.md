# Side-Effects Review — U, the protected user corpus, with referent stubs (Phase 1 S5)

**Version / slug:** `cb-user-corpus`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

Phase 1 slice S5 of `docs/specs/context-budget-layered-summaries.md` (§6 row U, §6.2 stub `kind`, §6.4, §8, §14, §15). It sits on S1 (layer store, protected row references), S4 (H1/H2 projection, capture brakes) and S2 (row writer, `origin` and `channel_message_id`).

New:

- **`src/monitoring/contextLayers/userCorpus.ts`**:
  - `UserCorpus.refresh(topicId)`: lists the topic's TopicMemory sender rows (`from_user=1`, or an `origin` set) into protected `u` records. The current message's own row is listed first, then at most 200 rows after a persisted per-topic watermark (a new non-replicated protected type, `u-mark`). The watermark resets when TopicMemory was rebuilt or the operator binding's fingerprint changed, and never moves past a row whose write failed. Each record is a row reference (message id, sha256, length), its time, a label (`operator | forwarded | relay | third-party`), `authority` (`operator` only for the protected class, otherwise `none`), and a `pastedArtifact` flag over 4,000 characters. Never text.
  - `classifyRow`: relay/A2A origin first, then `forwarded=1`, then the operator binding. An unresolvable sender is `third-party`.
  - `validateReferentStub`: the deterministic tier-1 validator (§15).
  - `UserCorpus.stubCandidates` / `acceptStub`: offer an operator row's last three conversational agent messages to the extractor call (status, heartbeat and proxy lines are skipped), then validate the stub and write it as a derived `u-stub` record (author `derived`, bound to the quote's sha256) keyed beside the quote. The stub must name one of the offered messages. A quote that is relabelled withdraws its stub through a replicated `withdrawn` record.
  - `stubFor`: the one reader later slices use. It returns a stub only while its quote is a protected operator row with a matching hash.
  - `userCorpusView` / `measureUserCorpus`: one pass giving sizes per label (tokens as chars/4, and messages), the protected class, the paste count, agent-authored and unattributed counts, and stub coverage and kinds.
- **`GET /topic/:id/user-corpus`** in `routes.ts`, listed in the `contextBudget` CapabilityIndex row.
- Tests in all three tiers plus `tests/unit/referent-stub-contract.test.ts`.

Modified:

- **`TopicIntentExtractor.ts`**: `REFERENT_STUB_KINDS` (single source), `referentCandidates` on the input, `wantsReferentStub`, a conditional prompt section and candidate block, `pickReferentStub`, and an opt-in `referentStub` in the parse and the result. Without candidates every string and object is unchanged.
- **`TopicIntentCapture.ts`**: an optional `userCorpus` dep.
  - After a `setImmediate` yield (never on the delivery callback's stack), the refresh runs on every turn before any gate.
  - Candidates are attached only for a protected operator row.
  - An operator's bare acknowledgement ("yes") with candidates passes the prefilter, which is a substance filter, not a brake. Shed, rate and budget still apply.
  - Each reason an operator row got no stub is counted.
  - The stub returned by the same call goes to `acceptStub`.
  - The brakes' estimate includes the candidate text.
  - `isAgentSentinelLine` is exported.
- **`TopicMemory.ts`**: three reads: `getUserCorpusRows` (bounded, by watermark or by message, with `maxRowId`), `messagePrecedes`, and `getAgentMessagesBefore`.
- **`LayerStore.ts`**: the protected type `u-mark`, which is not replicated.
- **`MemoryPrivacy.ts`**: `operatorBindingFingerprint()`, a hash of the baseline flag, the owner, the configured Telegram owner and the operator keys. It is identity only.
- **`templates.ts` and `PostUpdateMigrator.ts`**: a Registry-First row for `GET /topic/:id/user-corpus` (Agent Awareness and Migration Parity).
- **`tests/unit/context-layer-kind.test.ts`**: the DARK check was already failing on the base. S1 wired the layer store's replication seam (`contextLayersBoot.ts`), and the check had not been updated, so it now allows that one sanctioned emitter.
- **`tests/unit/feature-delivery-completeness.test.ts`**: tracks the new migrator row.
- **`layerCaptureWiring.ts`, `contextLayersBoot.ts`**: U is built when TopicMemory is supplied and attached to the layers; status gains `userCorpus`.
- **`server.ts`**: the capture block passes `topicMemory`, the memory-privacy operator binding (`isOperator || isOwnerSender`) and its fingerprint.
- **`llmBenchCoverage.ts`** and the parser-contract ratchet: `TopicIntentExtractor` graduates from argued-false to `{ contractTest }`, because the call now teaches a closed `kind` vocabulary the validator gates on (a shrink of the argued-false set).

## Decision-point inventory

- **Row classification** (add). Labels a row and sets its `authority`. It decides nothing about the message; later slices (Anchor, ledger) read `authority`.
- **Stub validation** (add). Accepts or drops a derived stub. A drop is counted; the message's capture is unaffected.
- **Stub request** (add). Whether the existing extractor call carries candidates: only for a protected operator row with a preceding agent message.
- **Capture loop** (modify). One optional dep. Absent (layers off) ⇒ byte-identical behaviour, asserted.

---

## 1. Over-block

- Nothing is blocked. A rejected stub only means one operator message has no stub; coverage reports it.
- The quote check can reject a stub that legitimately restates the agent's question when the operator repeated that question word for word. The cost is a missing stub, counted as `contains-quote`.
- Nothing about the prefilter blocks a stub any more. With U on, an operator's non-empty acknowledgement that follows an agent message now reaches the extractor, so extractor volume on development agents rises. It is still one call per message, bounded by the shed, rate and budget brakes, and it should be watched in `/metrics/features`. <!-- tracked: CMT-1536 -->

## 2. Under-block

- `forwarded` is treated as "not 1": a legacy row with unknown forwarding (`NULL`) can be protected. This matches the slice brief; the record keeps `forwarded: null` so a later reader can tell the cases apart.
- Labels follow the operator binding through its fingerprint: a change re-lists U from row 0, bounded per turn. A binding input outside the fingerprint would not trigger a re-list. It covers everything `isOperator` and `isOwnerSender` read today except the users list behind a `user:` profile key.
- A Slack row whose sender resolves to no profile has no sender key and is labelled `third-party`, never `operator` (fails toward no authority).

## 3. Level-of-abstraction fit

- U reads sender rows where they live (TopicMemory) and the operator where it is decided (MemoryPrivacy). It does not re-derive identity.
- The stub rides the extractor's existing call through `ExtractorInput`, so it shares the shed gate, the rate ceiling, the layer budget and the LlmQueue daily cap with no new brake.
- Validation is deterministic code after the call, not a second judgment.

## 4. Signal vs authority compliance

- U labels and stubs are signals. `authority: operator` records provenance (who wrote the text), not a decision; §6.2's decision transition is S6's and treats a stub `kind` as a judgment-candidate.
- The stub writer never touches the quote: the `u` record is written from the row, and the stub is a separate derived record. The verifier's byte-identity check (§7.5) stays against the row.

## 4b. Judgment-point check

- `PASTED_ARTIFACT_CHARS` (4,000) is the extractor's own message window: a paste the extractor cannot read whole.
- `MAX_STUB_CHARS` (160) is §15's "≤ one line". `QUOTE_MIN_CHARS` (12) keeps a recurring single word from reading as a quote.
- None of these gate a message.

## 5. Interactions

- **Capture loop.** Refresh runs before the automation and prefilter returns, so automated and trivial rows are listed too. A refresh failure is logged and capture continues.
- **Extractor.** The stub request only appears with candidates. Agent turns and ticks never ask (`wantsReferentStub`).
- **Brakes.** The estimate gains the candidate text plus the stub instructions, so a stub-carrying turn reserves slightly more budget.
- **TopicMemory.** A handful of indexed reads per turn. The refresh reads at most 200 rows after the watermark plus the current row.
- **Layer store.** One small file per listed row, one per stub, and one watermark per topic.
- **Extractor output budget.** `maxTokens` is still 1,000 with a stub requested. A truncated response loses the whole parse and shows as `degraded_cap_or_error`; this is a watch item for S13.

## 6. External surfaces

- New route `GET /topic/:id/user-corpus` (bearer; sizes and labels only; 503 off).
- `GET /context-budget/layers` gains `userCorpus`.
- The extractor prompt changes on development agents for operator messages only.
- No new switch, no outbound messages.

## 6b. Operator-surface quality

Not applicable. No dashboard file is touched; the dashboard card is S13.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **U bodies: re-derived on each machine from its TopicMemory rows** (§14). The `u` type maps to no replicated kind. A machine without the topic's rows lists fewer rows; the relay-path row carrier (S3) closes that.
- **Stubs: unified.** `u-stub` replicates through the layer kind, dark until `stateSync.contextLayers` is on. A stub keyed by message id lands beside the same row on every machine, because the key rule (S2) derives the same message id everywhere.
- **Watermarks: machine-local** (`u-mark` is never replicated), because each holds a row id in its own machine's TopicMemory. **Counters** are in memory.

## 8. Rollback cost

- `contextBudget.enabled: false` removes all of it at the next restart; the extractor returns to the stub-less prompt.
- The `u` and `u-stub` records stay on disk under the gitignored layer root and are inert.
- The TopicMemory reads add no schema.
- A release revert is clean, with no data migration.

## Conclusion

S5 builds U from sender rows with labels and authority, adds referent stubs inside the existing extractor call with a deterministic validator, and measures U per topic, behind the dev-gated switch. It decides nothing about any message or session.

## Second-pass review (if required)

**Reviewer:** Fable 5.2, as an independent subagent: a first review plus two resolution checks.

**First pass:** concern. There were no blocking items and eight should-fix items, all fixed:

1. **Bare acknowledgements never got a stub.** Fixed: the prefilter is bypassed for an operator row with candidates, the brakes still apply, and the reasons for a missing stub are counted.
2. **Candidates could be all status lines.** Fixed: the scan goes 12 rows back, sentinel and heartbeat lines are dropped, and the last three are kept.
3. **Synchronous backfill on the message path.** Fixed:
   - a `setImmediate` yield runs first;
   - the current row is listed first, then at most 200 rows;
   - the watermark is persisted.
4. **The route read every U file twice.** Fixed with a single-pass `userCorpusView`; an omitted `limit` defaults to 50.
5. **A stub was not bound to its quote.** Fixed:
   - the stub carries `quoteSha256`;
   - a relabelled quote withdraws its stub through a replicated record;
   - `stubFor` is the only sanctioned reader.
6. **The quote check was whole-sentence only.** Fixed: a run of five consecutive user words is also rejected.
7. **`refersTo` accepted any preceding row.** Fixed: it must name an offered candidate (`not-a-candidate`).
8. **Agent Awareness.** Fixed: the Registry-First row is in the template and in a migration, with a test.

The nits were also fixed: the persisted-watermark test was renamed, `messageId` is null rather than NaN, and agent-authored and unattributed rows are counted. `maxTokens` is recorded above as a watch item.

**Resolution check 1:** concur. All eight items were confirmed against the code. Two new should-fix items came from the persisted watermark, and both are fixed:

- **A.** A failed row write could be skipped for good. Now the page stops at a failed write and never advances past it.
- **B.** Rows already listed could never be relabelled. Now a change in the binding fingerprint re-lists from row 0. The current row is no longer listed twice.

**Resolution check 2:** concur. A and B were confirmed resolved. One small should-fix and two nits followed, all fixed:

- The fingerprint now includes the configured Telegram owner that `isOwnerSender` reads, asserted on a single instance.
- Only a transient `write-failed` holds the page; a deterministic refusal is counted and skipped.
- A fingerprint read error keeps the last good value instead of forcing a re-list.

## Evidence pointers

- **Unit:**
  - `tests/unit/context-layer-user-corpus.test.ts` (31) covers:
    - the validator: multi-line, length, brackets, unknown kind, bad or non-preceding reference, whole and partial quotes;
    - labels, with no authority for forwarded, relay, A2A and third-party rows;
    - row references with no words, matching byte for byte;
    - pasted-artifact flags;
    - a hook-injected "user" transcript entry staying out of U;
    - the persisted watermark: the cold-backfill bound, the reset on a rebuilt database, the failed-write hold and the binding-change relabel;
    - the operator binding and its fingerprint;
    - stubs beside the quote, sentinel-free candidates, `not-a-candidate`, and `stubFor` with withdrawal;
    - bare "yes" in the capture loop and the no-stub reasons;
    - the switch off: prompts pinned by golden sha256 from the base commit, the parse, and the result and input carrying no new keys.
  - `tests/unit/referent-stub-contract.test.ts` (4): the prompt↔parser contract for `kind`.
  - `tests/unit/migrate-context-budget-user-corpus-row.test.ts` (2).
- **Integration:** `tests/integration/context-layer-user-corpus.test.ts` (5), using real TopicMemory rows, the real capture loop and the production `createLlmExtractFn` with a counting provider:
  - row references match byte for byte;
  - exactly one call per message, with the stub inside it;
  - `u-stub` replicates and `u` does not;
  - the route returns 401 without the bearer token, 503 off, and 200 with sizes and labels and no words.
- **E2E:** `tests/e2e/context-layer-user-corpus-alive.test.ts` (3) covers the dev-agent boot path, from a captured operator message to a U record, a stub and the route; the fleet path, with nothing wired and a 503; and the WIRED source checks.
- **Ratchets and neighbours, all green:** topic-ref, no-silent-fallbacks, no-silent-llm-fallback, parser-contract classification, llm-bench-coverage, feature-ladders-coverage, capabilities-discoverability, feature-delivery-completeness, context-layer-kind, context-layer-store (unit, integration and e2e), the S4 topic-intent layer (integration and e2e), TopicIntentCapture, the topic-intent capture lifecycle, topic-memory, memory-inbound-tracker and degradation-never-silent. `tsc --noEmit` is clean.

## Class-Closure Declaration (display-only mirror)

Not a defect fix. Class `unbounded-self-action`, closure `n/a`: the refresh and the stub writer run once per message they are handed; nothing retries or re-fires on its own.
