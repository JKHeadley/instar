# Side-Effects Review - context exhaustion compaction banner exclusion

**Version / slug:** `context-exhaustion-compaction-banner`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary

The live-session context-exhaustion detector now ignores normal compaction lifecycle banners unless the same output also contains explicit context-exhaustion failure text.

## Signal Versus Authority

This is a detector-layer fix. It changes one signal from "context exhausted" to "not context exhausted" for normal compaction/resume banners. It does not add a new notification path, recovery authority, session action, or user-facing emitter. PresenceProxy and future emission-gate work remain the authorities that decide what to do with detector outputs.

## Runtime Side Effects

- Normal compaction/resume banners no longer trigger context-exhaustion recovery as a false alarm.
- Real context-exhaustion errors still match when they contain explicit failure text such as conversation-too-long or the esc-twice instruction.
- The exclusion runs before broad context-limit matching, so lifecycle text with words like context and compaction does not trip the detector by accident.

## Non-Effects

- No change to quota exhaustion detection.
- No change to session death classification.
- No change to compaction recovery, PromptGate, rate-limit recovery, or Telegram delivery.
- No config, persistence, route, schema, or migration changes.

## Risk Review

Primary over-block risk: a real context-exhaustion error could be hidden if it appears next to a normal compaction banner. The implementation prevents that by checking explicit failure patterns before suppressing the match. The regression test covers a banner plus real failure text and expects high-confidence detection.

Primary under-block risk: a new normal compaction banner phrase not listed here may still false-positive. This patch covers the currently known lifecycle phrases without widening scope into a general notification gate.

## Rollback

Remove the normal-compaction lifecycle pattern list and the early return in `detectContextExhaustion`, then remove the regression tests. No state repair is needed.
