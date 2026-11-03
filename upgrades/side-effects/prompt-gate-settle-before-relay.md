# Side-Effects Review — Prompt Gate waits before relaying

**Version / slug:** `prompt-gate-settle-before-relay`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Operator report 2026-11-02 13:50 (topic 134088, with a photo): "I feel like [you] shouldn't be notifying for prompts that are handled automatically." At 13:42 two prompts from the operator's own session (a confirmation and Claude Code's weekly-usage-limit menu) were relayed, plus the standalone "Prompt Gate is now active" disclosure; both prompts were resolved without him (the session moved to another account).

1. `src/monitoring/promptRelaySettle.ts` (new): `settleBeforeRelay(prompt, deps)` waits `settleMs`, then: session not alive → no relay; prompt anchors (option labels, else the raw text's last lines) found in the last 20 pane lines → relay; not found → no relay; pane unreadable or no anchor → relay.
2. `src/commands/server.ts`: the relay branch calls it before Telegram/Slack relay, with `sessionManager.isSessionAlive` and `sessionManager.captureOutput`. A skipped relay is logged and resets the detector for that session.
3. `src/core/types.ts`: `promptGate.relaySettleMs` (default 45000; 0 = immediate).
4. `src/messaging/TelegramAdapter.ts`: the first-use disclosure is appended to the first relayed prompt as one line instead of a separate message.

## Decision-point inventory

- `settleBeforeRelay` — add — invariant: whether to send a notification about a prompt. Deterministic by design: it only suppresses a message when the live pane positively no longer shows the prompt or the session is gone; every uncertain case relays.

## 1. Over-block

A prompt answered by the operator at the terminal within 45 s is not relayed (correct). A prompt whose menu text is redrawn differently (labels reworded) would read as cleared and not relay; anchors are the detector's own parsed labels from the same pane, so a redraw of the same menu keeps them. A prompt pushed out of the last 20 lines by later output while still waiting is possible but unlikely for a blocking prompt (the session is stopped on it).

## 2. Under-block

A prompt that stays on screen but is being handled by another mechanism slower than 45 s is still relayed. The window is configurable.

## 3. Level-of-abstraction fit

The relay decision lives in the one server relay branch that both Telegram and Slack share, so both channels get it. The detector and classifier are unchanged.

## 4. Signal vs authority compliance

It never answers or blocks a prompt; it only decides whether to send a message, and fails toward sending. Reference: docs/signal-vs-authority.md.

## 5. Interactions

Auto-dismiss and auto-approve paths run before it and are unchanged. Relayed prompts arrive ~45 s later, so a reply relayed back targets a prompt that was confirmed still present moments before. Detector dedup/cooldown is reset on a skipped relay, as it is after a handled one.

## 6. External surfaces

Fewer Telegram/Slack messages; a ~45 s delay on genuine prompts; one less standalone message per topic.

## 7. Multi-machine posture

Machine-local by design (`hardware-bound-resource`: the prompt is on this machine's tmux pane, and only this machine can read it).

## 8. Rollback cost

Set `promptGate.relaySettleMs: 0`, or revert. No state.

## Second-pass review

Independent reviewer — Concur with the review. Argument types match (prompt.sessionName is the tmux name, as the auto-dismiss sendKey already uses); a prompt is dropped only when the session is gone or no anchor is in the pane tail, every uncertain case relays; a skipped relay resets the detector like the auto-approve path; the 45 s wait is per prompt and does not hold the event loop; the appended note is fixed text. Minor: the topic is marked disclosed before the send succeeds, unchanged from before.
