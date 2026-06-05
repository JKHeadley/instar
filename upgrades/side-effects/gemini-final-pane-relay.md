# Side-Effects Review — Gemini final pane Telegram relay

**Version / slug:** `gemini-final-pane-relay`
**Date:** `2026-06-05`
**Author:** `instar-codey`

## Summary

When a `gemini-cli` topic session has a pending Telegram injection, `SessionManager` now checks the captured pane for a completed Gemini assistant block and emits `injectionReplyDetected`. Server wiring sends that detected reply to the same Telegram topic.

## Decision-point inventory

- Gemini pane parser — added — pure helper in `paneText`, requiring a `✦` assistant block followed by Gemini's idle/input footer.
- Pending-injection monitor — modified — Gemini-only branch after liveness is confirmed and before generic completion/timeout checks.
- Telegram send wiring — added — listens for `injectionReplyDetected` and posts to the original topic.

## Direction of failure

- Old failure: Gemini completed work in-pane, but no Telegram reply was sent because Gemini did not execute the relay script.
- New behavior: a completed Gemini final block is relayed once and clears the pending injection tracker.
- Conservative failure direction: if the pane shape is ambiguous, lacks the matching `[telegram:N]` marker, or Gemini has not returned to the idle footer, no automatic relay happens.

## Side-effects checklist

1. **Over-block:** The implementation relays only; it does not reject inputs or user actions. The concrete false-negative tradeoff is conservative non-relay when Gemini's footer shape changes, when the matching Telegram marker has scrolled out of the 400-line capture, or when the final block uses a shape other than the `✦` assistant marker.
2. **Under-block:** It can still miss very long Gemini answers where the original `[telegram:N]` marker is outside the captured tail, panes with a future Gemini TUI footer vocabulary, or answers that are complete but remain in an intermediate TUI state without the idle footer.
3. **Level-of-abstraction fit:** The helper lives in `paneText` because it is pane-shape parsing, not Telegram delivery policy. `SessionManager` owns the pending-injection tracker and can decide when a framework-specific pane observation is eligible for relay. `server` remains the Telegram transport boundary.
4. **Signal vs authority compliance:** The parser is a detector and does not hold blocking authority. It only produces a completed-reply signal after a pending Gemini Telegram injection exists; the server listener surfaces that signal to the original topic. This complies with `docs/signal-vs-authority.md` because the brittle regex/TUI detection never blocks a judgment path.
5. **Interactions:** The branch is scoped to `framework === 'gemini-cli'` and a live pending injection, so Claude and Codex transcript/reply-script behavior is unchanged. The pending injection is cleared before emitting the event to avoid duplicate sends on subsequent monitor ticks.
6. **External surfaces:** Telegram users can now receive a Gemini final pane answer that previously stayed visible only in tmux. The behavior depends on runtime pane text, the pending-injection map, and Gemini's idle footer, so the implementation is intentionally narrow and fail-closed.
7. **Rollback cost:** Reverting the parser, the Gemini monitor branch, and the server listener restores the prior behavior without data migration or state repair.

## Scope not taken

- No Claude/Codex behavior changes.
- No broad "scrape any final-looking text" behavior.
- No stale Gemini quota telemetry work; that remains parked per operator instruction.
- No task-boundary blending fix; recorded as observation only.

## Rollback

Revert the parser, the Gemini pending-injection branch, and the `injectionReplyDetected` server listener. Gemini returns to the previous behavior: visible pane output may remain silent unless the agent runs the reply script.
