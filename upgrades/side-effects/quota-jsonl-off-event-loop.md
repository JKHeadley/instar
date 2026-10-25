# Side-Effects Review — Claude usage fallback reads its files without freezing the server

**Version / slug:** `quota-jsonl-off-event-loop`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (observability-only read path)`

## Summary of the change

instar#2120. When the OAuth quota read fails, `QuotaCollector.collectFromJsonl` estimates usage from the last 7 days of Claude JSONL transcripts. It read each file whole with `readFileSync`, split it, and `JSON.parse`d every line, serially, on the event loop: with 1,875 files / ~1.8 GB the server stopped answering `/ping` and `/health` for 3-20 s every 1-2.5 minutes (CPU profile: `collectFromJsonl` / `parseFile` / `readFileSync` hottest frames). Now `collectFromJsonl` is async: each file is streamed line by line (`JsonlParser.parseFileAsync`, `node:readline` over a read stream) and the loop yields with `setImmediate` between files. Per-line logic moves to `JsonlParser.accumulateLine`, shared by the sync `parseFile` (kept for its callers) and the streamed path, so both count identically. Lines without the substring `assistant` are skipped before `JSON.parse` — an assistant entry always contains it, so results are unchanged and most lines (tool results, user turns) cost a substring check instead of a parse.

## Decision-point inventory

None. Estimated quota is observability; the result shape and confidence label ('estimated') are unchanged.

## 1. Over-block

Nothing is refused.

## 2. Under-block

The total CPU work is the same minus skipped parses; it is now spread across many short turns instead of one long one. A faster OAuth path remains the primary source. Caching per-file counts by mtime would cut repeated work further but complicates the sliding 7-day window; not needed to remove the freeze.

## 3. Level-of-abstraction fit

The fix is in the one function that did the blocking work; the polling loop and its cadence are untouched.

## 4. Signal vs authority compliance

No authority added or changed.

## 4b. Judgment-point check

Not a decision point.

## 5. Interactions

`collect()` was already async and awaited by `QuotaManager`; only the fallback step now awaits. A collection takes longer in wall-clock time while other requests interleave; overlapping collections are already serialised by the existing collect flow. The CRLF case is handled identically (readline `crlfDelay: Infinity`; the sync path's trailing `\r` is ignored by `JSON.parse` whitespace rules) — covered by a parity test.

## 6. External surfaces

None. Same quota values; the server stays responsive during the fallback.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine reads its own transcripts.

## 8. Rollback cost

Revert the commit; no state or schema change.

## Conclusion

Removes a multi-second event-loop stall from the quota fallback without changing what is counted; parity and responsiveness are pinned by tests.
