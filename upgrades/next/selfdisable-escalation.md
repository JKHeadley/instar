# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Skipping the host-wide test-runner bound via `INSTAR_HOST_TEST_SEMAPHORE=off` printed a deterministic
warning — identical on every run. The shared detector that counts sustained self-disables was consumed
only by `dev:preflight`, hours downstream.

Measured on 2026-07-27: an agent self-disabled the bound 37 times in about three hours and read the
same warning 37 times as routine output. The detector's threshold is 3.

The skip warning now also reports the current count, that this is no longer an exception, and that
`dev:preflight` fails on the signature. It reuses the shared detector, so the number in the warning
and the number that fails preflight cannot drift.

## Evidence

Live, against the real ledger:

```
WARN: SKIPPING the host-wide test-runner bound (reason: off) — posture: off. …
WARN: this is self-disable #39 on this host within the detector's window (threshold 3).
WARN: that is no longer an exception — it is the pattern the detector exists to find.
WARN: `instar dev:preflight` FAILS on this signature …
```

Falsified by reverting the mapping to the originally-guessed field name:

```
× THE FIX: fires on the detector's real output shape → expected null not to be null
× fires exactly AT the threshold
  Tests  2 failed | 3 passed (5)
```

Restored byte-identical. Green: `Test Files 3 passed (3) · Tests 121 passed (121)`; `tsc --noEmit`
exit 0.

## Known limits

Louder text only — it cannot refuse a run, and making the kill switch refuse was considered and
rejected (a kill switch that stops working after three uses is not a kill switch). It fires only for
`reason: 'off'`; the spoofed-CI skip is not escalated, since that path has a different population and
no measurement behind it.

## Built-in caution

Two implementations of this produced no output and no error — one un-awaited promise, one guessed data
shape swallowed by the best-effort catch. Both were found by running it and reading the output. The
fallible mapping is now a pure exported function pinned against the detector's real shape, so a future
shape change fails a test rather than vanishing into the catch.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).
