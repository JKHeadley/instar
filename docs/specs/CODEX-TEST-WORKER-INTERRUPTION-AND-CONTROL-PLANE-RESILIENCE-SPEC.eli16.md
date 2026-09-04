# Codex Session Stability — Plain-English Overview

> The one-line version: Instar must stop mistaking Codex's normal test helpers for frozen work and must keep its local server responsive while it watches sessions.

## The problem in one breath

Codex sessions on this machine were repeatedly shown an interruption banner even though the operator did not interrupt them. Instar's watchdog was selecting a quiet, long-lived helper created by Vitest, sending an interrupt that affected the whole terminal, and later killing the helper; at the same time, synchronous process checks could make the server slow enough to look offline.

## What already exists

- **Session watchdog** — detects commands that may truly be stuck and escalates recovery over time.
- **Reap authority** — owns final session termination and applies the existing protections before a session can be killed.
- **Durable lifeline queue** — holds Telegram messages while the local server cannot accept them and replays them after recovery.

## What this adds

The watchdog now recognizes the exact service-mode command used by esbuild under Vitest and treats that helper as infrastructure, not stuck user work. If another descendant really does need intervention, the watchdog signals only that process after rechecking its identity instead of typing Control-C into Codex's terminal. Session-list and idle-input checks also use cached state on the server's asynchronous hot path so slow tmux probes cannot monopolize the HTTP event loop.

Queue messages now retain whether they were stored because the server was unavailable or because a healthy server rejected forwarding. Replay notices state that distinction honestly. Existing agents receive updated awareness text through the normal post-update migration.

## The safeguards

**Prevents false interruption.** The service exemption requires the esbuild executable plus both service and ping arguments; it does not broadly exempt ordinary esbuild commands. Unknown framework ownership remains protective, and every targeted signal rechecks PID, parent, and exact command immediately before acting.

**Prevents broad terminal effects.** Descendant recovery no longer sends a pane-wide Control-C. The final session-level action still passes through ReapAuthority, so lifecycle leases and keep guards remain authoritative.

**Prevents control-plane stalls and misleading replay.** Expensive tmux observations are removed from the asynchronous request-adjacent paths covered by this incident, while durable queue custody remains intact. Tests cover service classification, targeted interruption, slow tmux behavior, queue reason wiring, and end-to-end replay wording.

## What ships when

The watchdog, event-loop, queue, migration, and awareness changes ship together because splitting them would leave one of the observed failure paths active. The local machine is updated only after focused unit, integration, and end-to-end tests plus build and lint pass.

## What you actually need to decide

Should Instar ship this bounded repair so Codex test sessions remain uninterrupted and the server stays responsive under watchdog load?
