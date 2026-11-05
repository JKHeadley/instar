# Codex 429 dead-pane reporting

## What Changed

A Codex CLI session that exits with a confirmed `429 Too Many Requests` is recorded as failed, rather than successful. Dead fixer panes are removed from tmux, running capacity is released, and a high-priority Attention alert reports the stopped work. A bound Telegram topic also receives the notice. Job history names the Codex 429 as the failure reason. A missing tmux exit status is kept unknown until the terminal result arrives, preventing the monitor from mistaking the timing gap for success.

## What to Tell Your User

If a Codex session stops because of a rate limit, Instar now reports that the work stopped and that it is no longer running. Retry on another signed-in Codex account or after the limit resets.

## Summary of New Capabilities

Confirmed Codex 429 exits are identified from the retained dead pane and surfaced through session, job, and alert status.

## Evidence

A real-tmux regression test reproduces a retained Codex 429 pane after the startup window and verifies failed state, released running capacity, the alert event, and pane cleanup. The self-action convergence ratchet and TypeScript compilation pass.
