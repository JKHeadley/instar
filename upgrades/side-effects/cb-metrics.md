# Side-Effects Review — Context budget measurement backend and the all-homes token ledger (Phase 1 S13)

**Version / slug:** `cb-metrics`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

Phase 1 slice S13 of `docs/specs/context-budget-layered-summaries.md` (§11 Measurement, the §17 "Rework" row, §14's `liveSetBudget` "sized in Phase 1 from measured G/C growth"). Stacked on S4 (`cb-topic-intent-layer`).

**Defect fix (fb-7e0b2088-ae5): the TokenLedger read only `~/.claude/projects`.**

- `AgentServer.ts` hard-coded that root. Pooled sessions run under their login's config home (`~/.claude-followme-<account>`), and the Mama PC ledger held 293 events in all.
- New `src/monitoring/claudeTranscriptRoots.ts` unions three sources: the process default home, every `~/.claude` / `~/.claude-*` directory (`listClaudeConfigHomes`, the same enumeration the agent-owned memory link uses), and every claude-code account's `configHome` in the subscription pool.
- `TokenLedger` takes `claudeProjectsDirs` (a function, re-read each scan). Roots and project folders are de-duplicated by real path. The existing cursor walks the combined, sorted folder list.
- Sessions copied into two homes dedupe because every row is keyed by an engine id: `request_id` (existing), `tool_use_id`, or entry `uuid`.

**Ledger additions (additive schema).**

- `token_events.cache_write_1h_tokens` (nullable): the 1-hour share of cache writes.
- `tool_inputs`: a hash of the normalized Read path or Bash command, keyed by `tool_use_id`. No text.
- `session_prompts`: `[telegram:N` operator prompts. Topic, time and session only, no text.
- `compact_boundaries`.
- `session_files`: session → transcript files, for the `pending` read.
- `ingestLine` records these side rows from the line it already parses (`ingestSideRecords`, never throws). The three time-keyed tables prune on the token_events retention schedule.
- New read methods: `sessionRequestTotals`, `contextSizeSeries`, `reworkForSession`, `sessionScanLag`, `sessionTopics`, `promptsInContext`, `projectRoots`.

**Measurement.**

- `src/monitoring/contextBudgetMetrics.ts`: cost weighting (Phase 0 weights), rework with freshness (`pending` while the poller lags), per-session and per-topic rollups, U size, verbatim share, archive and layer bytes, G/C growth inputs, layer spend against the reserve. Anchors read `unavailable: anchor-ledger-not-built`.
- `src/monitoring/contextLayers/layerSpendLog.ts`: per-day, per-trigger LayerUpdate attempts, calls and provider-reported tokens. Kept 35 days at `<stateDir>/server-data/context-budget-layer-spend.json`.
- `TopicIntentCapture.ts` has an optional `onLayerOutcome` observer (the inner functions are unchanged and wrapped). `TopicIntentExtractor.createLlmExtractFn` has an optional `onUsage` observer.
- `layerCaptureWiring.ts` records each attempt in the rollup and as a `LayerUpdate` row (kind `event`) on `/metrics/features`.
- `TopicMemory.operatorCorpusSize`.

**Surface.**

- `GET /context-budget/metrics` (`routes.ts`; bearer through the global auth middleware; `?topic=`, `?sinceHours=` ≤ 720; ≤ 50 sessions, ≤ 50 topics, ≤ 48 series points; 400 on a bad query; 503 while the layers are off).
- The CapabilityIndex `contextBudget` row lists it.

## Decision-point inventory

- **Transcript-root selection** (modify): which directories the ledger reads. Observability only. It widens what is measured and decides nothing about a session.
- **Rework repeat** (add): a Read or Bash input whose normalized hash was seen within 30 earlier requests of the same session. Measurement only.
- **`pending`** (add): unread transcript bytes AND a last read older than 6 minutes (the poller's idle cadence plus one). A display state, never a gate.
- Nothing here gates a message, a session, a job or a spend.

---

## 1. Over-block

No blocking surface. The route refuses only a malformed query (400) or a disabled feature (503). The ledger change cannot refuse anything.

## 2. Under-block

- **Rework under-counts by design.** Only Read and Bash are counted; Grep, Glob, Edit and MCP tools are not. Offset and limit are ignored, so a re-read of another range counts as a re-read (over-count in that one case). Commands are compared after whitespace normalization only, so `npm test` and `npm run test` are different commands.
- **The verbatim share sees only `[telegram:N`-tagged prompts.** Slack, app and terminal prompts are not counted. The share is "of the operator prompts the ledger recognised", stated as `delivered`.
- **Session → topic placement** comes from those same prompts. A session with no Telegram prompt in the window has `topicId: null`.

## 3. Level-of-abstraction fit

- The roots fix lives where the roots were hard-coded (AgentServer → TokenLedger options). The enumeration reuses `listClaudeConfigHomes`; the ledger owns de-duplication.
- Rework lives in the ledger scan, as §11 and §17 specify ("computed in the TokenLedger scan, eventually consistent").
- The metrics module only composes existing stores; it owns no state except the spend rollup, which belongs to the layers.

## 4. Signal vs authority compliance

Pure observability. Every new number is a signal for the §16 rung review. None of it gates anything, and the spec says so ("evidence … not trip-wires").

## 4b. Judgment-point check

- The 30-turn rework window is the spec's number (§11).
- The 6-minute lag tolerance is a display threshold. Its consequence is only whether a rate reads `pending`.
- The cost weights are the Phase 0 baseline's published ratios.

## 5. Interactions

- **Burn detector.** It reads `token_events` totals. More homes means more real events, so per-key shares become accurate rather than drawn from a 2% sample. The first scans after upgrade backfill up to 30 days of the newly visible homes at no more than 500 files and 64 MB per tick (8 MB per file per call, yielding every 4 MB), so its 24-hour rates jump to the true level once. That is the correct level, not a burn. The burn detector's absolute-share activity floor applies as before.
- **Ingest cost.** Each line was already parsed. Assistant lines now also walk their content array for `tool_use` blocks. User lines run one regex. Inserts are prepared statements inside the existing per-file transaction.
- **Capture loop.** The observers are wrapped in try/catch and run after the outcome is decided. With the layers off, `onLayerOutcome` is absent and behaviour is byte-identical.
- **Route cost.** Synchronous SQLite reads per session: a few small indexed queries plus up to 20 `stat`s, for at most 50 sessions. Directory stats per topic (≤ 2,000 files per record type), for at most 50 topics. Memoized for 30 s per query shape.

## 6. External surfaces

- A new read-only authenticated route, 503 on the fleet (the layers are dev-gated).
- `/metrics/features` gains a `LayerUpdate` row on development agents.
- `/tokens/*` numbers rise on pooled agents, because they now include the sessions that were always there.
- No outbound messages, no new switch.

## 6b. Operator-surface quality

Not applicable. No dashboard file is touched; the card is S14.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Each machine's ledger reads that machine's transcripts. The spend rollup counts that machine's capture calls. The route reports one machine. A pool-wide view is the dashboard card's concern (S14). <!-- tracked: CMT-1536 -->

## 8. Rollback cost

- `contextBudget.enabled: false` removes the route (503), the spend rollup writes and the LayerUpdate rows at the next restart.
- The ledger's all-homes scan is unconditional. A revert returns it to `~/.claude/projects`. The new tables and the column are additive, and older code ignores them.
- No data migration.

## Conclusion

S13 gives §11 its numbers on real data and removes the reason those numbers would have been wrong: the ledger now sees every login's sessions.

## Second-pass review (if required)

**Reviewer:** Fable 5.2 (independent subagent, read-only).

**First pass:** CONCUR, no blocking items. Eight should-fix items, all fixed in this commit:

1. **Compactions counted twice.** A real compaction writes a `compact_boundary` line and an `isCompactSummary` line. `promptsInContext` now collapses entries less than 60 s apart, and a fixture with both lines asserts one compaction.
2. **`overall`, the session count and topic cost were silently capped at 50 sessions.**
   - New `TokenLedger.windowTotals` is an uncapped aggregate.
   - The response states `sessionsInWindow`, `sessionsListed` and `sessionsTruncated`.
   - Topic cost aggregates all of the topic's sessions.
   - A topic with no session in the window reads `unavailable: no-session-in-window`. Topic rework carries `sessionsCounted` and `partial`.
3. **Session → topic came from in-window prompts only.** It now comes from all-time prompts, so a long autonomous session keeps its topic.
4. **The first all-homes backfill blocked the event loop for about 73 MB between yields.**
   - A per-call byte cap per file (8 MB) means a cut file keeps the scan cursor and resumes from its offset.
   - A per-scan byte budget (64 MB) bounds each tick.
   - The async scan also yields every 4 MB.
   - Tests prove that capped reads resume to identical totals.
5. **Rework was silently partial for files part-read before the upgrade.** `session_files.side_from_offset` records where side recording began, and a non-zero value reads `partial-before-upgrade`.
6. **`pending` covered only rework, and was judged on the oldest copy.** Lag is now judged per file (`laggingFiles`). One session-level `ledgerFreshness` is shared by cost, live context, rework and the verbatim share.
7. **The in-memory budget read 0 after a restart.** Both budget figures are labelled `inMemorySinceBoot` with `processStartedAt`. The persisted provider tokens are in `extractorByDay`.
8. **Route cost.** The result is memoized for 30 s per query shape, and growth walks are capped at 2,000 files with a `truncated` flag.

NITs fixed:

- The per-project-dir `realpathSync` is dropped (roots only).
- `~/.claude-*.lock` login-lock directories are skipped.
- Topics are ordered by last activity, with `topicsTruncated`.
- The reason strings are corrected (`no-capture-telemetry`, `topic-memory-not-wired`).
- A degraded attempt no longer counts as an extractor call.
- `topic=0` is rejected.
- `session_files` is pruned with retention.
- Tool-input hashes use a per-DB random salt (`ledger_meta`).
- The verbatim share names its `channel: 'telegram'`.

NIT recorded: the CLAUDE.md awareness line lands with S14 (see Agent awareness). <!-- tracked: CMT-1536 -->

**Resolution check (second pass):** CONCUR. Items 1–8 are RESOLVED, as are the NITs, except the CLAUDE.md line deferred to S14. The check raised two new items:

- **A. A false `partial-before-upgrade` after a retention prune.** Fixed: `session_files` now prunes rows for transcripts not read since the cutoff (or with no offset row), never on "no events", so a re-inserted row can no longer carry a non-zero start offset. Only reachable with retention on, which ships dark.
- **B. NIT, recorded.** The 8 MB cut can land inside a UTF-8 character, so the stored offset is at most 3 bytes early. It errs early only: one malformed fragment is skipped and no line is lost. <!-- tracked: CMT-1536 -->

The reviewer also notes the expected consequence of item 4: a 1.1 GB backlog takes about 17 ticks to drain. During that time live sessions read `pending` and burn data lags. That is honest by design.

Residual NIT: `sessionIds` lists are capped at 500 or 2,000 ids per query without a flag; a topic with more sessions than that is not reachable in practice. <!-- tracked: CMT-1536 -->

## Evidence pointers

- **Unit:** `tests/unit/context-budget-metrics.test.ts` (14 tests). Also covers per-file lag, `partial-before-upgrade`, byte-capped resumable reads, one compaction from two lines, uncapped overall with all-time topic mapping, and the prune regression (A). Original scope: cost weighting; the 1 h split; rework (re-read, re-run, a different command, a far repeat and a same-request repeat not counted, a copied entry idempotent); `pending`; the ledger scanning a follow-me home with cross-home dedupe and the old single-root behaviour as the positive control; pool roots; the spend rollup; Anchors unavailable; per-topic numbers.
- **Integration:** `tests/integration/context-budget-metrics-route.test.ts` (3 tests): the real route behind the real auth middleware, a real ledger over two config homes, a real TopicMemory, TopicIntentStore and capture loop, and a real FeatureMetricsLedger; 401, 503, 400.
- **E2E:** `tests/e2e/context-budget-metrics-alive.test.ts` (3 tests): the production option shape under a real home, 200 with non-empty numbers, 503 on the fleet, and WIRED source checks.
- **Ratchets:** topic-ref-ratchet, no-silent-fallbacks, no-silent-llm-fallback, feature-ladders-coverage, CapabilityIndex, capabilities-discoverability. The existing TokenLedger and capture unit tests are green, run one file at a time with `--maxWorkers=1` (token-ledger 22, job-sessions 7, codex 10, retention 3, burn-attribution 14, poller-codex 18, layer-cadence 14, capture-extractFn 8). Also green: integration context-layer-topic-intent, tokens-503-regression and context-layer-store, and e2e context-layer-topic-intent-alive and context-layer-store-alive. `tsc --noEmit` is clean.

## Agent awareness

The route is discoverable through `/capabilities` (the `contextBudget` row). A Registry-First line in the CLAUDE.md template, with its `migrateClaudeMd` step, lands with the S14 card that gives it an operator surface. <!-- tracked: CMT-1536 -->

## Class-Closure Declaration (display-only mirror)

Not in the class-closure gate's scope: no agent-authored artifact or self-action controller is touched. The ledger fix is an observability defect in a read-only instrument. Class `n/a`, closure `n/a`.
