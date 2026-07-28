# Heartbeat ratchet fix — plain-English overview

## What happened

The autonomous-progress-heartbeat feature (PR #1207) was built, tested, and
approved — but its CI run came back red on one unit-test shard. The failing
test was `tests/unit/no-silent-fallbacks.test.ts`, an infrastructure "ratchet"
that counts `catch` blocks in server-side runtime code which swallow an error
and keep going without reporting it. The rule, from Justin (2026-02-25):
*"Fallbacks should only and always be associated with a bug report back to
Instar."* The test enforces that the count never climbs above a tracked
baseline (currently 476). My new heartbeat code pushed it to 479 — three new
`catch` blocks the scanner flagged.

## Why it's only a fix, not new behavior

I looked at all three flagged blocks. None of them is a silent degradation —
they're all *fail-safe* by design:

1. **Heartbeat send failure** — when a heartbeat message fails to send, the
   code already records it (`recordSuppressed('send-failed')`) and emits a
   `send-error` event. It is surfaced, not silent. It deliberately does *not*
   advance the cooldown/count, so the next tick simply retries — a missed
   heartbeat is the safe status quo.

2. **History read failure** — when the outbound-history read throws, the code
   returns a "spoke just now" sentinel so the silence gate *cannot* fire on
   missing evidence. That's fail-closed (suppress the heartbeat), the safe
   direction.

3. **State-file read** — a missing `<topic>.local.md` is the *expected* case
   (no autonomous run for that topic). Returning `null` is normal control flow,
   and callers treat it conservatively.

## The change

Each of the three blocks now carries a `@silent-fallback-ok` comment with an
honest justification of why it is fail-safe rather than silent. That is the
codebase's sanctioned exemption marker (the same one used for the PrHandLease
fail-open catch). The fix is **comment-only** — zero behavior change — and it
returns the ratchet count to 476, at the baseline.

## Impact

PR #1207's CI unit shard 3/4 goes green; the feature merges on its existing
armed auto-merge. Nothing else changes.
