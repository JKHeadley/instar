## What Changed

- When held replies to one topic expire, they now add to a single alert for that topic (with a count) instead of creating one alert per message.

## What to Tell Your User

If replies to a conversation ever fail to go out, you'll see one alert for that conversation with a count, not dozens of copies, and the dashboard loads faster.

## Evidence

- On a live agent about 750 open "held reply expired" alerts (109 for one topic) made each pooled alert read 742 KB and the first read after a restart take 25 seconds. Unit test covers the shared per-topic condition and distinct per-message ids.

## Summary of New Capabilities

None.
