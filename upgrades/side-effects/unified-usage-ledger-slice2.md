# Side-Effects Review — Unified usage ledger, Slice 2 (Codex, intelligence calls, dedupe)

**Version / slug:** `unified-usage-ledger-slice2`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Second build slice of `docs/specs/unified-usage-ledger.md`. Three additions to `src/monitoring/UsageLedger.ts`:

1. **Codex rollouts.** `addCodexRoot` + `ingestCodexFile`: per-request rows are the deltas of the cumulative `total_token_usage` between consecutive `token_count` events, skipping unchanged totals (rate-limit refreshes). Input excludes cached input (`input_tokens − cached_input_tokens`), cache write is null (not reported). The checkpoint stores the byte offset plus the last total, session id, cwd and model in a new `extra` column, so a re-read resumes and never replays. A rollout whose `session_meta` marks it forked/resumed stores its first total as baseline and lists the inherited tokens in coverage as `codex_inherited_uncounted`; a decreasing total is listed as `codex_delta_mismatch`.
2. **Intelligence calls.** The funnel (`CircuitBreakingIntelligenceProvider`) emits one `UsageInvocationRecord` per call that ran (success or error, never a shed call) to a module-level sink. The ledger's `enqueueInvocation` is a bounded in-memory queue (10,000, oldest dropped, drop count in coverage) that can never throw into the caller; `flushInvocations` writes the rows, an `internal` binding for the provider session id, and the rollup deltas in one transaction at the start of each scan tick. `IntelligenceOptions.onUsage` gains an optional `detail` (disjoint parts, provider session id, reported dollars and basis); the Claude provider fills it from the `claude -p` JSON (`session_id`, the split usage block, `total_cost_usd` as `actual`), the Codex provider from the `thread.started` `thread_id` (newly captured by `CodexUsageAccumulator`) and its usage totals.
3. **Dedupe pairs.** A `pairs` table keyed by correlation key `(framework, provider session id)`. When an invocation exists, matching file rows are held (`status='held'`) and their token sums kept per rollup hour key; file rows already counted when the invocation arrives are moved to the held side with negative rollup deltas. `settlePairs` settles a pair once its file is read to the end and quiet for 2 minutes past the invocation end: agreeing token totals (within 0.5% or 2 tokens) move the tokens to the file side (`tokensOnly` deltas) while the invocation keeps its call count and dollars (`status='paired'`); disagreeing totals keep the invocation counted and record the excess as `disputed`. A second invocation on the same key marks the pair `ambiguous` (both invocations counted, file rows stay held — never double counted). `totalsFromEvents` now counts calls as invocations plus unpaired request rows so the rollup consistency check holds with pairs.

**Decided during the build (reversible, dark):** pi, Grok and Gemini usage is captured through the funnel invocation rows (Gemini reports no counts, so those rows carry null tokens and are counted in coverage as `invocations_no_counts`); no session-file reader is built for those engines yet, because Instar runs them only as one-shots today. The Codex reader runs on the main thread inside the shared per-tick file budget rather than the TokenLedger rollout worker: it reads only from each file's checkpoint, so the per-tick cost is the newly appended bytes. Both deviations are named in the spec's coverage terms, never hidden.

Wiring: `AgentServer` registers `$CODEX_HOME` (default `~/.codex`) and installs the funnel sink when the dev gate is on. Tier 2. Size: 6 source files changed, ~450 lines added, 1 new test file (13 tests), 3 existing assertions loosened to `objectContaining` because the usage report gained an additive field.

## Decision-point inventory

- Dedupe settlement (`UsageLedger.settlePairs`) — add — decides which side of a pair carries the tokens in the totals. Reporting only.
- Codex membership — reuse — the same spawn-record/cwd rule as Slice 1.
- No decision point that gates, blocks or routes any call is added or changed.

## 1. Over-block

Nothing is blocked. The funnel sink is a try/catch-wrapped enqueue; `enqueueInvocation` swallows every error. A full queue drops the oldest record, never the call.

## 2. Under-block

Not applicable (no gate). The under-count risks are listed in coverage instead: dropped queue entries, uncorrelated invocations, inherited Codex usage, delta mismatches, disputed pair tokens.

## 3. Level-of-abstraction fit

The funnel already owns per-call metrics (`FeatureMetricsRecorder`); the invocation sink follows the same module-level injection pattern so `core/` never imports `monitoring/`. Pairing lives in the ledger, next to the rollups it moves.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Pure signal. No LLM, no outward action, no authority over any decision. Settlement is deterministic arithmetic over stored sums.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point: agreement is a fixed tolerance (0.5% or 2 tokens), documented in the spec's terms.

## 5. Interactions

- `FeatureMetricsLedger` / `/metrics/features` keep receiving the same folded `tokensIn`/`tokensOut` (unchanged contract; `detail` is additive).
- `TokenLedger`, `/tokens/*`, BurnDetector: untouched.
- The Codex accumulator's line pre-filter now also lets `thread.started` lines through; it reads only `thread_id` from them.

## 6. External surfaces

None. No route, message or file outside `server-data/usage-ledger.db` changes in this slice.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface in this slice (the read API and console are Slices 4–5).

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local, like Slice 1: each machine records its own sessions and one-shots. Pairs and checkpoints describe this machine's files and stay local. Rollups and bindings are replicated by the Slice 4 pull.

## 8. Rollback cost

Turning `usage.ledger.enabled` off stops the sink being installed and the scan. The new `pairs` table and `extra` column are inert on disk. No migration of other stores.

## Conclusion

Safe to ship dark behind the existing dev gate. The record now covers Claude transcripts, Codex rollouts and every funnel one-shot, each counted once.

## Evidence pointers

- `tests/unit/UsageLedger.slice2.test.ts` — 13 tests: Codex deltas, unchanged-total skip, checkpoint resume, forked-rollout baseline, non-member rollout; queue bound and drops; invocation-only counting with dollars; dedupe in both arrival orders, flip of already-counted rows, disagreement with disputed tokens, settle-window wait; enqueue never throws after close.
- `tests/unit/UsageLedger.test.ts` (17), `CircuitBreakingIntelligenceProvider*.test.ts`, `ClaudeCliIntelligenceProvider-*.test.ts`, `CodexCliIntelligenceProvider.test.ts`: pass.
- `npx tsc --noEmit`: exit 0.
