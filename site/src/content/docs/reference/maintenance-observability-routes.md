---
title: Maintenance and observability read routes
description: Read-only routes that report what the server's background maintenance and safety instruments are doing.
---

These routes answer "what is this instrument doing right now?" for background maintenance and safety features. All of them require the Bearer token. All except `POST /sessions/claude-binary/prune` are read-only.

- `GET /rate-limit/status` shows the RateLimitSentinel's active recoveries from server throttling: session name, status, attempts and the next backoff. The end-to-end "feature is alive" check reads this route.
- `GET /write-admission` shows the write-admission posture: the mode, per-domain admitted, refused and would-refuse counters, recent typed refusals, ownership-index stats and the event-loop lag gauge. It returns 503 when the development gate is dark.
- `GET /load-assessment/summary` summarises the machine-load assessment log: labels, who decided, the conflicts that triggered a decision, the outcome 15 minutes later, and whether each call was right. Rows carry no message content. It returns 503 when the assessor is not running on this agent.
- `GET /sessions/claude-binary` reports the Claude binary retainer: whether it is on, whether the last resolution used the original path and why, which versions are retained, and what the last prune did.
- `POST /sessions/claude-binary/prune` runs one prune pass. It never removes a version that a live process has mapped.
- `GET /worktrees/agent-reaper` lists every `.worktrees/` worktree with its verdict (active lock, uncommitted changes, not stale, unmerged, or reap-eligible), the reclaimable count, and whether reaping is enabled or in dry run.
- `GET /codex-arm-sweeper` reports whether Codex arm sessions are still leaking: the sweeper's posture (enabled, dry run, age threshold), cumulative killed, kept and error counts, and the last kills. A disabled sweeper answers 200 with `enabled: false`; 503 means it is not wired.
- `GET /mesh-selfheal/g3` reports the observe-mode mesh self-heal guard: a summary that includes whether it would have prevented a duplicate, and a promotion recommendation (promote, keep soaking, consider removal, or enforcing). It never gates anything.
