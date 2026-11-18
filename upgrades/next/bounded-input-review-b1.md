<!-- bump: patch -->
## What Changed

First batch of the bounded-input derivation review (10 of 43 sites, all in `src/core`). Where a model or classifier was handed a silently cut piece of the data it decides from, the cut is now either removed, moved to the right end, or disclosed in-band. Three real defects fixed on the way: Gemini calls decided "retry or fail" from only the first 600 characters of the error output, so a quota line printed later made a retryable call fail; the outbound-message check judged a standing approval from a 280-character piece that could leave out the approval words themselves; and the promise tracker read only the first 16,384 characters of a reply, so a closing promise ("I'll follow up in an hour") at the end of a very long one was never seen. Five other sites were reviewed and kept, each with its reason written on the line. The review baseline goes from 43 to 33.

## What to Tell Your User

Nothing to do. Your agent is a little more reliable in three places: a Gemini call that hit a rate limit now waits and retries instead of failing, a permission you already gave in a long message is now recognized, and a promise at the end of a very long reply is now tracked.

## Summary of New Capabilities

- Gemini rate-limit handling reads the whole error output.
- Standing approvals in long messages are seen whole (up to Telegram's message limit).
- Promise tracking keeps the start and the end of very long replies.
- The guideline-approval message offers the full text of a cut preview.

## Evidence

New unit cases fail on the old code and pass on the new: a Gemini rate-limit line after 2,000 characters of warnings now retries; an approval phrase past character 280 reaches the check; a long reply keeps its closing promise and its first 16,384 characters unchanged (the dedup key). `lint-bounded-judgment-input` is clean at 33. Per-site readings: docs/audits/bounded-input-review/batch-1.md.
