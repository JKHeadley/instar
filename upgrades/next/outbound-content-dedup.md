---
bump: patch
---

## What Changed

Outbound content-dedup — the relay now drops an exact re-send of the same
message to the same topic within ~15 minutes, killing the "same status posted
2–3 times" problem.

Grounded in the report: the same status went out byte-identical 13.5 min apart
(logs: fingerprint ea240185 at 21:14 and 21:28). The existing delivery-id dedup
only catches a re-POST of the SAME id (these had different ids), and the tone
gate's dup awareness is skipped for proxy/relay sends. New
`OutboundContentDedup` is a deterministic per-topic content fingerprint wired at
`/telegram/reply` before the tone gate: an identical long message within the
window is suppressed (200, never re-sent); the first send still goes through.

Narrow by design: brief acks (below a length floor) are never suppressed; the
existing `allowDuplicate` metadata bypasses it; record-after-success means a
failed send's retry isn't lost; per-topic so the same text elsewhere still
sends.

## What to Tell Your User

If I accidentally try to send you the same message twice in a row, you'll now
only get it once. Short "got it" acks still come through every time — only
substantial repeats within ~15 minutes are dropped.

## Summary of New Capabilities

- `OutboundContentDedup` — pure, deterministic per-topic duplicate detector
  (windowed, length-gated, ring-bounded) at the `/telegram/reply` chokepoint.
- Honors `metadata.allowDuplicate` to force a repeat; records only after a
  successful send.
- CLAUDE.md "Duplicate-message suppression" note (behavior + the bypass).

## Evidence

Grounded in the 2026-06-06 logs (byte-identical re-send 13.5 min apart). 11
class unit tests + 6 route-level tests through the real `/telegram/reply`
handler (both sides: suppress identical, pass different/short/cross-topic,
allowDuplicate bypass) + migrator add/idempotent. tsc clean; preflight PASS.
