# Side-effects review — Mentor Stage-A: bound the compose prompt

**Spec:** `docs/specs/MENTOR-STAGE-A-PROMPT-BOUND-SPEC.md`
**Change:** `src/monitoring/MentorStageA.ts` (`buildStageAContext`) + unit test
**Class:** mentor reliability fix (root cause of `stage-a-failed`).

## What changed

`buildStageAContext` now caps `surface.threadlineHistory` at `MAX_HISTORY_CHARS =
6000`, keeping the most-recent tail + an explicit `older conversation elided`
marker, so the assembled Stage-A prompt can't exceed tmux's `new-session`
command-line limit (~12-16KB) — the confirmed cause of the spawn failure.

## Blast radius

- **`buildStageAContext` callers:** only `runMentorTick` (Stage-A). The function
  signature/output shape is unchanged (still returns the prompt string); only the
  history portion is bounded when it exceeds 6000 chars.
- **Mentor behaviour:** unchanged for short histories (the bound only engages
  above 6000 chars). For long histories, the prompt now contains the recent
  exchanges + a marker instead of the full transcript — the mentor still has the
  agenda + recent state to decide the next action.
- **Two-hats isolation / leak detection / agenda logic:** untouched.
- **Public API / DB schema / config / other spawns:** none changed. Regular
  (non-mentor) session spawns are unaffected (their prompts are small and were
  never the growth vector).

## What could break (and why it doesn't)

- **Mentor lacks older context?** By design — the recent 6KB + agenda + status
  carry the "what's next" decision; older middle history is least relevant.
- **A single huge recent message?** The hard char cap bounds the history block
  regardless of message boundaries.
- **Leak detector seeing a truncated transcript?** It runs on the Stage-A
  *output* transcript, not on this input prompt — unaffected.

## Security

No new external input / network / auth / fs surface. Pure in-memory string bound.

## Migration parity

Server-internal monitoring code — every agent gets it by running the new build.
No PostUpdateMigrator entry required.

## Rollback

Revert the commit. No persisted state, schema, or API contract affected.

## Tests

`tests/unit/MentorStageA.test.ts` (+1): an ~80KB history → prompt < 12KB, keeps
the most-recent exchange, carries the elision marker, preserves structure. Full
mentor/stage suite (114 tests / 9 files) green; `tsc` + `npm run lint` clean.
Cold tmux repro confirmed the limit (120KB → "command too long"; 12KB passes).
