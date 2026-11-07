# A lasting GitHub outage stops feedback fixes out loud

## What Changed
When the feedback executor could not reach GitHub, its status said github-unavailable, but nothing told anyone, and fixes stopped for more than a day without a notice. After two hours in that state it now raises one high-priority attention item per outage, and the outage record clears as soon as access returns. Behaviour during an outage is otherwise unchanged.

## What to Tell Your User
If feedback fixes stop because GitHub can't be reached for more than two hours, you'll get one notice instead of nothing. It clears up by itself when access returns.

## Summary of New Capabilities
- One attention item when feedback fixes have been stopped by a GitHub outage for two hours.

## Evidence
Unit: tests/unit/feedback-factory/execute-service.test.ts covers quiet just under two hours, one notice after it, no repeat, and a later outage getting its own wait and notice. Echo's executor on 2026-11-06 was still reporting github-unavailable with no matching attention item.
