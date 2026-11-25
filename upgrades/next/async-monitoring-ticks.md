# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Session monitoring now reads terminal output and scans processes asynchronously. Each affected monitor runs one pass at a time and skips overlapping timer ticks. Child calls have a timeout. An unreadable capture stays unknown, and the orphan reaper checks current tracking and process identity before signalling.

## What to Tell Your User

A slow process or terminal read can no longer block the server's health endpoint from these monitoring paths. The repair ships enabled on every installation.

## Summary of New Capabilities

There is no new setting. The existing monitoring paths now run their process and terminal reads off the server's event loop.
