# Reaper live-activity idle detection — ELI16

> The one-line version: the reaper decided "is this session working?" by scanning the whole visible terminal for tool names (Read(/Bash(/…) and the word "claude" — but those stay on screen in an IDLE session's history long after the work finished. So every idle session looked "busy" forever and the reaper never reaped one. Now it only looks for markers that mean working RIGHT NOW (the spinner animation, "Working (Ns", "esc to interrupt"), which disappear the moment a turn ends.

## The problem (found 2026-06-07, "make the reaper work correctly and robustly")

After the transcript-resolution fix (#961), the reaper could finally read transcripts — but it STILL reaped nothing (0 in 9.5h live). Grounding it on a genuinely-idle Claude session showed why: the reaper's "is it active?" check matched the bare word **"claude"** AND tool-call names like **Read(/Write(/Bash(** anywhere in the captured 200-line buffer. An idle Claude session's screen is full of both (its past work history, plus the word "claude" everywhere). So `isPositivelyIdle` always saw "activity" → never positively idle → kept every session forever.

This is the SAME bug the code already fixed once for Codex — there's a literal comment: "do NOT match the bare word 'codex' — it made every idle session read as working." The Claude side had the identical flaw; it was never caught because the earlier reaper layers (open-commitment, active-process, transcript) short-circuited before this check ever ran. The #955/#958/#961 chain peeled those away and exposed it.

## What this changes

Splits "activity signals" into two kinds and uses the right one for idle-detection:
- **Live-only markers** (new `liveActivity`): the animated braille spinner, "Working (Ns", "generating" — these appear ONLY while a turn is generating and vanish when it ends.
- **Scrollback-persistent markers** (the existing `toolCallOrSpinner`): tool-call names + the framework word — these linger in idle history.

`isPositivelyIdle` now uses `liveActivity` (+ "esc to interrupt" + "(running)"), not `toolCallOrSpinner`. Also removed the bare word "claude" from the Claude `toolCallOrSpinner` entirely (the documented codex lesson, so other detectors stop mis-reading idle Claude sessions too).

## Why it's safe

- It only makes the reaper able to correctly RECOGNIZE an idle session; it does not weaken any other gate. A session still must be 8h-silent + transcript-flat + confirmed across 3 ticks before it's reaped.
- The transcript-growth check is a backstop: if a session is genuinely working but its frame momentarily lacks a spinner (e.g. between tool calls), its transcript is growing → kept by transcript-grew. So a momentary live-marker miss can't cause a wrong kill.
- Reaper stays opt-in + dry-run-first; this is validated by watching the dry-run correctly flag idle sessions before any real kill.
- Removing bare "claude" is strictly more correct (it never should have matched an omnipresent word); 57 unit tests pass including the framework-signal suite.

## Honest scope

This is the final functional fix in the chain (#952 → #955 → #958 → #961 → this): with it, the reaper can finally tell an idle session from a working one and actually reclaim. Separately, the transcript pile-up (151k files / 5.9 GB) still needs its own retention fix.

## Evidence

`tests/unit/session-reaper.test.ts`: an idle Claude pane (scrollback tool-names + "claude", no live marker) → positively idle; a working pane (spinner, or spinner+esc) → not idle; bare "claude" alone no longer forces not-idle. 57/57 green. `tsc --noEmit` clean.
