# Side-Effects Review — H3 as the single writer of the topic summary table (Phase 1 S9)

**Version / slug:** `cb-h3-writer`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

Phase 1 slice S9 of `docs/specs/context-budget-layered-summaries.md` (§6 row H3 and the "rolling summary is retired by making H3 its single writer" paragraph, §6.5 "H3 bounded", §12 "H3 rebuild input" and "replicated record caps", §14, §15 tier 1, §17 "layer freshness", §18 tier 2 and wiring integrity). Stacked on S6 (anchor and ledger), with S8 (chunks, span sampler, C2) merged in as the local base.

New modules:

- **`src/memory/TopicSummaryTable.ts`**: the single-writer funnel. It is now the ONLY caller of `TopicMemory.saveTopicSummary` in `src/` (a ratchet test greps for it). Each writer names itself (`h3`, `topic-summarizer`, `post-topic-summary`). An owner predicate decides who owns the table: layers on means H3 owns it and the legacy writers are refused (`summary-written-by-h3`). Layers off means the legacy writers write exactly as before and an H3 write is refused (`layers-off`). Backend errors propagate as they did before.
- **`src/monitoring/contextLayers/h3Builder.ts`**: H3, in three parts.
  - `selectH3Inputs`, the bounded selection. The floor is open (unranged) chunks, including pending gaps and the pre-layer pointer, plus chunks referenced by the current phase (H2 live: every chunk carrying a message at or after the phase's boundary message). Ranges are then filled newest first: every range through its C2 summary, admitted up to the 64K hard ceiling (past the 24K input default, older ranges are read through C2 only, never dropped, per §6.5); while the 24K default remains, the newest ranges are upgraded to their member chunks. A range is left out only past the ceiling, or past the tighter cap of the oversize rebuild. The disclosure is in-band.
  - The validator: strict JSON `{purpose, summary}`; the purpose is one line; every 12+ character quotation must be byte-identical to the input.
  - The `H3Builder`. It is debounced per topic (10 minutes; a fold bypasses the window; a request inside the window schedules exactly one rebuild at its end) and serialized per topic. Each build is one model call on the queued shared intelligence (background lane, daily cap), admitted by the layers' `LayerUpdate` budget. If the floor is over budget, it asks once for a range close. Over a 64K hard ceiling it is deferred and nothing is sent. On replication `oversize`, it rebuilds once under a C2-only selection with disclosure. It writes `h3/current` (author, asOf) and then the summary table through the funnel: `lastMessageId` is the last message the selection covers, and `purpose` is H3's derived line. Before every table write it retires any legacy rolling summary to `h3/legacy-retired` (once; H3's own row, recognised by its header, is never retired), and it never overwrites a summary it could not keep.

Modified:

- **`TopicSummarizer.ts`**: takes an optional `TopicSummaryTable` (omitted means the legacy owner, today's behaviour) and writes through it. `enabled()` is false, and `summarize` returns null before any model call, while H3 owns the table.
- **`routes.ts`**: `POST /topic/summary` writes through the funnel and returns `409 { error: 'summary-written-by-h3', reason }` while the layers are on. `POST /topic/summarize` returns the H3 view while the layers are on: `writer: h3`, `needsUpdate: false`, the H3 text with its `as of` freshness and which ranges were read through C2, and `messages: []`, so a caller is never asked to write. `GET /context-budget/layers` gains `h3` (the builder's counters). `RouteContext.h3Builder`.
- **`server.ts`**: constructs `H3Builder` beside the chunk builder, over the same queued intelligence and budget, with the table funnel (`() => _contextLayers !== null`). The chunk builder's `closed` and `c2` events request H3. With `_contextLayers` set, the `TopicSummarizer` is not constructed ("handed to H3"). Otherwise it is constructed with the funnel. Passes `h3Builder` to AgentServer.
- **`AgentServer.ts`**: the `h3Builder` option.
- **`layerProjection.ts`**: H2's record also carries its arc's `boundaryMessageId` (additive), so H3 can find the phase's chunks.
- **`contextBudgetMetrics.ts`**: each topic row gains `h3` (`not-built-yet`, or status, freshness, input tokens, chunks read, ranges read directly / through C2 / left out). There are no `h3-not-built` placeholders in this base to replace; the S12 sentinel freshness row is not in this base.
- **`CapabilityIndex.ts`**: the `contextBudget` row describes H3 and the 409. The `topicMemory` row lists the summarize and summary routes with their layers-on behaviour.
- **`templates.ts` + `PostUpdateMigrator.migrateClaudeMd`**: one Registry-First row ("What is the whole story of topic N so far? / who writes the topic summary?"), placed after the anchor-ledger row. The migration is content-sniffed on `summary-written-by-h3` and idempotent, and the migrated row is byte-identical to the template's (tested).
- **LLM registries** (`componentCategories.ts`, `llmBenchCoverage.ts`, `provenanceCoverage.ts`, `docs/LLM-ROUTING-REGISTRY.md`, and the three ratchet baselines): `ContextLayerH3` is registered exactly as S8 registered `ContextLayerChunk`: reflector, untrusted-input, not a judge, no parser contract, exposed to all content kinds, bench and provenance enrolment pending <!-- tracked: CMT-1536 -->. The TopicSummarizer registry row notes that it is off under the layers.
- **`feature-delivery-completeness.test.ts`**: the new migrator-only marker is listed beside the anchor and user-corpus rows.

No new config switch: everything is behind the existing dev-gated `contextBudget.enabled` (its ladder entry `contextBudget.layers` already exists), so `feature-ladders.json` is unchanged.

## Decision-point inventory

- **Summary table writer ownership** (add): `TopicSummaryTable.write`. Decides which writer may store a derived summary. Layers on means H3 only; layers off means legacy only.
- **`POST /topic/summary`** (modify): 409 under the layers; unchanged otherwise.
- **`POST /topic/summarize`** (modify): returns H3 under the layers; unchanged otherwise.
- **TopicSummarizer** (modify): disabled under the layers (not wired at boot, and refused by the funnel).
- **H3 build admission** (add): the debounce, the `LayerUpdate` budget, the hard ceiling. Decides spend only.
- **H3 output validation** (add): accept or refuse a model output for a derived layer.
- **H3 input selection** (add): which derived records feed the call (spec floor + budget).

---

## 1. Over-block

- **`POST /topic/summary` returns 409 for every caller while the layers are on.** That is the spec's intent (§6: "Never two writers"). A session following an older CLAUDE.md that still tries to write a summary gets a plain reason, and the template row tells it not to. Fleet agents (layers off) are unaffected.
- **The TopicSummarizer stops on development agents.** A topic that never compacts produces no chunk, so H3 never builds for it, and its table row keeps the last legacy summary, frozen. The extractor's `rollingSummary` input, which reads that row, is frozen for those topics too. This is a deliberate reading of §18's wiring-integrity line ("H3 is the summary table's ONLY writer when `contextBudget.enabled` is on") and decision 10, over §6's per-topic wording ("disabled the moment H3 writes"). The legacy summarizer only ran on session end for Telegram-linked topics anyway. It is visible: `/topic/summarize` says `h3: not-built-yet` and explains it. The remedy is the other §6.5 chunk triggers (span close, watermark), which are not yet built <!-- tracked: CMT-1536 -->.

## 2. Under-block

- **An unquoted paraphrase of an operator sentence cannot be detected deterministically**, the same residual as S8. H3's input is chunk and range text that has already passed S8's quotation check against the raw span, and H3's own quotations must match that input exactly, so a quotation is faithful by transitivity. An unquoted rewording would land, labelled `author: derived`.
- **The §7.6 `privacy_scope` filter is not applied to H3**, the same declared deviation as S8. H3 reads only derived chunk and C2 records. Its text reaches the summary table, whose existing readers (spawn context, `getTopicContext`, `formatContextForUser`) already served the legacy summary, which was built from the same messages with no privacy filter.
- **A topic key that is not numeric** (app conversations, Slack keyed differently) gets an `h3/current` record but no table write: the table is keyed by number.

## 3. Level-of-abstraction fit

- The single-writer rule is enforced in one funnel that every writer must pass, not by convention at each call site. The structural guarantee is the ratchet test on `saveTopicSummary(` callers.
- H3 sits beside the chunk builder, reads only the layer store, uses the same queued intelligence and shared `LayerUpdate` budget, and reuses S8's `quotationsIn`. Selection is a pure function, so the Phase 2 packet and the probes can reuse it.
- The route only reads (`h3SummarizeView`). The builder is driven by chunk events, never by a request.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over messages, sessions or users.

The only refusal is of a second *writer* of a derived table. It is deterministic and invariant: "one writer per table", keyed off a boot-time switch, with no judgment over live signals. H3 itself is a derived summary; it holds no authority, and nothing decides anything from it.

## 4b. Judgment-point check

The constants are the spec's cost defaults or bounds, each naming its consequence:

- the debounce (10 min, §Defaults);
- the 24K input (§12, a judgment-candidate whose floor of open and current-phase chunks is never dropped);
- the 64K hard ceiling (P19's ceiling: over it the build is deferred, visibly, and nothing is cut from the floor);
- the summary bound (20K chars, a generous validator bound above the §6 ~2–4K-token writer target);
- the single oversize retry (§14).

None of these sits at a competing-signals decision point. The selection order (floor, then C2 newest first, then direct reads newest first) is the spec's enumerated rule.

## 5. Interactions

- **Chunk builder → H3.** `closed` and `c2` events request H3. A chunk burst coalesces into one build plus at most one scheduled rebuild. H3's own range-close request calls `maybeCloseRange`, which only acts at its thresholds.
- **The LlmQueue and the `LayerUpdate` budget.** H3 competes with chunks and the capture loop in the background lane and on the per-topic and component ceilings. Over a ceiling it is deferred and the previous H3 and table row stand. A failed call refunds its reservation.
- **Summary table readers.** `TopicIntentCapture` (rollingSummary), `JobScheduler`, `formatContextForSession`, `getTopicContext`, `needsSummaryUpdate` and `formatContextForUser` now read H3's rendered text, which starts with a one-line `[Long-term view (H3), as of …, covers topic messages through N. <disclosure>]` header. `message_count_at_summary` is the number of topic messages up to H3's last covered id, so `needsSummaryUpdate` still means "new messages since".
- **Double-fire.** None: the summarizer is not wired under the layers, and the funnel would refuse it anyway.
- **Races.** Builds are serialized per topic. The table write happens after the H3 record write; a crash between them leaves the record newer than the row, and the next build rewrites both.
- **Debounce timers** are unref'd and in memory. A restart loses a scheduled rebuild; the next chunk event schedules it again.

## 6. External surfaces

- `POST /topic/summary`: new 409 response under the layers (fleet unchanged).
- `POST /topic/summarize`: a new response shape under the layers (`writer: h3`, `needsUpdate: false`, `messages: []`, `h3`, `purpose`, `note`). Fleet unchanged.
- `GET /context-budget/layers` gains `h3`; `GET /context-budget/metrics` topic rows gain `h3` (additive).
- `/capabilities`: the `contextBudget` description and the `topicMemory` endpoint list.
- CLAUDE.md: one Registry-First row, for new agents through the template and for existing agents through the migration.
- Persistent state: `h3/current` and `h3/legacy-retired` records in the layer store (replicated through the layer kind, dark until `stateSync.contextLayers`); the TopicMemory summary row is overwritten by H3 after the legacy row is retired.
- No new operator-facing action.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard file is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **`h3/current` and `h3/legacy-retired`: unified**, through the layer kind under the per-kind 64 KB raise (§14), dark until `stateSync.contextLayers`. An oversize H3 is rebuilt once under a tighter C2 selection, as §14 specifies.
- **The summary table row: machine-local by design today**, because TopicMemory is per machine. H3 writes it on the machine that builds H3, which is the machine whose session compacted (owner-acts, §14). A non-owner holds the replicated H3 record but its own TopicMemory row is not rewritten from it. On topic move, the new owner's first H3 build rewrites its row, and until then that row shows its previous content. Writing the table from replicated H3 records on non-owners is a Phase 1 follow-up <!-- tracked: CMT-1536 -->.
- No user-facing notices; no URLs.

## 8. Rollback cost

- `contextBudget.enabled: false` (at the next restart) removes H3: the route returns to its legacy behaviour, the summarizer is wired again, and the funnel admits the legacy writers. The table row keeps H3's last text until the summarizer next rewrites it. The legacy summary is still available as `h3/legacy-retired` in the layer store.
- A release revert is clean: additive files and fields, no schema migration.

## Conclusion

S9 makes H3, built from a bounded, disclosed selection of chunks and C2 ranges, the summary table's single writer while the layers are on. One funnel enforces it, a ratchet checks it, and the 409 and the summarizer stop are its visible edges. Fleet agents keep today's writers byte for byte.

## Second-pass review (if required)

**Reviewer:** Fable 5.2

Read independently: the spec (§6 row H3 and "Mapping to what exists", §6.4, §6.5, §12, §13 decision 10, §14, §15, §17, §18), the full diff and new files, then S8's `chunkBuilder.ts`, `LayerStore.ts`, `layerCadence.ts`, `contextLayerKind.ts` and TopicMemory's summary readers, and only then this artifact. Ran: the two unit files (32 pass), the integration file (2 pass), the e2e file (3 pass), `tsc --noEmit` (clean), and a throwaway reproduction outside the repo for the first and third findings below.

**What holds.** `saveTopicSummary` has one caller in `src/` (grep confirms; the ratchet tests it). The funnel refuses both ways and both sides are tested. `_contextLayers` is assigned (server.ts:13342) before the summarizer block (13933), so the "handed to H3" branch is real, and the live predicate would refuse a summarizer anyway. With the layers off, `TopicSummarizer` and both routes run the same statements as before behind an always-admitting funnel. The floor is never cut by the selection, the disclosure is in-band on the record and in the table text, the hard ceiling sends nothing, the debounce coalesces to one build plus one scheduled rebuild, builds are serialized per topic, a failed call refunds, and the oversize retry runs once. The per-field scrub cap (256K chars) is far above the 20K summary bound, so the table can never receive a `[REDACTED:oversize]` pointer.

**The two deliberate choices.**
- *Summarizer off for all topics under the layers, not per-topic handover.* Concur. §13 decision 10 ("the summarizer's writer is disabled at the same moment" as the switch) and §18's wiring line both say it; §6's "the moment H3 writes" is the looser sentence. A per-topic handover would add a race at the handover for a dev-gated switch. The cost (topics that never compact keep a frozen row) is stated in section 1 and visible as `not-built-yet`.
- *H3 authors its own purpose line.* Concur. §6.1 says that with no anchor H3 carries the purpose, and the line it replaces was model-derived too. It should move to the Anchor's derived line when that is built; worth a tracked note beside the existing ones.

### Blocking

None.

### Should-fix

1. **The legacy summary can be overwritten without being retired** — `src/monitoring/contextLayers/h3Builder.ts:497,512,521`. Retirement runs only when `previous === null` (no `h3/current` record before this write). Reproduced two ways, each ending with H3's text in the table and no `h3/legacy-retired` record:
   - the first build's retirement fails (a throwing `readSummary`, or a failed store write): the table is correctly left alone, but `h3/current` now exists, so the next build skips retirement and overwrites the row;
   - an `h3/current` record is already present when this machine first builds (a replicated record after a topic move, once `stateSync.contextLayers` is on): the local legacy row is overwritten with no retirement attempt.

   This contradicts the header comment ("never silently lost"), this artifact's "it never overwrites a summary it could not keep", and section 8's rollback note. Fix: stop keying on `previous`. Call `retireLegacy` before every table write; it already returns early when the legacy record exists. Add one guard so H3's own row is never retired as legacy: `if (!row || !row.summary || row.summary.startsWith('[Long-term view (H3)')) return true;`. Add a test for each reproduction.

2. **A floor over the hard ceiling stalls H3 for the topic with no loud signal** — `h3Builder.ts:463-467`, `src/commands/server.ts` H3 `onEvent`. Current-phase chunks stay in the floor even after their range closes, so the range-close request cannot shrink a floor that is large because the phase is long. Past 64K the build defers on every request until the phase changes, and with the summarizer off the table row freezes. `deferred` and `floor-over-budget` reach only the in-memory counters; `onEvent` forwards `written`, `error`, `refused` and `table-refused` but not these. Deferring is the right reading of "never dropped" plus P19; the gap is that a sticky state looks like a transient one. Fix: forward `deferred` events whose detail starts `floor-over-ceiling` to `featureEvidence` as an error (rate-limited per topic), or raise one degradation record per topic.

3. **Old ranges are dropped entirely at the 24K cost default, where the spec says "read through C2 only"** — `h3Builder.ts:206-213`. §6.5 and §12 give the budget's consequence as older ranges falling back to their C2 summary; omission appears in the spec only for the oversize rebuild (§14 "tighter C2 selection"). Here, once the floor passes 24K every range is omitted, and once the C2 summaries alone outgrow the remainder the oldest go. H3 does not read its previous version, so that history leaves the summary table (disclosed, with a lookup pointer). Fix: admit C2 blocks up to the hard ceiling rather than the cost default, keep the 24K default governing only the direct-read upgrade in pass 2, and omit only past the ceiling. If the current behaviour is intended, record it in section 4b as a deviation from §12's stated consequence.

### Nit

- `h3Builder.ts:254` — `Math.max(...ids)` throws `RangeError` on a very large id list (reproduced at 200K ids; the build then fails on every attempt). Not reachable at realistic topic sizes, but a `reduce` removes it.
- `h3Builder.ts:244,254` — `lastMessageId` counts the ids of pending (unsummarized-gap) chunks as covered, so the `as of … N messages behind` stamp can read fresher than the text. Take the max over closed blocks only, or say so in the disclosure.
- `h3Builder.ts:457-461` — `requestRangeClose` runs outside the chunk builder's per-topic chain, and the `closed` event fires just before the chunk builder's own `maybeCloseRange` (chunkBuilder.ts:601-602). Under a floor over budget both can call the model for the same range. The range id is deterministic so there is no duplicate record, only a doubled call and a doubled `c2` count.
- `h3Builder.ts:481-482` — H3 reserves up to ~29K tokens per build from the same 400K per-topic daily budget as H1 ticks and chunks. With chunks only on PostCompact this is fine; before the span-close and watermark triggers land, give H3 its own share so it cannot defer H1.
- `h3Builder.ts:185-188` — a non-numeric `boundaryMessageId` silently falls back to `sourceMessageId` (the latest H2 update), which narrows the phase floor without a signal.
- `src/commands/server.ts` — `_h3Builder.stop()` is never called at shutdown. The timers are unref'd, so this is tidiness only. If the chunk-builder block throws before the H3 lines, the layers are on with no summary writer at all; the existing degradation record names only `contextBudget.layers.chunks`.
- Tests: no case for retirement failing and then a later build (finding 1), none for a pre-existing `h3/current`, and the tight rebuild's second `oversize` outcome (local-only record, still counted `written`) is unasserted.

**Verdict:** Concern raised: the legacy rolling summary can be overwritten without retirement (reproduced two ways), contradicting the artifact's stated guarantee; fix that, and surface the floor-over-ceiling stall, before commit.

### Author's response (Echo)

Should-fix, all fixed in this commit:

1. **Retirement before every write.** `writeTable` no longer keys on a previous `h3/current`; it calls `retireLegacy` before every table write (early return once `h3/legacy-retired` exists) and refuses the write when retirement fails. H3's own row is recognised by the exported `H3_TABLE_PREFIX` (the header `renderH3` writes) and is never retired. Tests: a throwing `readSummary` leaves the row, then the next build retires and writes; a pre-existing (replicated) `h3/current` still retires the local legacy row; two H3 builds retire nothing.
2. **The floor-over-ceiling stall is loud.** server.ts's H3 `onEvent` forwards `floor-over-budget` and `deferred: floor-over-ceiling` to `featureEvidence` as an error, rate-limited per topic (one per hour), beside `error`, `refused` and `table-refused`.
3. **C2 is admitted up to the ceiling.** `selectH3Inputs` takes `ceilingTokens` (default the 64K hard ceiling): pass 1 admits every range's C2 summary up to the ceiling, and the 24K default governs only pass 2's direct-read upgrade. Omission happens only past the ceiling, or past the oversize rebuild's own cap (half the budget, C2 only, as §14 allows). The builder passes its configured ceiling. Tests: with a 1-token budget all three ranges are read through C2 with none omitted; omission appears only with a matching ceiling.

Nits fixed: `lastMessageId` uses a `reduce` (no spread) and counts only closed blocks (a pending gap's ids are not "covered"; test added); the chunk-builder wiring degradation now names H3 and says the summary is not rewritten on that machine.

Nits recorded, not fixed <!-- tracked: CMT-1536 -->:
- the possible doubled C2 call when H3's range-close request races the chunk builder's own check (no duplicate record; deterministic range id);
- H3 sharing the per-topic `LayerUpdate` budget with H1 and chunks, to revisit before the span-close and watermark triggers land;
- the non-numeric `boundaryMessageId` fallback to `sourceMessageId`;
- `_h3Builder.stop()` at shutdown (timers are unref'd);
- the tight rebuild's second `oversize` outcome (local record kept, counted `written`).

H3's own purpose line moves to the Anchor's derived line when that line is built <!-- tracked: CMT-1536 -->.

**Resolution check (same reviewer):** Fable 5.2, read against the code rather than the response. (1) Resolved: `writeTable` (h3Builder.ts:540) calls `retireLegacy` before every table write and returns without writing when it fails; `retireLegacy` (572) treats a row starting with `H3_TABLE_PREFIX` as H3's own, and `renderH3` builds its header from the same constant, so the two cannot drift. My two reproductions from the first pass now both end with an `h3/legacy-retired` record holding the legacy text. (2) Resolved: the H3 `onEvent` in server.ts forwards `floor-over-budget` and `deferred: floor-over-ceiling` to `featureEvidence` as errors, at most hourly per topic and kind, and the wiring degradation record now says H3 is absent and the summary is not rewritten. (3) Resolved: pass 1 of `selectH3Inputs` (223) admits C2 blocks up to `max(budget, ceiling)`, pass 2 (236) upgrades to direct reads only under the budget, and the builder's `sel.tokens > ceiling` deferral can now only mean the floor alone is over the ceiling; the tight rebuild keeps its own half-budget cap, as §14 allows. Nits: `lastMessageId` (257, 268) excludes pending chunks and uses `reduce`; the 200K-id case that threw now returns. The five recorded nits are fair to defer and each carries a tracking marker. Ran: `tests/unit/context-layer-h3.test.ts` (34 pass), `tests/e2e/context-layer-h3-alive.test.ts` (3 pass), `tsc --noEmit` (clean); the integration file was not re-run after these edits. One leftover for the author: "Evidence pointers" below still says 30 unit tests and does not list the four new cases.

**Verdict:** Concur

## Evidence pointers

- **Unit:** `tests/unit/context-layer-h3.test.ts` (34 tests). It covers:
  - the selection: direct ranges, C2 and omission under a tight budget with the floor kept, current-phase chunks inside a range, pending gaps and the pre-layer pointer, the phase boundary from H2;
  - the validator (six refusal shapes, faithful quotations);
  - the funnel, both owners, with error propagation;
  - the TopicSummarizer on both sides;
  - the builder: record plus table with legacy retirement; layers-off refusal; nothing to build; budget denied; refund on a failed call; refused output; no model; range-close request and the hard ceiling; the oversize tight rebuild; the prompt fence;
  - the debounce window and the fold bypass;
  - `measureH3`;
  - the review fixes: a failed retirement followed by a later build, a pre-existing (replicated) `h3/current` still retiring the local legacy row, H3's own row never retired, a pending chunk's ids not counted as covered, and C2 read (never dropped) past the budget with omission only past the ceiling;
  - the single-caller ratchet.

  Also `tests/unit/migrate-context-budget-h3-row.test.ts` (2), plus the LLM ratchets, the routing, completeness and regression files run green (listed in the commit report). `tsc --noEmit` is clean and `npm run lint:parallel` passes all 52 steps.
- **Integration:** `tests/integration/context-layer-h3.test.ts` (2 tests, real AgentServer and a real TopicMemory):
  - layers on: PostCompact → chunk → H3 → table, `/topic/summarize` `writer: h3` before and after the build, `POST /topic/summary` 409 with the row unchanged, `/context-budget/layers` h3 counts, `/capabilities`;
  - layers off: the legacy shapes, unchanged.

  `topic-memory-routes`, `context-layer-chunks`, `context-budget-metrics-route` and `context-layer-anchor-ledger` still pass.
- **E2E:** `tests/e2e/context-layer-h3-alive.test.ts` (3 tests): the production boot path with the layers on ends with H3 in the table (200, writer h3, a second writer 409); a fleet agent keeps the legacy writer; WIRED source checks. `topic-memory-lifecycle`, `context-layer-chunks-alive`, `context-budget-metrics-alive` and `context-layer-anchor-ledger-alive` still pass.

## Class-Closure Declaration (display-only mirror)

Not a defect fix. Class `n/a`, closure `n/a`.
