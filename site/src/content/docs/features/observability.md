---
title: Observability
description: Token burn detection, quota tracking, telemetry, homeostasis monitoring, and session activity tracking.
---

A long-running agent quietly accumulates a lot of state — token usage, quota headroom, session health, hardware pressure, credential rotations. Instar ships a suite of observability subsystems that watch this state continuously and surface anomalies before they become outages.

These subsystems are mostly invisible until something goes wrong. When they do speak up, it's because they noticed something a human or a higher-level agent should know about.

## Token burn detection

Components: `BurnDetector`, `BurnDetectionSubscriber`, `BurnThrottleRunbook`, `BurnVerifier`, `BurnAlertButtons`, `BurnAlertDelivery`.

The burn detector watches token consumption per-session and per-job. If a session burns through tokens at an unusually high rate — measured against the agent's historical pattern — the detector fires a burn-alert. The alert lands in Telegram with action buttons so you can pause the offending session, throttle the responsible job, or acknowledge and continue.

The throttle runbook is automated: once a burn alert escalates past a configured threshold without user response, the runbook engages and reduces job concurrency to a safe rate. This prevents an unattended burn from running the daily cap to zero.

The verifier double-checks the detector's signals. Burn detection is a brittle signal by design (rates can spike legitimately during heavy work); the verifier asks a higher-context check (is this session doing meaningful work, or stuck in a retry loop?) before escalating.

`BurnAlertDelivery` owns terminal delivery state. If Telegram reports that the configured burn-alert topic is permanently gone, it quarantines that destination across restarts and transfers the warning to the durable Attention hub. The original warning remains pending until the hub accepts custody, while temporary network failures remain retryable.

## LLM rate-limit circuit breaker

Components: `LlmCircuitBreaker`, `CircuitBreakingIntelligenceProvider`.

Where burn detection reacts to token *volume* over a rolling window, the circuit breaker reacts to the provider's own rate-limit *signal* in milliseconds. It exists because a background LLM loop that keeps calling the model after the account is over its usage or spend limit will, with auto-reload enabled, burn credits indefinitely — every call past the limit is either rejected or freshly billed.

`CircuitBreakingIntelligenceProvider` wraps every intelligence provider at the single construction chokepoint, so every LLM-backed feature is covered without per-feature code. When a call returns a usage/rate/spend-limit error, the shared account-global `LlmCircuitBreaker` opens: subsequent calls short-circuit in-process — no subprocess is spawned, so they cost nothing — for a cool-down window (15 minutes by default). After the window it admits a single probe; a successful probe closes the breaker and work resumes, a still-limited probe re-opens it. The breaker enforces the provider's decision rather than making a policy decision of its own, and it is on by default (tune or disable via `intelligence.circuitBreaker` in `.instar/config.json`).

## Loop-safety brakes (P19 "No Unbounded Loops")

Components: `PeerFailureLogGate`, `FailureEpisodeLatch`, `OwnerSuspectBreaker`, `SlowRetrySentinelEscalation`, `AgeKillBackoff`.

Every repeating behavior in the multi-machine mesh carries its own brakes, enforced by the constitution's "No Unbounded Loops" standard. `PeerFailureLogGate` converts per-attempt failure logging into state-change logging (one line when a peer becomes unreachable, a coarse reminder every Nth consecutive failure, one line on recovery) — a down peer produces ~49 log lines a day instead of ~17,000. `FailureEpisodeLatch` is the canonical episode accountant behind the Eternal Sentinel clause: a loop that retries forever raises exactly ONE degradation signal per sustained-failure episode, re-armed on recovery. `OwnerSuspectBreaker` is the session router's per-machine circuit: a machine whose message deliveries keep failing is marked suspect for an absolute 30-second half-open window, during which its sessions route straight to failover re-placement instead of each re-paying the delivery retry tax; any successful delivery closes the window instantly. `SlowRetrySentinelEscalation` gives the server supervisor's never-give-up revival loop its one-per-outage operator notification, and `AgeKillBackoff` keeps the session reaper from re-requesting a kill its keep-guard already vetoed.

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

## Resource ledger

Components: `ResourceLedger`, `ResourceLedgerPoller`, `ResourceSampler`.

See the dedicated [Resource ledger (CPU + memory)](/features/resource-ledger/)
page for the full Phase B CPU/memory tracking story; the summary below covers how
it fits the broader observability surface.

Read-only, durable per-agent rate-limit-event observability (Phase A). Until now,
every time the account got throttled — a circuit-breaker trip, or a session
hitting Anthropic's server-side rate limit — was counted only in process-local
memory and lost on restart, so "how many times were we throttled today?" had no
answer. The `ResourceLedger` is a SQLite store (same pattern as the `TokenLedger`)
that persists each rate-limit event durably; the `ResourceLedgerPoller` feeds it
event-driven from the `LlmCircuitBreaker`'s trip/recover observer plus the existing
`RateLimitSentinel`, writing one row per emission.

It exposes `GET /resources/rate-limits?sinceHours=N`, which returns a
`RateLimitSummaryRow` (breaker trips as the headline `circuitOpenCount` +
`tripsPerHour`; session-sentinel detections counted separately), a per-kind
breakdown (`RateLimitKindRow`), and recent events (`RateLimitEventRow`). The event
shape is `RateLimitEventInput` — a `RateLimitEventKind`
(`circuit-open` / `circuit-recover` / `throttle` / `quota` / `529`) tagged by its
`RateLimitEventSource` (`circuit-breaker` vs `session-sentinel`), so the two
signals never silently merge.

The `ResourceLedger` never gates, throttles, or mutates any flow — it only records
(constructed via `ResourceLedgerOptions`, registered for close-on-exit, writes
swallow their own errors so observability can never break the observed path). The
breaker observer it subscribes to (`TripObservableBreaker`) and the sentinel
surface (`RateLimitEventSentinel`) are pure side-channels: a listener error can
never affect the `LlmCircuitBreaker` that gates real work. The poller
(`ResourceLedgerPollerOptions`) is event-driven and default-on at negligible cost.

**Phase B — CPU + memory sampling.** The `ResourceSampler` (mirroring
`TokenLedgerPoller`) closes the gap where Instar tracked *zero* CPU and *zero*
memory per agent. On a cadence it samples the agent's own server process (CPU%
via a `process.cpuUsage()` delta over the interval, RSS + heapUsed via
`process.memoryUsage()`) and each spawned session by its pane PID (one batched
`ps` call, dead-PID tolerant), plus a computed aggregate, into the same
`ResourceLedger` (a `resource_samples` table, bounded by a retention prune). It
exposes `GET /resources/summary` (current + windowed avg/peak CPU%/RSS per source)
and `GET /resources/samples` (recent raw samples), and the dashboard "Resource
Usage" tab renders both in plain language. The sampler rides the
`developmentAgent` dark-feature gate (live on dev agents, dark on the fleet) and
is fail-open: a sampling error never throws or crashes the poller, and it never
gates, throttles, or mutates anything — strictly observation.

## Session clock

Components: `SessionClock`, `SessionClockReader`.

Read-only time-awareness so an agent always knows how long it has been running and how much time is left, instead of guessing. `SessionClock` is a pure, deterministic module that computes elapsed/remaining (with clock-skew clamping — it never reports a negative or absurd value) and a human-readable label derived safely from the session's goal. `SessionClockReader` maps each active time-boxed (autonomous) session record into a computed clock, with optional per-topic binding.

The data is exposed via the read-only `/session/clock` HTTP route (`?topic=N` to bind to a single session). Like the token ledger, the `SessionClock` path never mutates source files and the response is leak-bounded: it surfaces a sanitized, length-capped label only, never the raw goal text. The agent quotes these numbers before reporting progress or deciding a session is over.

## Usher precision (continuous-working-awareness)

Components: `UsherSignalStore`, `UsherActedCorrelator`.

The Usher (rung 4 of the [Continuous Working Awareness](/foundations/north-star/) loop) watches mid-task and fires a *re-surface signal* when a faded-but-now-relevant context comes back. Those signals are signal-only — they never interrupt the agent yet. Whether they ever earn the right to interrupt (rung 5) is gated on one number: **precision** = how often a re-surfaced nudge was actually useful.

`UsherSignalStore` records every fired signal and exposes the precision funnel at `GET /usher/metrics?topicId=N` — `fired`, `acted`, and `precision` (`acted / fired`), plus `acted_by_use` / `acted_by_miss` so the numerator is visible split by which path earned it. `GET /usher/signals?topicId=N` is the read-only pull surface of recent suggestions.

`UsherActedCorrelator` is what moves the `acted` numerator. A nudge is credited two ways, both best-effort and never blocking delivery:

- **auto-use** — when the agent's next reply on the topic actually uses the re-surfaced context (salient-term coverage match), the signal is marked acted (`via: 'use'`).
- **miss-map** — when the user later has to *correct* the agent on a context a recent nudge already flagged (a `HumanAsDetectorLog` signal), that nudge was a genuine catch the agent ignored — still a true positive, marked acted (`via: 'miss'`).

Matching is precision-over-recall: a falsely-high precision is the dangerous direction (it gates interruption), so the correlator under-credits a fast or marginal reply rather than inflating the gate. Pair `/usher/metrics` (what the Usher caught and used) with `/human-as-detector/summary` (what the user still had to catch) for the full "is the working-awareness loop actually working?" read.

## What the agent does with all this

Every observability signal lands in the `DegradationReporter` channel, which dedupes, prioritizes, and surfaces signals to whichever notification path is configured (Telegram by default). Repeating patterns get grouped — three similar burns in one day become "Burn pattern: heavy reflection-trigger runs" rather than three separate alerts.

The agent's own behavior responds to these signals too. The Coherence Gate consults quota state when deciding how much to write. The scheduler shedds load. The remediator opens runbooks for known patterns. The observability layer is what makes "fully autonomous" actually work — without it, the agent would happily burn through quota or wedge a runaway loop with nobody watching.

## Related: learning from corrections

The `HumanAsDetectorLog` signal above ("what the user still had to catch") is also the front door of the [Correction & Preference Learning](/features/correction-preference-learning/) loop — the conversational twin of the Failure-Learning Loop. Where failure learning closes the gap on code that broke, that loop closes the gap on *interaction* failures: a recurring correction is captured by `CorrectionCaptureLoop`, distilled, deduplicated into the `CorrectionLedger`, gated for genuine recurrence by `CorrectionAnalyzer`, and routed by the authority-guarded `CorrectionLoopDriver` — either upstream as `/feedback` or into a durable user preference via `PreferencesManager`. It is signal-only and ships dark; see its dedicated page for the full pipeline. If the distillation call is rate-limited at capture time, the scrubbed capture is held in a bounded durable backlog (`CorrectionCaptureBacklog`) and distilled later when the LLM has headroom, so a sustained throttle can no longer silently lose a correction. The same loop also turns the agent's *own* slips into evidence: when a learned preference carries a violation pattern and the agent then sends a message that contradicts it, the `SelfViolationDetector` records that self-violation in the `CorrectionLedger` so the preference's recurrence climbs — observe-only, never blocking the message.

## Idle-error recovery (session-stall detection)

When a session goes quiet at its prompt, a background loop decides whether it stalled on a transient API error (and should be nudged back to life) or simply stopped normally. That decision is a deterministic *signal*, not a gate: `IdleErrorClassifier` (`classifyIdleError`) inspects the live tail of the session's terminal and fires only when a terminal-error token sits in the last ~20 non-empty lines **on a line the harness actually emitted as an error** — a two-tier rule (the line begins with `API Error:`, or it is led by Claude's own bullet/tree glyph and begins with one of the known error tokens). A token merely mentioned mid-line (prose, a quoted log, a tool's own `Error:`) does not count, which kills the stale-scrollback and quoted-content false positives the old bare substring scan suffered.

The tail-gating itself lives in one shared helper, `paneTail` (`liveTail` / `stripLineLead` / `wasGlyphLed`), so "what counts as the live tail" has a single definition rather than a copy per consumer — the same helper `StuckSignatureClassifier` uses for its honest turn-receipts. The capture is widened to clear Claude Code's input-box chrome (which renders well below the error line), so a genuine error can't be pushed off-screen.

The classifier's signal feeds the **existing** recovery actuator — it emits `apiErrorAtIdle`, which `RateLimitSentinel` turns into a non-destructive backoff → nudge → verify → escalate loop (it never restarts a session on its own; the worst case of a wrong signal is one wasted nudge the verify step proves was a no-op). Every classify decision (fired vs suppressed) is recorded once per idle episode, so a wave of suppressions on genuine errors is observable rather than a silent under-fire. This keeps the idle-error path consistent with the broader [Signal vs. Authority](/foundations/north-star/) posture: the brittle detector signals, the full-context actuator decides.

## Process footprint (the climb measurement)

CPU and memory sampling tells you how *hard* the machine is working, but not how *many*
processes are running — and it was the slow climb of the process count (several agent
stacks plus their heavy, mostly-idle MCP servers: a whole Chromium for Playwright, an
Electron) that went unwatched until the host hit a kernel limit and panicked on
2026-06-26. The `ProcessFootprintMonitor` adds exactly that missing measurement. On an
interval it counts the agent-relevant processes on the machine and classifies them —
agent CLIs, MCP servers (matched by the same allow-listed signatures the MCP cleanup
sweep uses), and other node — keeping a bounded rolling window so a TREND (rising /
stable / falling) is visible.

It is **observe-only**: it never kills, throttles, or gates anything (reclaiming
processes is the reapers' job). Read it at `GET /resources/footprint` → `{ enabled,
latest: { total, byKind, rssBytes }, trend, overThreshold, samples }`. It ships dark
(rides the developmentAgent gate, so it dogfoods on a dev agent before any fleet
rollout) and every reading path fails safe (a failed scan keeps the last sample rather
than crashing). An optional threshold heads-up exists but is **off by default** —
measure first. It registers in the guard posture, so `GET /guards` shows whether it is
on.
