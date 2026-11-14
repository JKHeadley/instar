# Unified Usage Ledger — the plain-language version

## What problem is this solving?

Every time an agent thinks, it uses tokens. Justin wants to see exactly where those tokens go: which model, which engine (Claude Code, Codex and others), which conversation or job, which machine, and what it would have cost at normal API prices on the day it happened. He also wants it all to add up neatly to one total for the agent.

Today the agent keeps four separate notebooks of usage. They overlap, they don't agree, and almost nothing in them has a price. One notebook even reads the wrong folder: it counts other agents on the same computer and misses most of Echo's own conversations.

## What changes?

1. **Count the right things.** The agent reads its own conversations, including the helper conversations they start, and stops counting other agents' work.
2. **One line per model call.** Every call, from every engine, gets one row saying who made it and why: the conversation, job, feature, machine, login and model. Cache reads and writes get their own columns. If a number wasn't reported, the row says "unknown" rather than 0.
3. **Prices.** We add the published API prices for the models we use, each with the date it applies from. Whenever usage is shown, it's priced at the rate that applied on the day it happened, so it's always "cost at the time". If a price is corrected or added later, all past figures pick it up automatically. If a model has no published price, the dashboard says so clearly and never pretends it was free.
4. **The tree.** Totals are kept per hour and per day, and add up from a single call to a conversation or job, then to a machine, then to the whole agent. The agent also combines all its machines into one view.
5. **Charts.** The cost page gains usage over time, a drill-down wheel from the agent down to single conversations, the most expensive topics and jobs, cache efficiency, and a strip showing how much of the usage is fully labeled and priced.

## What doesn't change?

The current usage pages keep working while the new one is built. Spending limits and real-money tracking are untouched. Seeing several agents together is a separate project, "Instar Fleet Support", which will use the summary this one produces.

## How do we know it works?

Tests make sure each engine and each kind of conversation produces exactly one row, nothing is counted twice, prices follow their dates, and the totals match the raw rows. On a live agent, a separate re-count of a day's conversation files has to match the dashboard's total, and any difference is listed row by row.

## Choices made for now (Justin can change them)

1. Models with no published price stay marked "no price" rather than being estimated. An estimate can be added later, clearly labeled.
2. Per-call detail is kept for 90 days (less if a machine passes about 2 GB of it). Hourly totals and per-conversation totals are kept for about 13 months. Daily totals are kept forever, so no day's total is ever lost; only the finer detail ages out.
3. Only the owner's phone can see usage, and it never shows account or session ids.
4. The old usage pages and the runaway-usage alerts are left exactly as they are. The bug where the old page reads the wrong folder gets its own small fix, so alerts don't suddenly change.
