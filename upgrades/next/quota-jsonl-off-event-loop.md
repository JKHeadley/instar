# Claude usage estimate no longer freezes the server

## What Changed

Fixes instar#2120. When the quota read from Anthropic fails, `QuotaCollector` estimates usage from the last 7 days of Claude JSONL transcripts. It read each file whole and parsed every line synchronously on the event loop; on ~1.8 GB of transcripts the server stopped answering for 3-20 s every 1-2.5 minutes.

- `JsonlParser.parseFileAsync` streams each file line by line; `collectFromJsonl` is async and yields between files.
- `JsonlParser.accumulateLine` holds the per-line rule for both the sync and streamed paths, so they count identically.
- Lines without `assistant` are skipped before `JSON.parse`; every counted entry contains it, so totals are unchanged.

## What to Tell Your User

When I can't get my usage numbers straight from Anthropic and have to estimate them from my own logs, I no longer freeze for several seconds while doing it. The estimate itself is the same.

## Summary of New Capabilities

None — the same estimate, without the freeze.

## Evidence

- `tests/unit/quota-collector.test.ts`: streamed and sync parsing return identical totals on mixed input (CRLF, malformed, out-of-window, non-assistant, missing timestamp); a 20 MB file lets a 1 ms timer fire during the read; all 56 tests pass.
- Original CPU profiles (in instar#2120) attribute the stalls to `collectFromJsonl` → `parseFile` → `readFileSync`.
