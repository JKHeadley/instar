# Verified names stay attached to their IDs

<!-- bump: patch -->

## What Changed

Telegram topic and Slack channel titles are checked against their platform IDs before they become display names. Telegram title lookups can read the reachable machine pool, with the Telegram-serving machine taking precedence after a rename. Session lists, status, WebSocket updates, and peer health show a verified name or an explicit unavailable state while retaining IDs for routing. Existing agents receive the new guidance through an idempotent update migration.

## What to Tell Your User

Instar's session, topic, channel, and peer-health views now use a verified name when one is available. If a name cannot be verified yet, those views say it is unavailable instead of showing an ID or a generated numbered placeholder. Conversation routing continues to work while the name is being resolved.

## Summary of New Capabilities

The console can call `GET /telegram/topics?scope=pool` to find verified topic names across reachable machines and see which names or machines are unresolved.

## Evidence

The shared name rule, Telegram and Slack adapters, pooled HTTP route, secret receipt spawn, local and remote session display, and WebSocket display have unit, integration, and lifecycle coverage. The independent side-effects reviewer concurred after testing the internal-key and visible-name boundary. The full suite and live fleet check are release gates, not claimed by this fragment.
