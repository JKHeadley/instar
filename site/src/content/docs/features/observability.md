---
title: Observability
description: Token burn detection, quota tracking, telemetry, homeostasis monitoring, and session activity tracking.
---

A long-running agent quietly accumulates a lot of state — token usage, quota headroom, session health, hardware pressure, credential rotations. Instar ships a suite of observability subsystems that watch this state continuously and surface anomalies before they become outages.

These subsystems are mostly invisible until something goes wrong. When they do speak up, it's because they noticed something a human or a higher-level agent should know about.

## Token burn detection

Components: `BurnDetector`, `BurnDetectionSubscriber`, `BurnThrottleRunbook`, `BurnVerifier`, `BurnAlertButtons`.

The burn detector watches token consumption per-session and per-job. If a session burns through tokens at an unusually high rate — measured against the agent's historical pattern — the detector fires a burn-alert. The alert lands in Telegram with action buttons so you can pause the offending session, throttle the responsible job, or acknowledge and continue.

The throttle runbook is automated: once a burn alert escalates past a configured threshold without user response, the runbook engages and reduces job concurrency to a safe rate. This prevents an unattended burn from running the daily cap to zero.

The verifier double-checks the detector's signals. Burn detection is a brittle signal by design (rates can spike legitimately during heavy work); the verifier asks a higher-context check (is this session doing meaningful work, or stuck in a retry loop?) before escalating.

## Quota tracking

Components: `QuotaTracker`, `QuotaManager`, `QuotaCollector`, `QuotaNotifier`, `QuotaExhaustionDetector`.

The quota tracker maintains a rolling per-day, per-hour, and per-minute view of API consumption across all model tiers. The scheduler reads from it and shedds load as quota tightens, via the threshold buckets documented in [default jobs](/reference/default-jobs#quota-aware-backpressure):

| Bucket | Action |
|------|------|
| normal | Full scheduling |
| elevated | Defer Opus-tier jobs |
| critical | Defer Sonnet-tier jobs as well |
| shutdown | Pause everything except health-check |

The exhaustion detector watches the same numbers and predicts when you'll hit the cap if current trends continue. It notifies via Telegram before exhaustion so you can decide to pause work, raise the cap, or adjust the job mix.

The notifier handles delivery — including silence windows so you don't get hammered with the same warning every five minutes.

## Telemetry collection

Components: `TelemetryCollector`, `TelemetryAuth`, `TelemetryHeartbeat`.

The telemetry layer records what happened across sessions: which jobs ran, how long they took, what models they used, what errors they surfaced, what artifacts they produced. The collected data lives in the agent's local state and is never sent off the machine without explicit opt-in.

A heartbeat verifies the telemetry pipeline itself — if heartbeats stop arriving, the homeostasis monitor flags it.

Authentication wraps the telemetry surface so other instar agents or trusted operators can pull telemetry for analysis without being able to spoof entries.

## Homeostasis monitoring

Component: `HomeostasisMonitor`.

The homeostasis monitor is the system-health probe that runs continuously to check that everything else is OK. It watches:

- Process integrity (server process alive, lifeline alive, scheduler alive)
- Disk space and memory pressure
- Database health (SQLite WAL size, query latency)
- Heartbeat liveness from telemetry, scheduler, sentinels
- Native module integrity (better-sqlite3 binary works, etc.)

When the monitor detects a deviation from healthy baseline, it raises a degradation via the `DegradationReporter` and surfaces it via Telegram. Critical degradations also trigger the self-healing remediator.

HTTP routes are at `/homeostasis/*` for inspection.

## Session activity tracking

Components: `SessionActivitySentinel`, `ActivityPartitioner`.

Long-running sessions accumulate a lot of activity. The session activity sentinel partitions that activity into meaningful episodes — a coherent unit of work with a beginning and an end — and writes summaries that the memory system can later recall. This is what makes "what did you do yesterday around noon?" actually answerable.

The partitioner is the algorithm that decides where one episode ends and the next begins. It uses signals like topic switches, long pauses, explicit user marking, and job-boundary events.

## Release readiness (instar-dev / maintainer environments)

Components: `ReleaseReadinessSentinel`.

A repo-gated watchdog that makes a stalled instar release impossible to miss. It evaluates canonical `main` and, when finished work sits unreleased while publishing is blocked, raises ONE deduped, age-escalating item on the Attention queue. Ships OFF (Echo dogfoods first); the `release-readiness-check` job drives it. Null on any install with no analyzable instar git repo. Routes: `GET /release-readiness`, `POST /release-readiness/tick`, `POST /release-readiness/rollback` (loud — raises a HIGH attention item + audits, never silent).

## Credential management

Components: `SessionCredentialManager`, `ClaudeConfigCredentialProvider`, `KeychainCredentialProvider`, `BitwardenProvider`.

Credentials (API keys, bot tokens, OAuth refresh tokens) come from multiple sources depending on the host: macOS Keychain, Bitwarden vault, Claude Code config, environment variables, or `.instar/keys/`. The session credential manager resolves the right source for each credential type and rotates them through a unified interface.

This is what lets your agent keep working when you rotate your Anthropic API key in Keychain without restarting anything — the next session pulls the new key automatically.

## Token ledger

Components: `TokenLedger`, `TokenLedgerPoller`.

Read-only token-usage observability. The ledger scans Claude Code's JSONL session transcripts, extracts per-message token counts, and exposes the data via `/tokens/summary` and `/tokens/sessions` HTTP routes. The poller runs in the background, tracks byte offsets per file so re-scans are idempotent, and updates the ledger as new turns get written.

The ledger never mutates source files — it only reads. The poller is the only writer (to its own SQLite index), and even that is restartable from any state.

## What the agent does with all this

Every observability signal lands in the `DegradationReporter` channel, which dedupes, prioritizes, and surfaces signals to whichever notification path is configured (Telegram by default). Repeating patterns get grouped — three similar burns in one day become "Burn pattern: heavy reflection-trigger runs" rather than three separate alerts.

The agent's own behavior responds to these signals too. The Coherence Gate consults quota state when deciding how much to write. The scheduler shedds load. The remediator opens runbooks for known patterns. The observability layer is what makes "fully autonomous" actually work — without it, the agent would happily burn through quota or wedge a runaway loop with nobody watching.
