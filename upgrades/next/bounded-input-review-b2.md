<!-- bump: patch -->
## What Changed

Second batch of the bounded-input derivation review (11 more baseline entries). Session history handed to a fresh or revived session no longer cuts each message at 2,000 characters: every Telegram message (up to 4,096) now arrives whole, and a longer one says it was cut. Before, a long instruction from the operator could reach the new session half-cut with no sign. The fix covers every place that renders that history. The preload ranker now keeps the file name of a long path instead of its start. The temporal coherence check now keeps the start and the end of a long state document, where the newest thinking usually is, instead of only the start. The topic summarizer, the promise-revival prompt and the helper-death alert now say in the text when they shortened something. The review baseline goes down by 10.

## What to Tell Your User

Nothing to do. When I start a new session for one of our conversations, I now see your longer messages in full instead of only the first half.

## Summary of New Capabilities

- Fresh sessions receive each recent Telegram message whole.
- Cut inputs to the summarizer, coherence checks and alerts are disclosed to the model.

## Evidence

New unit cases fail when only the changed lines are reverted to the previous code: a 3,000-character instruction now reaches the session whole; a 9,000-character one is cut and disclosed; a long path keeps its file name; a cut state document keeps its newest section; a cut summarizer message is disclosed. Per-site readings: docs/audits/bounded-input-review/batch-2.md.
