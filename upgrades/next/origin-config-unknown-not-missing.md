## What Changed

- When a machine briefly cannot read its own messaging config (seen on a busy standby whose server stalled for tens of seconds), a message to a bug-group topic was refused with "this process has no messaging config issuesChatId", although the config holds it. The refusal now says what happened: the config could not be read. It is a retryable `503 origin-config-unavailable` with the reason (for example `origin-config-reader-timeout`).
- Messages refused this way, and the older "issues-chat-not-configured" and bare "origin-display-authority-unavailable" refusals already in the queue, were later marked "may already be delivered" and never sent. Both refusals happen before anything is sent, so recovery now replays them once config reads again, through the normal tone review, duplicate check and 6-hour deadline.
- The server log now records why a config refresh failed (`[telegram-origin] config snapshot unavailable: <reason>`) and when it recovered. Before, the reason was discarded.

## What to Tell Your User

If one of my machines is briefly too busy to read its own settings, messages I send from it to a bug topic now wait and arrive shortly after, instead of failing with a misleading "not configured" error and going missing.

## Evidence

- Mama PC (standby, 2026-11-02): sends to issue topic 10000000001 were refused at about 17:59, 20:03, 20:20 and 20:37 UTC, and the queued copies became `delivered-ambiguous` without being sent. Twenty fresh config reads there all succeeded in about 150 ms with `issuesChatId` present. The same log shows the server's event loop blocked (25 s drift bursts, "event-loop BLOCK 95% CPU") and the lifeline restarting it for being unresponsive, which is when a 2 s config read times out.
- Integration test: after boot, the config becomes unreadable; an issues-topic send is refused with `OriginConfigUnavailableError` (reason `origin-config-unparseable`), never "issues-chat-not-configured", and routes to the issues group again once the config reads.
- Unit test: both refusal bodies replay exactly once; a generic 500 and a relayed body stay uncertain.

## Summary of New Capabilities

None. This fixes a misleading refusal and the lost messages behind it.
