---
title: Agent Sleep Mode (idle agent → near-zero footprint, wake on message)
slug: agent-sleep-mode
status: draft
author: echo
note: >
  DESIGN SPEC ONLY — not yet built. Authored during the 2026-05-30 autonomous
  Responsible Resource Usage run as the durable design for Level 3 (the largest
  facet). NOT approved for build: needs /spec-converge + Justin's review and
  `approved: true` before any code. Builds on the shipped IdleAwareCadence
  (idle-poller-cadence) primitive.
---

# Agent Sleep Mode

## Problem

The Responsible Resource Usage standard's deepest lever: an idle agent should
cost almost nothing. Today even a fully-idle agent runs a full stack — server
(HTTP + ~27 timer monitors), lifeline (Telegram long-poll), MCP stdio children,
plus pollers waking on fixed cadences. Across ~9 always-on stacks on one box this
"always-on floor" is the dominant CPU/memory cost (per the 2026-05-30 CPU
investigation). The Level-4 OS-hygiene work (Spotlight exclusion, worktree reaper)
and the Level-1 first slice (IdleAwareCadence backing off pollers) trim around the
edges; agent sleep is the structural endgame.

## The three components and what "sleep" can mean for each

1. **Lifeline** (`TelegramLifeline`, `instar-boot.cjs`) — lightweight long-poll;
   the always-on ear. MUST stay up to receive the wake signal. (~1 cheap process.)
2. **Server** (`AgentServer`) — heavy: HTTP routes + ~27 monitors/pollers/sentinels.
   The bulk of the idle cost. The sleep target.
3. **MCP stdio children** — spawned by **Claude Code** per `.mcp.json` at SESSION
   start, NOT by instar. instar cannot hibernate them mid-session (established this
   run). They only exist while a Claude/codex SESSION runs, so when no session is
   active there are typically zero MCP children already — agent sleep's job is to
   keep it that way (don't spawn sessions when idle) rather than to kill them.

## Two sleep models (stage them)

### Stage A — SOFT sleep (server stays up, drops to minimal activity)
The server keeps serving HTTP (so wake is instant and health stays observable) but
every non-essential timer backs off when idle. This is the **incremental, low-risk**
path and is already started:
- Pollers/sentinels adopt `IdleAwareCadence` (SHIPPED for TokenLedgerPoller). Roll
  out to the safe-when-sessionless watchers: the silently-stopped trio (socket /
  active-work-silence / context-wedge — nothing to watch with no session), the
  StaleSessionBackstop, PresenceProxy, the OrphanProcessReaper, the SessionReaper
  itself (no sessions ⇒ nothing to reap). Each must be individually verified safe
  to back off (the audit: "does this monitor have any work when there are zero
  running sessions?" — if no, it backs off).
- Define a single shared **idle signal** (`AgentActivityState`): idle ⇔ no running
  sessions AND no inbound message within `idleGraceMs`. Injected into every
  idle-aware poller so backoff is coherent and flips together.
- Savings: removes the per-tick churn (JSONL scans, tmux captures, liveness probes)
  — the measured waste — without any cold-start risk. Server RSS stays resident.

### Stage B — HARD sleep (server suspended/stopped when deeply idle)
For near-zero footprint, the server itself stops when idle long enough; the
lifeline stays up and respawns it on a wake. This is the **high-value, high-risk**
path:
- **Detect deep idle**: idle (Stage-A signal) for `deepIdleMs` (e.g. 15 min).
- **Stop path**: the supervisor stops the server (NOT a crash — a clean
  `sleep-requested.json` flag, mirroring the existing `restart-requested.json`
  handshake so it reuses the proven supervisor lifecycle and the reap-log records
  "slept" not "crashed"). State is file-based, so stopping loses nothing.
- **Wake path**: the lifeline receives a Telegram message (or an agent-to-agent
  ping, or an inbound HTTP request it proxies) → writes `wake-requested.json` →
  the supervisor respawns the server from the shadow install → the lifeline holds
  the inbound message in the durable PendingRelay/message-ledger until the server
  is healthy, then forwards it (zero message loss — the existing replay path).
- **Wake latency**: cold server boot (~30–45s observed for a force-restart this
  run). The user-facing contract: the lifeline immediately acks ("waking up…") and
  delivers the real reply once the server is up — same UX as a compaction pause.

## Decision points (signal vs authority)

The deep-idle → stop decision IS an authority (it stops the serving process). It
must be gated like the SessionReaper: positive proof of deep idle (no sessions, no
recent inbound, no in-flight work, no open lease/commitment that needs the server),
KEEP-awake on any ambiguity, and never sleep a machine that holds the multi-machine
lease without handing it off first. Ships OFF + a dry-run "would-sleep" log first.

## Hard constraints / risks

- **Never miss a wake**: the lifeline is the single point of always-on; its
  liveness is load-bearing. The out-of-process fleet watchdog must treat a
  sleeping-server agent as healthy (not restart it as "down").
- **Multi-machine**: the awake/lease-holding machine must NOT hard-sleep while it
  holds the lease; sleep ⇒ release/handoff first.
- **Scheduled jobs**: a cron job due during sleep must wake the server (the
  scheduler's next-fire time becomes a wake timer the lifeline arms).
- **Observability**: `GET /health` must remain answerable while asleep — likely the
  lifeline answers a minimal health on the server's behalf, reporting `state: asleep`.

## Staging recommendation

Ship **Stage A** incrementally (one poller per PR, each verified safe) — it
captures the measured per-tick waste with near-zero risk and needs no new
lifecycle. Treat **Stage B** as its own converged spec + project (the lifeline
wake-respawn handshake is the hard, risky part and deserves dedicated design +
the multi-machine/scheduler/watchdog interactions worked out before any code).

## Testing (when built)

Stage A: per-poller "backs off when sessionless / full cadence with a session"
(the IdleAwareCadence pattern). Stage B: a lifecycle harness — deep-idle detection,
sleep flag → supervisor stop, inbound message → wake flag → respawn → buffered
message replayed, no message loss, lease-held-blocks-sleep, scheduled-job wake.

## Rollback

Stage A: per-poller, omit the idle signal → prior fixed cadence. Stage B: dark +
dry-run by default; `enabled:false` keeps the server always-up (today's behavior).
