# Quota fallback that doesn't freeze the server — Plain-English Overview

> The one-line version: when Anthropic's "how much of your allowance is left?" service told us to slow down, the server tried to work out the answer itself by re-reading a week of conversation logs — all at once, over and over — and froze for up to a minute each time. Now it waits as long as Anthropic asks, and gets its estimate from a running total it already keeps.

## The problem in one breath

Every minute or few, the server asks Anthropic how much of the weekly Claude allowance is used. On 2026-09-22 Anthropic kept answering "too many requests — try again in 30 minutes." Each time that happened, the server fell back to estimating usage itself by opening every Claude conversation log from the past seven days (about 34,000 files, many gigabytes) and reading every line — in one uninterruptible pass. While it did that, the server could not answer anything else: not the dashboard, not the health check, not the other machines. The Mac Studio concluded the laptop's server was down.

It also made the rate limit worse: on each poll, the server re-asked Anthropic up to three more times, 30 seconds apart, even though Anthropic had just said to wait half an hour.

## What already exists

- **The quota collector** — asks Anthropic for real numbers and keeps the allowance tracker up to date. Its job doesn't change.
- **The token ledger** — a background job that already reads those same conversation logs a little at a time, remembers where it left off, and keeps a running total in a small database. It never freezes the server.
- **A 429 circuit breaker** — after three "too many requests" answers in a row, the collector used to pause for 30 minutes. But during that pause it ran the expensive re-read on every poll.

## What changes

1. **We wait as long as we're told.** When Anthropic says "try again in N seconds," the collector stops asking for that whole time (capped at 6 hours in case of a nonsense value) — starting with the first such answer, not the third. It also stops the pointless 30-second in-poll retries when the wait asked for is longer than it is willing to sleep.
2. **The estimate comes from the running total.** While Anthropic's numbers are unavailable, the estimate is read from the token ledger with one quick database query. No log files are opened.
3. **If the ledger isn't available, a careful reader takes over.** On an install where the ledger failed to start, a new built-in reader remembers how far it got in each file, reads only what's new, gives the server a turn between files, and caps how much it reads per poll. Until it has caught up, it reports "no estimate yet" rather than a number that would be too low.

## The safeguards

- **Nothing new decides anything.** The same tracker, thresholds and spawn rules consume the reading. Only how the estimate is produced changed.
- **The built-in reader never reports a partial total.** Until it has caught up, it gives no estimate rather than a smaller one. The ledger path has the ledger's normal lag. It updates about once a minute (every 5 minutes when idle). A brand-new ledger on a machine with deep history needs up to about an hour to catch up, so an estimate taken in that window can read low. An existing agent's ledger is already caught up. This was already true of every other ledger-based number, and the estimate is labelled "estimated" either way.
- **Real numbers resume on their own.** When the wait is over, the collector asks Anthropic again as before; a successful answer clears the pause.
- **Each request is counted once.** Claude Code writes a request's usage on several log lines. The old re-read counted every one, about twice the real number. The ledger and the new reader both count each request once. So the estimate will now read roughly half what the old one did for the same work. That's the correct token count, but the "weekly budget" it's compared against is a rough guess, so treat the estimate as ballpark. The real number from Anthropic takes over again as soon as the wait ends.

## What you need to decide

Nothing. This is a bug fix with no new setting and no migration. Existing agents get it on their next update and restart.

## Evidence

- End-to-end test over ~72 MB of logs with Anthropic answering 429: timers keep firing during the fallback (longest gap well under 75 ms), one request to Anthropic per wait window, and the next poll opens only the one file that grew. The same test against the old code fails: only 2 timer ticks got through during the whole scan.
- Integration test boots a real server and confirms the collector is connected to its real token ledger. The estimate comes from the ledger, not from a decoy log file, and no log file is opened. With the connection removed, the test fails.
- Unit tests cover: retry-after honoring (first 429, 6-hour cap, zero-second blips), in-poll retry short-circuit, and ledger-unavailable handling. For the incremental reader they cover appended-bytes-only reads, partly written lines, the per-poll budget, shrunk files and shared concurrent passes.
