---
name: project-input-lockup-secondary-bug
description: Second stuck-input failure mode — TUI completely refuses Enter, separate from the paste-race bug PR #160 fixed
metadata:
  type: project
  status: open
---

# Input-Lockup Secondary Bug (open, not yet investigated)

## What

After PR #160 (StuckInputSentinel, shipped 2026-05-11) verified live on echo, two of the three originally-stuck sessions did NOT recover even after the sentinel ran the full Enter → Enter → C-m → Enter+sleep+Enter escalation. Evidence: `.instar/stuck-input-events.jsonl` shows 22 fires on `echo-qalatra` and 14 fires on `echo-progress-update-bug`, both reaching exhaustion (max attempts) with the prompt text unchanged.

The third originally-stuck session (`echo-exploring-slack-integration`) did clear — that's the case PR #160 was built for (server-restart-killed-the-recovery-timer).

**Why:** The sentinel and verifyInjection both assume Enter eventually submits. Live testing on echo-qalatra showed manual `tmux send-keys` with Enter, C-m, paste-end-escape, and multiple variants ALL fail to advance the input. The Claude Code TUI process is alive (Ss+ state, MCP children running), but its input system isn't consuming keystrokes the way it normally would. Typing a regular character REPLACES the displayed text rather than appending — strongly suggests the visible text is a stale render of a "queued paste" state that the input buffer never committed.

**How to apply:** A real fix needs to identify what STATE the TUI is in that blocks submission, then send the right escape sequence to break out of it. Hypotheses to test:
1. Stuck inside a bracketed-paste sequence — sending `\e[201~` (paste-end) didn't help in my test, but maybe needs to come BEFORE Enter on the SAME send-keys call.
2. Modal overlay (confirmation, [Y/n], picker) consuming keys — would need to send Escape first, then the recovery action.
3. Claude Code internal state machine wedged — may need to detach the pane and re-attach, or force a redraw via `tmux refresh-client`.
4. Pane focus issue — `tmux select-pane` before send-keys.

## References

- PR #160 = the fix that DID land — restart-resilient sentinel layer.
- Topic 7195, 2026-05-12 04:05 UTC — Justin's confirmation that the visible bug pattern matches what he's been seeing.
- Live events: `.instar/stuck-input-events.jsonl` (rotates with server lifetime).
- Linked: [[capability-native-module-self-heal]] (today's other infra layer).
