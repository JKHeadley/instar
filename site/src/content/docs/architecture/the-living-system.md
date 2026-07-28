---
title: The Living System
description: How roughly four dozen processes and fourteen default jobs form a single organism — mapped to the biological systems that keep it alive.
---

The [Under the Hood](/architecture/under-the-hood) page describes your agent's background processes (currently around forty-eight named systems across nine categories). The [Default Jobs](/reference/default-jobs) page describes its fourteen built-in scheduled jobs. But they don't operate in isolation — they form **a single organism** with interlocking systems that detect threats, learn from experience, maintain hygiene, and grow over time.

This page maps the complete system to biological analogies. Not because it's cute — because it reveals the design logic. Each biological system has a clear purpose, and so does each group of processes and jobs. When something goes wrong, the question isn't "which component broke?" but "which system is failing?"

---

## The Immune System

**Purpose:** Detect threats, respond to damage, recover from injury.

The immune system is the most layered part of the organism. It has innate immunity (fast mechanical responses), adaptive immunity (learned pattern matching), and a meta-immune layer that monitors whether the immune system itself is working.

| Component | Type | What It Does |
|-----------|------|-------------|
| **SessionRecovery** | Process | Innate immunity. Analyzes conversation files for three failure patterns (tool stalls, crashes, error loops) and truncates to a safe point. Handles 60-70% of failures with zero LLM cost. |
| **SessionWatchdog** | Process | Innate immunity. Kills stuck commands through escalating force (Ctrl+C → SIGTERM → SIGKILL). |
| **TriageOrchestrator** | Process | Adaptive immunity. 8 heuristic patterns handle 90% of remaining cases. Only spawns an LLM when no heuristic matches — and even then, deterministic predicates gate every auto-action. |
| **SessionMonitor** | Process | Surveillance. Polls every 60s, classifies sessions as healthy/idle/unresponsive/dead, feeds problems into the recovery stack. |
| **DegradationReporter** | Process | Symptom detection. Fires when any system falls back from primary to secondary path. Ensures no silent degradation. |
| **StallDetector** | Process | Promise monitoring. Detects when messages get injected but never answered, and when the agent says "working on it" but never follows up. |
| **health-check** | Job (5 min) | Vital signs. Server responding? Disk space OK? The simplest possible "am I alive?" check. |
| **guardian-pulse** | Job (8h) | Meta-immunity. Verifies that the other immune components (jobs) are actually running. If health-check stops, guardian-pulse notices. |
| **degradation-digest** | Job (4h) | Pattern recognition. Groups DegradationReporter events — a single fallback is noise; the same fallback every hour is a trend. |
| **state-integrity-check** | Job (6h) | Structural scan. Cross-validates state files for orphaned references, bloat, and corruption. |
| **session-continuity-check** | Job (4h) | Outcome validation. Did sessions actually produce artifacts? A 30-minute session that leaves no trace is a wasted session. |
| **overseer-guardian** | Job (6h) | Immune review. Analyzes all immune components as a group — spots contradictions, recommends tuning. |

**How it flows:** SessionMonitor detects → SessionRecovery tries fast fix → TriageOrchestrator runs heuristics → LLM diagnosis as last resort. Meanwhile, DegradationReporter catches fallbacks, health-check confirms vitals, guardian-pulse watches the watchers, and overseer-guardian reviews the whole immune response periodically.

---

## The Nervous System

**Purpose:** Carry messages, route signals, ensure nothing gets lost in transit.

| Component | Type | What It Does |
|-----------|------|-------------|
| **TelegramAdapter** | Process | Primary sensory interface. Long-polling for incoming messages, JSONL history for persistence. |
| **SessionSummarySentinel** | Process | Signal processing. Every 60s, summarizes each session's terminal output via Haiku. Enables intelligent message routing — "send to best session" works because summaries make sessions searchable. |
| **SessionActivitySentinel** | Process | Episodic memory formation. Every 30 min, creates condensed digests of what each session accomplished. |
| **NotificationBatcher** | Process | Signal prioritization. Three urgency tiers (immediate/summary/digest) with deduplication and quiet hours. |
| **DeliveryRetryManager** | Process | Guaranteed delivery. Three retry layers (server unreachable, session unavailable, ACK timeout) plus post-injection crash detection. |
| **MessageStore** | Process | Signal persistence. Atomic writes, deduplication, dead-letter archiving (30-day retention). |
| **TopicResumeMap** | Process | Session binding. Maps Telegram topics to session UUIDs so conversations survive session restarts. |
| **commitment-detection** | Job (5 min) | Promise extraction. Scans messages for commitments ("I'll build that tomorrow") and registers them for tracking. |
| **dashboard-link-refresh** | Job (15 min) | Signal maintenance. Keeps the Telegram dashboard link current as tunnel URLs change. |

**How it flows:** TelegramAdapter receives → SessionSummarySentinel scores sessions for routing → DeliveryRetryManager ensures delivery → NotificationBatcher controls outbound flow → MessageStore persists everything → commitment-detection extracts actionable signals.

---

## The Memory System

**Purpose:** Remember, learn, forget. Turn experience into durable knowledge.

| Component | Type | What It Does |
|-----------|------|-------------|
| **EvolutionManager** | Process | Learning lifecycle. Manages proposals from gap detection through review to implementation. |
| **MemoryMonitor** | Process | Memory pressure. Triggers cleanup when heap usage exceeds 80%. |
| **reflection-trigger** | Job (4h) | Experience capture. Reviews recent activity and writes learnings to MEMORY.md. Raw material for everything downstream. |
| **insight-harvest** | Job (8h) | Pattern synthesis. Groups learnings into insights, spots cross-domain connections, generates evolution proposals. |
| **evolution-proposal-evaluate** | Job (6h) | Critical review. Reads pending proposals, evaluates merit, approves or rejects. Does not implement. |
| **evolution-proposal-implement** | Job (4x/day) | Growth execution. Picks up approved proposals and builds them — new skills, hooks, job changes. The most expensive job by design. |
| **evolution-overdue-check** | Job (4h) | Commitment tracking. Monitors promises and commitments for overdue items. |
| **memory-hygiene** | Job (12h) | Memory grooming. Reviews MEMORY.md for stale entries, duplicates, and contradictions. |
| **memory-export** | Job (6h) | Memory consolidation. Regenerates MEMORY.md from the SemanticMemory knowledge graph. |
| **identity-review** | Job (daily) | Self-model maintenance. Checks whether behavior aligns with AGENT.md and soul.md. |
| **overseer-learning** | Job (2 days) | Meta-learning. Is the agent actually getting smarter, or is the learning pipeline busy-work? |
| **mentor-onboarding** | Job (15m, off) | Framework-onboarding mentor heartbeat. Pokes the in-process mentor tick that drives a mentee framework as the user, runs the leak-detector, and captures behavioral issues to the framework ledger. Ships dormant. |
| **failure-analyzer** | Job (weekly, off) | Failure-learning. Scans the failure ledger for dev-process patterns, surfaces evidence-thresholded insights, and opens human-approved improvements — never auto-implements. Closes the loop from "a fix broke" back to "the process that produced it." Ships dormant. |
| **initiative-digest-review** | Job (2x/week) | Rollout self-drive. Reviews the initiative board, surfaces decisions that are waiting, and for staged features gathers promotion evidence (dry-run → live → default-on) and recommends the next step. Recommends; never flips a flag. |

**How it flows:** reflection-trigger captures raw learnings → insight-harvest finds patterns → EvolutionManager creates proposals → evolution-proposal-evaluate approves → evolution-proposal-implement builds → memory-hygiene prunes → memory-export consolidates → identity-review checks alignment. overseer-learning watches the whole pipeline.

---

## The Circulatory System

**Purpose:** Move data between organs. Sync state across machines. Keep everything flowing.

| Component | Type | What It Does |
|-----------|------|-------------|
| **GitSyncManager** | Process | Blood flow. Debounced commits (30s), full sync cycles (30 min), multi-stage conflict resolution. |
| **LiveConfig** | Process | Hormone distribution. Watches config.json every 5s, emits events on change so systems hot-reload. |
| **git-sync** | Job (hourly) | Full reconciliation. Periodic deep sync with tiered model escalation for conflict resolution. |
| **feedback-retry** | Job (6h) | Clot resolution. Retries forwarding feedback items that failed to reach upstream. |
| **overseer-infrastructure** | Job (daily) | Circulation review. Checks sync success rates, link freshness, retry queues. |

**How it flows:** LiveConfig distributes local changes → GitSyncManager commits and syncs → git-sync job ensures hourly reconciliation → feedback-retry clears blockages → overseer-infrastructure reviews circulation health.

---

## The Skeletal System

**Purpose:** Structural integrity. The frame everything else hangs on.

| Component | Type | What It Does |
|-----------|------|-------------|
| **AutoUpdater** | Process | Bone growth. Checks for updates every 30 min, coalesces rapid releases, defers during active sessions. |
| **ProcessIntegrity** | Process | Structural verification. Detects when the running binary is stale vs what's on disk. |
| **CaffeinateManager** | Process | Posture (macOS). Prevents sleep while the agent is running. |
| **ForegroundRestartWatcher** | Process | Graceful molting. Watches for restart signals after updates, manages clean handoff. |
| **Graceful Shutdown** | Process | Controlled collapse. Signal handlers ensure clean teardown: stop polling, persist state, disconnect, unregister. |
| **CoherenceMonitor** | Process | Structural auditing. Every 5 min, checks process integrity, config coherence, state durability, output sanity, feature readiness. |
| **coherence-audit** | Job (8h) | Deep structural review. Verifies topic-project bindings, semantic coherence beyond what CoherenceMonitor checks. |
| **project-map-refresh** | Job (12h) | Spatial awareness. Regenerates the project territory map. |
| **capability-audit** | Job (6h) | Feature inventory. Refreshes the capability map and detects drift. |
| **overseer-maintenance** | Job (daily) | Maintenance review. Watches for diminishing returns in housekeeping jobs. |

---

## The Housekeeping System

**Purpose:** Clean up waste. Prevent accumulation. The biological equivalent of the liver and kidneys.

| Component | Type | What It Does |
|-----------|------|-------------|
| **OrphanProcessReaper** | Process | White blood cell. Every 60s, finds and kills orphaned Claude processes. |
| **JSONL Rotation** | Process | Kidney filtration. Size-based rotation for all append-only logs (>10MB → keep newest 75%). |
| **Session File Cleanup** | Process | Cell recycling. Removes session state for completed sessions (24h) and killed sessions (1h). |
| **Triage Evidence Cleanup** | Process | Wound cleanup. Every 6h, removes stale triage evidence and abandoned triage sessions. |
| **Recovery Backup Cleanup** | Process | Scar tissue removal. Every 6h, removes .bak files older than 24h. |
| **Dead-Letter Cleanup** | Process | Dead cell removal. Every 6h, removes failed messages older than 30 days. |
| **Temp File Cleanup** | Process | Metabolic waste. On startup, removes temp Telegram files older than 7 days. |
| **Global Install Cleanup** | Process | Foreign body removal. On startup, removes stale global instar installations. |

No paired jobs — housekeeping is entirely process-driven. It runs continuously because waste accumulates continuously.

---

## The Social System

**Purpose:** Relationships with other agents and the outside world.

| Component | Type | What It Does |
|-----------|------|-------------|
| **AgentDiscovery** | Process | Presence. 5-second heartbeat announcing this agent exists. |
| **HandshakeManager** | Process | Introduction protocol. Ed25519 identity keys for encrypted communication. |
| **TrustManager** | Process | Reputation. Tracks trust levels: untrusted → verified → trusted → autonomous. |
| **ThreadlineRouter** | Process | Conversation. Routes messages between agents via the Threadline protocol. |
| **InboundMessageGate** | Process | Boundary enforcement. Validates incoming relay messages against trust levels. |
| **Relay Client** | Process | Long-distance communication. WebSocket to the cloud relay for cross-machine messaging. |
| **AgentRegistry Heartbeat** | Process | Roll call. Every 30s, writes presence to the global agent registry. |
| **relationship-maintenance** | Job (daily) | Social awareness. Reviews tracked relationships, surfaces stale contacts. |

---

## The Dashboard

**Purpose:** External visibility. Let the operator observe the organism.

| Component | Type | What It Does |
|-----------|------|-------------|
| **WebSocketManager** | Process | Sensory nerve endings. Manages browser connections, auth, subscriptions. |
| **Terminal Stream** | Process | Live feed. Captures terminal output every 500ms, sends diffs to connected clients. |
| **Session List Broadcast** | Process | Status display. Sends running session metadata to all clients every 5s. |

No paired jobs — the dashboard is purely reactive to operator attention.

---

## System Totals

| System | Processes | Jobs | Total Components |
|--------|-----------|------|-----------------|
| Immune | 6 | 6 | 12 |
| Nervous | 7 | 2 | 9 |
| Memory & Learning | 2 | 9 | 11 |
| Circulatory | 2 | 3 | 5 |
| Skeletal | 6 | 4 | 10 |
| Housekeeping | 8 | 0 | 8 |
| Social | 7 | 1 | 8 |
| Dashboard | 3 | 0 | 3 |
| **Total** | **~48** | **~25** | **~73** |

*Note: Some processes appear in multiple categories (e.g., SleepWakeDetector spans Skeletal and Lifecycle). Some jobs serve multiple systems (e.g., overseer-guardian spans Immune and Meta). Counts are approximate — the organism doesn't have sharp boundaries between systems, and that's by design.*

---

## Why This Matters

When something goes wrong, thinking in systems rather than components tells you where to look:

| Symptom | Failing System | First Check |
|---------|---------------|-------------|
| Sessions keep dying | Immune | SessionRecovery logs, TriageOrchestrator heuristic matches |
| Messages not arriving | Nervous | DeliveryRetryManager queue depth, NotificationBatcher state |
| Agent not learning | Memory | reflection-trigger output quality, insight-harvest novelty scores |
| State out of sync | Circulatory | git-sync success rate, GitSyncManager conflict log |
| Disk filling up | Housekeeping | JSONL rotation thresholds, orphan process count |
| Agent acting strangely | Skeletal | CoherenceMonitor alerts, identity-review findings |

The biological metaphor isn't decorative — it's a diagnostic framework.

## See Also

- [Under the Hood](/architecture/under-the-hood) — Detailed descriptions of all the system processes
- [Default Jobs](/reference/default-jobs) — Detailed descriptions of all 26 scheduled jobs
- [Self-Healing](/features/self-healing) — The user-facing perspective on recovery
- [Evolution System](/features/evolution) — How the Memory & Learning system appears to users

---

## Inter-agent comms (the new building block)

A small set of internal modules powers the agent-to-agent Telegram comms primitive — the
groundwork for one Instar agent messaging another over Telegram with built-in anti-loop
machinery. **Ships dark today**; the mentor system will be its first consumer:

- **`AgentTelegramComms`** — the pure logic: visible `[a2a:from=… to=… role=… id=… corr=…
  ts=… v=1]` marker, strict parser, the recipient routing decision (with the user-spoof
  defense — a human typing the marker is dropped, not routed), and cycle-detection on
  `(fromBot, toBot, topic, role, corr)`.
- **`AgentTelegramLedger`** — append-only JSONL of every send and every receive decision.
  Best-effort + non-throwing (an audit-write failure cannot crash a tick).
- **`ProcessedIdStore`** — bounded persistent set of recently-seen marker ids so a
  Telegram retry or adapter restart can't double-inject the same prompt.

See `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` for the full design.
