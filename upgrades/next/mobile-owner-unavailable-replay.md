# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A native chat send saved while its serving machine is unavailable can resume when that machine returns and the client repeats the same request. The server reuses the saved message and attachments. A retry received during delivery gets the existing in-progress response.

## What to Tell Your User

Compatible clients can resume the original saved send after the conversation's machine reconnects. Clients that issue a new request when you tap Send again still use their existing behavior.

## Summary of New Capabilities

No new setting is needed. The existing native chat send endpoint handles this retry case.

## Evidence

Focused integration and request-store tests cover the saved 503, a changed payload, concurrent retries, and restart after routing was claimed.
