# Side-Effects Review — isMarkerStuckAtPrompt recognizes Gemini's "│ *" input box

**Version / slug:** `gemini-stuck-input-prompt-detection`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier-1; one-line detector widening with marker gate; sibling of the merged codex `›` fix)`

## Summary of the change

`SessionManager.isMarkerStuckAtPrompt()` decided whether an injected Telegram message is still sitting unsubmitted at the input prompt by checking the line for `❯` (Claude) or `›` (codex). Gemini CLI has neither — its input is a `│ * <text>` box line — so a stuck Gemini message was never detected and `verifyInjection`'s Enter-recovery never fired for Gemini (the recurring mentee-layer auto-submit friction; it bit the loop live this session). The fix adds `│ *` (via `/│\s+\*/`) to the prompt-indicator set.

## Decision-point inventory

1. `const hasPromptChar = line.includes('❯') || line.includes('›') || /│\s+\*/.test(line);` — one regex added.
2. The downstream gate is UNCHANGED: a line only counts as stuck if it ALSO contains the injected marker (`line.includes(marker)` or the next line includes the 30-char short marker).

## 1. Over-fire / false-positive risk

Bounded by the marker gate. `│ *` alone never trips it — it must co-occur with the EXACT injected marker (first ~40 chars of the message we typed). A normal agent output line (even a bulleted `│ *` table/list row) cannot contain our injected marker, so it cannot false-fire (test: "does not false-fire on a │ * line that lacks the injected marker"). Gemini's empty-box placeholder ("Type your message…") is not the injected marker either, so an idle empty box is never seen as stuck (test: "placeholder immunity") — the same property the codex `›` fix relies on.

## 2. Regression risk (Claude / codex)

None. `❯` and `›` are still checked first; the `│ *` branch only adds coverage. Test: "still matches Claude ❯ and codex › (no regression)" — both pass.

## 3. Worst case if `│ *` is imperfect

If Gemini's box-bullet differs in some build, the detector simply fails to match (no recovery — i.e. today's behavior, no worse). The recovery action itself (`fireStuckInputRecovery`) is Enter/C-m and is already once-per-session-guarded, so even a spurious match costs at most one extra Enter on a line that genuinely holds our injected marker.

## 4. Reversibility

Fully reversible: revert the one-line `||` term + drop the Gemini test block. No state, config, or migration.

## 5. Blast radius

One expression in `src/core/SessionManager.ts:isMarkerStuckAtPrompt` + 4 unit tests (added to the existing codex-stranded-draft-recovery suite). No route/config/persistence change. Affects only stuck-input detection for Gemini sessions.

## Evidence pointers

- `vitest run tests/unit/codex-stranded-draft-recovery.test.ts tests/unit/session-multishot-recovery.test.ts` → 27/27 green.
- `tsc --noEmit` clean.
- Fixture mirrors a real Gemini idle pane captured live this session (`│ * [telegram:1] [Long message saved to …]`).
