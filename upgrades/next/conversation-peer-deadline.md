# Keep pooled conversation reads responsive

## What Changed

Pooled conversation lists, topic lists, and history now give each peer two seconds. The server returns the available rows and identifies peers that missed the deadline. Telegram history shares a single peer budget across signed transport and any allowed legacy fallback.

## What to Tell Your User

A slow computer can delay these reads by up to two seconds. The reply still includes the rows available and reports the computer that missed the deadline.

## Summary of New Capabilities

The existing partial response names slow peers. The same read permissions and fallback rules apply.

## Evidence

Two unit tests, 28 HTTP tests, and two disposable server lifecycle tests passed. The HTTP tests exercise available rows alongside stalled peers.
