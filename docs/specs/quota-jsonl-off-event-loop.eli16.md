# ELI16 — estimating Claude usage no longer freezes the server

## What was wrong

The agent tracks how much of its Claude usage allowance it has used. Its first choice is to ask Anthropic directly. When that fails, it falls back to estimating: it reads the last seven days of its own Claude conversation logs and adds up the token counts in them. On a busy machine those logs are large — in the report for instar#2120, 1,875 files totalling about 1.8 GB.

The estimate read each file in one go and decoded every line, one file after another, on the same thread that answers every request to the server. While it ran, the server answered nothing: not health checks, not messages forwarded from another machine, not the check that decides which machine is in charge. A test server froze for 3 to 20 seconds roughly every one to two and a half minutes while its neighbour on the same machine answered in a millisecond or two. A CPU profile pinned the time on exactly this code.

## What changes

- Each log file is now read as a stream, a small piece at a time, so other requests get answered between pieces.
- The server also pauses briefly between files.
- Lines that cannot possibly be Claude's replies (they do not contain the word "assistant") are skipped without being decoded, which cuts most of the work.

The numbers do not change. The same rule decides which lines count, and a test checks that the streamed reading returns exactly the same totals as the old reading on messy input: broken lines, Windows line endings, old entries, and user messages.

## What you need to decide

This is a bug fix with no decision for the operator.
