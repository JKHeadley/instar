# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`IMessageAdapter.getConnectionInfo().connectedAt` was computed inline as
`started ? new Date().toISOString() : undefined`, so it reported the moment of the READ rather than
the moment of connection. Three reads produced three different "connection times", all wrong.

The instant is now captured once, immediately after `started` flips true in `start()`, and cleared in
`stop()`. An adapter that never connected reports no time.

## Evidence

Falsified by restoring the inline expression:

```
× THE FIX: getConnectionInfo no longer manufactures a timestamp on read
  → expected 'getConnectionInfo(): ConnectionInfo {…' not to match /new Date\(\)/
  Tests  1 failed | 3 passed (4)
```

Restored byte-identical. Green across every iMessage suite:
`Test Files 4 passed (4) · Tests 64 passed (64)`; `tsc --noEmit` exit 0. No production consumer reads
the field — verified by grep; the only references are comments explaining why the channel-registry row
deliberately does not use it.

## Known limits

`lastError` and `reconnectAttempts` in the same object are still hardcoded `undefined` / `0`. They are
the same class of defect and are deliberately not fixed here — inventing values for them would repeat
the error this corrects. The field also says nothing about connection quality.

## What to Tell Your User

If your agent uses iMessage, the "connected since" time it reported was never real — it was recomputed
as the current time every time anything asked, so it always said "just now".

That is a small thing that could have caused a confident wrong answer, because a precise-looking
timestamp invites questions like how long has this been up or did it drop recently. Those would all
have been answered with a number that meant nothing.

It now records the moment it actually connects, and reports nothing at all when it is not connected —
which is the honest answer rather than a placeholder.

## Summary of New Capabilities

No new endpoint, command, or config key. The iMessage connection-info object now reports a real
connect instant instead of the current time.
