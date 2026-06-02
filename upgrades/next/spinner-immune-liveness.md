# Upgrade Guide — spinner-immune liveness signal

<!-- patch = monitoring reliability fix, no breaking changes -->

## What Changed

`OutputActivityTracker` (the per-session change-detector that feeds
`ActiveWorkSilenceSentinel`) now hashes a **spinner-immune** view of the captured
pane. The host's "working" spinner (e.g. Claude's `✻ Sautéed for 26m 16s ·
(esc to interrupt)`) ticks its elapsed-time counter every second, so the previous
raw hash changed on every poll even when the turn had produced no real output for
many minutes. That kept the session's `lastChangeAt` perpetually fresh and blinded
the silence sentinel to a stalled-but-spinning turn — the cause of a ~26-minute
unrecovered API-stall where a wedged session looked fully alive. A new
`stripVolatileStatus` removes the volatile status region (the rotating glyph, the
elapsed-time and token/context counters, and the `esc to interrupt` footer) before
hashing, so only REAL scrollback changes refresh the activity timestamp. A
stalled-but-spinning turn now correctly accrues idle time and becomes eligible for
the sentinel's gentle nudge.

This is safe: the silence sentinel's nudge is a non-destructive `Enter` keystroke,
so a false-positive on a genuinely long turn is harmless. The only destructive
recovery (Ctrl-C) lives in `SocketDisconnectSentinel`, which fires only on a
positive connection-error marker — unchanged.

## What to Tell Your User

- **Better stuck-session detection**: "If one of my sessions ever freezes mid-task
  while still showing a 'working' spinner, I can now actually notice it and try to
  wake it, instead of being fooled into thinking it's busy because the spinner's
  clock keeps ticking. It's a gentle nudge only — it never interrupts real work."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Spinner-immune stall detection | Automatic (ActiveWorkSilenceSentinel) |

## Evidence

- **Live before:** 2026-06-02, a session hung ~26 min on an Anthropic API socket
  drop while showing `Sautéed for 26m 16s`; `ActiveWorkSilenceSentinel` never fired
  (it flagged a *different* session idle at a static prompt in the same window), and
  the turn only re-engaged when an inbound user message arrived. Confirmed in
  `logs/server.log` + `logs/sentinel-events.jsonl`.
- **After (code path):** `tests/unit/spinner-immune-liveness.test.ts` drives
  `OutputActivityTracker` with ticking-spinner-only frames and asserts `lastOutputAt`
  HOLDS across them (idle accrues) while genuine new output still advances it; plus
  `stripVolatileStatus` unit cases for Claude/codex spinner shapes and a guard that
  benign content (e.g. "completed in 5s") is not over-stripped.
- **Cross-model reviewed** by the codex-based agent (task #63): confirmed the silence
  nudge is `Enter`-only (non-destructive), which is why the spinner-immune hash alone
  is sufficient and safe.
