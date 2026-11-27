# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

While Anthropic's quota endpoint was rate-limiting requests (HTTP 429), the quota collector estimated usage on every poll by synchronously reading and parsing every Claude Code transcript from the past seven days. On a machine with deep history (about 34,000 files), that froze the agent server for 30-80 seconds every few minutes. Health checks timed out, the dashboard stopped responding, and other machines in the pool reported the server as down.

Two changes fix it:
- **Wait as asked.** The collector now honors the endpoint's `retry-after`. On the first 429 carrying a wait, it stops polling the endpoint for that whole window, capped at 6 hours. It no longer re-sends the request up to three more times inside the same poll when the wait asked for is longer than it will sleep.
- **Estimate from the ledger.** The usage estimate used during that window now comes from the token ledger's 7-day total, one indexed query. The ledger already maintains that total incrementally in the background. On an install where the ledger is unavailable, a new built-in reader takes over:
  - It reads only newly appended bytes.
  - It yields to the event loop between files.
  - It caps its reading per poll.
  - It gives no estimate until it has caught up, rather than an undercount.

Both estimate sources now count each request once. Claude Code writes a request's usage on several transcript lines, and the old parser counted every one, roughly doubling the figure. For the same activity, the estimated weekly percent therefore reads about half what it used to. It is still labelled "estimated", and the authoritative reading from Anthropic replaces it as soon as the wait ends.

## What to Tell Your User

If you ever saw my server stop responding for a minute at a time, or another of your machines report this one as down while Anthropic's usage check was being rate-limited, that's fixed. When Anthropic asks me to wait before checking usage again, I now wait the full time. Meanwhile I estimate usage from a running total I already keep, instead of re-reading a week of conversation logs all at once. That stand-in estimate also stops double-counting, so while I'm waiting on Anthropic it may show a lower usage figure than before. The real figure comes back once the wait ends.

## Summary of New Capabilities

- The quota collector honors the OAuth usage endpoint's `retry-after` from the first 429, capped at 6 hours, and skips futile in-poll retries.
- The estimated-usage reading comes from the TokenLedger's 7-day total (no transcript reads on the polling path), counting each request once.
- A non-blocking, incremental, byte-budgeted transcript reader is used when no ledger is available.

## Evidence

- End-to-end test: with the endpoint answering 429 over a ~72 MB transcript fixture, timers keep firing throughout the fallback (longest gap under 75 ms). There is one request to the endpoint per wait window, and the next poll opens only the file that grew. Against the previous code the same test fails: only 2 timer ticks got through during the scan.
- Integration test on a real server: the collector is wired to the real token ledger. The estimate matches the ledger total, not a decoy transcript, and no transcript is opened. Removing the wiring makes it fail.
- Production diagnosis on the affected machine: a CPU profile attributed the freezes to the synchronous transcript scan. After a hotfix disabling that scan, 240 of 240 health checks answered promptly, with zero event-loop blocks.
