<!-- bump: patch -->
<!-- internal-only -->

## What Changed

`SessionManager.isMarkerStuckAtPrompt()` now recognizes Gemini CLI's input box. It checked the pane line for `❯` (Claude) or `›` (codex) to find the prompt; Gemini has neither — its active input is a `│ * <text>` box line — so a Telegram message injected into a Gemini session was never detected as stuck, and `verifyInjection`'s Enter-recovery never fired for Gemini. Forwarded prompts stalled unsubmitted in the box (the recurring mentee-layer auto-submit friction; it stalled a message to Codey live this session until manually nudged). The fix adds `│ *` to the prompt-indicator set. The downstream gate is unchanged — a line only counts as stuck if it also contains the exact injected marker, so `│ *` alone (or Gemini's empty-box placeholder) never false-fires, and Claude/codex detection is untouched. Sibling of the earlier codex `›` fix; all three CLIs now get the same stuck-input auto-recovery.

## Evidence

- `vitest run tests/unit/codex-stranded-draft-recovery.test.ts tests/unit/session-multishot-recovery.test.ts` → **27/27 green** (Gemini box-detect + empty-box placeholder immunity + Claude/codex no-regression + no false-fire on a markerless `│ *` line).
- `tsc --noEmit` clean.
- Fixture mirrors a real Gemini idle pane captured live (`│ * [telegram:1] [Long message saved to …]`).
