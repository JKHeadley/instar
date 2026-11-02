## What Changed

- The built-in `evolution-overdue-check` job no longer posts to the user's Attention topic. It raised its item as `source: "agent"`, which the Attention hub filter always lets through, and its reworded body reposted every few hours. It now names itself as the source, so the item stays on the dashboard (`GET /attention`) and is held from the topic. The job is report-only, matching its description: no cancelling and no "escalate to the user". Its item body has a fixed shape.
- `bench-refresh` names itself too. Its routing-diff item is an operator decision, so the hub filter lists `bench-refresh:routing-diff` as one that needs the user, and it still reaches the topic.
- When an existing attention row is raised again, it takes the source of the latest raise. An old row raised as "agent" no longer keeps passing the filter after its producer changed.
- CLAUDE.md (new and existing agents): a scheduled job never claims `source: "agent"`. It names itself.

## What to Tell Your User

The repeating "Evolution actions are overdue" messages in your Attention topic stop. That count is still on the dashboard if you want it. Your Attention topic is for things you need to act on, and that item never was.

## Evidence

- A unit test scans every shipped job and fails if any posts an attention item as "agent". It also checks that the overdue item is held and the bench routing diff gets through.
- Adapter test: an existing "agent" row raised again under the job's name is not posted, while its dashboard text still refreshes. The same row raised again as "agent" still posts. This test fails without the adapter change.
- Migration test: the CLAUDE.md bullet is added once, after the hub-filter bullet. New agents already have it.

## Summary of New Capabilities

None. This is a bug fix.
