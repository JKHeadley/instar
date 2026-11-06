# Session lists keep conversation names

## What Changed
Dashboard and app session lists now resolve titles from durable conversation records, retain meaningful saved/peer names when adapter caches are absent, and correctly distinguish app and Slack aliases from Telegram topics. Job runs use their job definition name. Pool reads can recover known Telegram titles without confusing machine-local aliases.

## What to Tell Your User
Your dashboard and app keep showing the conversation name when its session is replaced or an adapter's title cache is missing.

## Summary of New Capabilities
None — repairs existing session naming.

## Evidence
Regression tests cover stale bindings, persisted titles, renames, app and Slack aliases, job definitions, peer aggregation, and real AgentServer HTTP/WebSocket wiring. No sessions or test agents were launched on the laptop.
