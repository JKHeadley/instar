## What Changed
The unified usage ledger (spec: `docs/specs/unified-usage-ledger.md`): one record of an agent's own token use, per model request, across every machine.
- **One row per request.** Claude Code transcripts (the agent's own sessions wherever they run, including subagents), Codex rollouts (per-request deltas of the running total), and every one-off internal call through the intelligence funnel. When the same work is seen twice (a one-off call and its own transcript) it is counted once. Fresh input, cache read, cache write and output are separate numbers; "not reported" is kept apart from zero.
- **Attribution.** Each row carries machine, engine, model, conversation, job, run, check and login, matched by the request's own time.
- **Equivalent API cost, priced on read.** Two new list-price doors (`anthropic-list`, `openai-list`) with 16 published prices, each with its source link. Every figure is valued at the price in force on its day; tokens with no published price are shown as unpriced, never $0.
- **Read routes.** `GET /usage/summary`, `/usage/tree`, `/usage/series`, `/usage/top`, `/usage/coverage`, `/usage/events`. The lease holder pulls every machine's totals (`/usage/rollup`), names any machine that did not answer, and a standby forwards reads to it. `GET /mobile/usage` is the owner phone's trimmed view.
- **Console.** "What thinking costs" gains a Token usage section: headline, usage over time by model or engine, a breakdown from agent to session, top conversations, jobs and checks, cache hit rate, machine comparison and what is measured.
- **Backup.** An hourly slim snapshot (`server-data/usage-ledger.snapshot.db`) is in the default backup set, with restore rules that never overwrite a live database or import another machine's live data.
- **Dev-gated.** `usage.ledger.enabled` is on for development agents and off elsewhere; the routes answer 503 and the console section is hidden when off. `TokenLedger`, `/tokens/*`, `/routing-spend/*` and the runaway-usage alerts are unchanged.

## What to Tell Your User
Nothing changes for you yet unless you run a development agent. On those, the "What thinking costs" page now shows where my tokens go, broken down by machine, model, conversation and job, with what it would have cost at the providers' published prices. It is clearly marked as an equivalent price, not your bill.

## Summary of New Capabilities
- Per-request token usage for the agent's own Claude Code, Codex and internal calls, counted once, attributed to machine, engine, model, conversation, job and check.
- List-price-equivalent cost per day, from published prices with sources.
- Agent-wide and per-machine usage reads, a drill-down tree, usage over time, top lists, and a coverage report; a trimmed owner-phone view.
- A Token usage section on the console's "What thinking costs" page.

## Evidence
- `tests/unit/UsageLedger.test.ts` (17), `UsageLedger.slice2.test.ts` (13), `UsageLedger.slice4.test.ts` (29), `usagePricing.test.ts` (9), `console-usage.test.ts` (12), `PostUpdateMigrator-usageLedger.test.ts` (4).
- `tests/e2e/unified-usage-ledger-alive.test.ts`: a production-booted development agent answers every usage route and a real funnel call reaches the priced totals; a fleet agent answers 503.
