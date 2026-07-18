## What Changed

Pool-wide sessions, jobs, attention, and subscription views now discover peers through the same validated LAN/Tailscale/Cloudflare endpoint resolver used by routing and lease traffic. A reachable enrolled machine is no longer silently omitted merely because it lacks the legacy `lastKnownUrl` field.

## What to Tell Your User

Pool-wide dashboard and API views now include reachable enrolled machines across their available mesh connections, even when those machines do not have a legacy URL recorded.

## Summary of New Capabilities

- Pool-scope sessions, jobs, attention, and subscription reads share the validated multi-rope peer resolver.
- Existing per-peer authentication, timeouts, cache behavior, and honest failure markers remain unchanged.
