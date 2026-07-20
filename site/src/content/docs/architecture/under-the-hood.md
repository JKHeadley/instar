---
title: Under the Hood
description: How around 48 background systems keep your agent alive, responsive, and self-healing.
---

Your agent isn't just Claude in a terminal. Behind every session, **around 48 background systems** work continuously to keep things running — recovering from crashes, delivering messages reliably, syncing state across machines, and cleaning up after themselves.

**None of these were designed upfront.** Every system on this page exists because something actually broke in production. Sessions stalled silently, messages vanished, laptops slept and agents went brain-dead, logs filled disks, orphaned processes ate memory. Each problem showed up during real usage, got diagnosed, and got solved — then the solution became a permanent part of the platform. This isn't speculative architecture. It's roughly four dozen battle scars turned into armor — and the count grows over time as new failure modes show up and earn permanent solutions.

This page gives you the bird's-eye view. Scan the overview, then open any category to look inside the engine.

## The Nine Categories

| Category | What It Does | Processes |
|----------|-------------|-----------|
| [Session Management](#session-management) | Catches crashes, recovers sessions, keeps you from losing work | 4 |
| [Health Monitoring](#health-monitoring) | Watches the agent's own health and alerts when something degrades | 4 |
| [Core Infrastructure](#core-infrastructure) | Updates, config hot-reload, sleep recovery, process integrity | 7 |
| [Messaging](#messaging) | Reliable message delivery, intelligent routing, notification batching | 5 |
| [Agent Network](#agent-network) | Discovery and communication between agents (Threadline) | 6 |
| [Dashboard & Streaming](#dashboard--streaming) | Real-time terminal output and session monitoring in your browser | 3 |
| [Housekeeping](#housekeeping) | Cleans up zombie sessions, rotates logs, prunes old data | 8 |
| [Lifecycle](#lifecycle) | Sleep/wake recovery and graceful shutdown | 2 |
| [Platform Services](#platform-services) | Quota tracking, commitments, evolution, memory monitoring | 9 |

---

## Session Management

**The safety net.** Four systems work together in layers — each catches what the previous one misses.

<details>
<summary>See the 4-layer recovery stack</summary>

### SessionWatchdog
Polls every 30 seconds for stuck bash commands. If a command has been running longer than 3 minutes, it asks an LLM: "Is this legitimately long-running (like `npm install`) or actually stuck?" If stuck, it escalates through Ctrl+C → SIGTERM → SIGKILL, giving the session time to recover at each step. Sessions almost always survive — the nuclear option (killing the whole session) requires a process to survive both SIGTERM and SIGKILL twice.

### SessionRecovery
The fast mechanical layer. Analyzes the conversation JSONL file to detect three failure patterns:
- **Tool stalls** — Claude sent a tool call but never got a result back
- **Crashes** — Process died with an incomplete conversation
- **Error loops** — Same error repeated 3+ times

When detected, it truncates the conversation to a safe point and respawns. No LLM needed — pure file analysis. Handles ~60-70% of failures instantly.

### TriageOrchestrator
The intelligent layer. Has 8 battle-tested heuristic patterns that resolve ~90% of remaining cases without any LLM call:
- Session dead → auto-restart
- Message lost (prompt visible but message pending) → re-inject
- JSONL actively being written → wait and check back in 5 minutes
- Fatal errors (out of memory, segfault) → auto-restart
- Context exhausted (≤3% remaining) → auto-restart

Only when no heuristic matches does it spawn a scoped Claude session to diagnose the problem. Even then, deterministic safety predicates gate every auto-action — the LLM can suggest, but only verified conditions trigger automatic recovery.

### SessionMonitor
The proactive eye. Polls every 60 seconds to classify each session as healthy, idle, unresponsive, or dead. Feeds problems into the recovery stack before users notice. Won't spam you — one notification per issue, with a 30-minute cooldown per topic.

**How they connect:** SessionMonitor detects the problem → SessionRecovery tries a fast fix → if that doesn't work, TriageOrchestrator runs heuristics → if those don't match, it spawns an LLM diagnosis. Meanwhile, SessionWatchdog independently catches stuck commands at the process level.

### Codex wedge self-recovery (StuckInputSentinel escalation)

A codex conversational session can **wedge**: the server is healthy and a message was delivered, but the session sits paused with the injected message stuck at the prompt, never draining into a turn. The **StuckInputSentinel** already detects this (marker-based) and nudges the prompt with keypresses — but live, keypresses weren't always enough; the session needed a full server restart + queue replay.

This escalation lets a codex agent heal itself with no external nudge, across a process boundary: the detector runs in the server process, but the restart authority (`ServerSupervisor` + queue replay) runs in the lifeline process.

- **SessionRecoveryChannel** — the cross-process request/ack channel. The server-side sentinel writes recovery *requests* (sole writer of the request file); the lifeline writes *acks* (sole writer of the ack file) — single-writer-per-file, atomic, so the two processes never race. It also holds a **durable** restart cooldown: a server restart wipes the sentinel's in-memory loop-guard, so the cooldown that prevents a restart loop has to survive on disk.
- **SessionRecoveryConsumer** — the lifeline-side executor. Reads tier-C requests and performs `ServerSupervisor.performGracefulRestart` + queue replay, **dry-run-first**, refusing to restart while the durable cooldown is active and deduping on attempt id. It is the *authority* half: the sentinel only signals; the consumer decides and acts.

Ships **dark** behind `monitoring.codexWedgeRecovery` (default off, dry-run first) on the Graduated-Feature-Rollout track. With no config it is byte-for-byte the legacy keypress-only behavior.

### PendingInjectStore (queued messages survive restarts)

When a session is spawned for an inbound message, the message is typed in only after the session finishes booting — tens of seconds on codex. That in-flight inject used to be process-local: a server restart in the window silently dropped the user's message while the terminal session survived at an idle prompt. The **PendingInjectStore** makes the in-flight inject durable — one JSON record per pending inject, written at spawn, cleared only after the message is actually injected. On boot, `SessionManager.recoverPendingInjects` sweeps survivors: still-alive sessions get their message re-delivered through the normal readiness path; dead or stale records are reported loudly through DegradationReporter and retired. Delivery is deliberately at-least-once — a rare duplicate beats a silent drop.

</details>

---

## Health Monitoring

**The self-awareness layer.** The agent continuously checks its own health and tells you when something breaks.

<details>
<summary>See the 4 monitoring systems</summary>

### CoherenceMonitor
Every 5 minutes, runs checks across 5 categories: process integrity (is the binary stale?), config coherence (does the file match what's in memory?), state durability (are state files intact?), output sanity (is the agent producing reasonable responses?), and feature readiness (are tokens and credentials properly set?).

### SystemReviewer
Every 6 hours, runs deep functional probes — not just "is this component alive?" but "does it actually work?" Tests session spawning, scheduler health, messaging connectivity, and platform resources. Trends results over a 10-review window to detect persistent failures vs transient blips.

### StallDetector
Monitors message delivery. When a message is injected into a session and gets no response within 5 minutes, it verifies whether the session is truly stalled (not just busy), then triggers the recovery pipeline. Also tracks "promise detection" — when the agent says "working on it" but never follows up.

### DegradationReporter
Event-driven — fires whenever a system falls back from its primary path to a secondary one. For example, if SQLite-backed memory fails and falls back to JSONL, the reporter logs it, files a bug report, and sends you a human-readable Telegram notification. Ensures no fallback happens silently.

</details>

---

## Core Infrastructure

**The invisible plumbing.** You never think about these until they save you.

<details>
<summary>See the 7 infrastructure systems</summary>

### AutoUpdater
Checks for new versions every 30 minutes. When an update is found, it coalesces rapid-fire releases (waits 5 minutes for additional updates before acting), checks if there are active sessions (defers restart if so, forces after 30 minutes), and handles the restart cleanly. Can be disabled in config.

### GitSyncManager
Automatic git-based state synchronization for multi-machine setups. Debounces commits (30 seconds), runs a full sync cycle every 30 minutes, and has multi-stage conflict resolution: programmatic merging for simple cases, LLM-powered resolution for complex ones, human escalation as a last resort.

### CoherenceJournal
The multi-machine "diary" writer (P1 of the coherence initiative). Each machine appends per-kind event streams — topic placement (with the reason it moved), session open/close/reap, autonomous runs with their artifact paths — so "what happened where, and where are the files?" is answerable from local disk. Emits are non-blocking memory hand-offs (a background flusher owns all disk I/O), crash repairs are counted, restores-from-backup are detected via incarnation tokens, and a strict per-kind schema keeps free text and secrets out. Signal-only by design: nothing ever kills, spawns, or moves anything based on journal data — the companion `CoherenceJournalReader` (a deliberately separate module, so a lint can ban actuators from importing it) serves the merged bounded read view behind `GET /coherence/journal`. Ships dark; per-kind retention keeps placement history effectively forever.

### JournalSyncApplier
The receive/serve engine of coherence-journal replication (P1.3). On the serve side it reads THIS machine's own durably-flushed stream from a peer-requested sequence number and returns a bounded batch (256KB cap — never a giant single response). On the receive side it durably appends a peer's entries under that peer's machine id, binding every entry to the AUTHENTICATED envelope sender — an entry claiming to be from a machine other than the one that sent it is counted as forged and dropped (first-hop-only trust: no machine can relay or invent another machine's history). Gap detection marks a replica stream `suspect` rather than silently skipping sequence numbers.

### PeerPresencePuller
The 30-second heartbeat that keeps a machine's view of its peers honest. Each tick it pulls every registered peer's session-status over the signed mesh channel, records who answered (feeding "is the Mini actually reachable?" rather than guessing), and piggybacks the coherence-journal advert exchange — a peer's response carries its own stream heads, so delta requests ride an existing cadence instead of a new polling loop. A peer coming back online after an outage is observed HERE, which is what re-arms recovery work that was waiting for it.

### WorkingSetManifest
The pure "what files make up this conversation's workspace on this machine?" computation (P2.1 of the coherence initiative). Candidates come from durable evidence only — the `autonomous/<topic>.*` filesystem convention plus every artifact path the topic's own journal stream recorded — never from anyone remembering to declare anything. Every candidate is canonicalized and jailed (symlinks at the final component refused; escapes counted, never served), hashed (sha256 is the only decision key; mtime is display-only), scanned for credential shapes (flagged files are listed but never transferred — an honest refusal, not a silent skip), and capped (per-file, headline exemption for the topic's own `.local.md`, max 64 files). When the topic's run is still live, every entry is marked "still being written" so a mid-run snapshot is never served.

### WorkingSetPull
Both sides of the "files follow the conversation" transfer (P2.2). The serve side answers a peer's pull from a manifest recomputed FRESH on every request — there is no generic remote file read; a path outside the fresh manifest is refused. Files travel in 1MB slices (one giant response was the laptop's documented freeze root-cause), each slice carrying a cheap consistency anchor so a file rewritten mid-transfer restarts cleanly from zero instead of assembling a Frankenstein copy — bounded retries, then one honest "this file won't sit still." The receive side treats every peer-supplied path as hostile, verifies the whole file's hash before a single byte lands, and NEVER overwrites: a divergent local file keeps its place and the incoming copy lands alongside it (capped at two, idempotent for repeated identical arrivals). A busy producer answers "busy" and the caller backs off without burning recovery budget.

### WorkingSetPullCoordinator
The piece that makes the file transfer FIRE (P2.2). Three triggers share one pipeline: a conversation arriving on this machine (the moment the receiver knows it owns the topic), an explicit "go fetch this topic's workspace" call, and a producer machine coming back online (which drains its written-down pending fetches one at a time — a machine that just woke holding ten topics' files isn't mobbed by ten simultaneous pulls). Producers are nominated from journal evidence — every machine the diary shows actually MADE artifacts for the topic, not just the last owner — capped at three with the excess named, never silent. One pull per topic at a time; a repeat move at the same ownership epoch is deduped through a restart-proof window; everything defers under host pressure.

### PeerVisibilityGuard
The mesh-health rider (P2.2) earned from the Mini's ten invisible hours: a machine revoked with no record of who-or-why gets flagged the moment it's seen (once, across reboots — a crash-loop can't re-spam it), and a machine that should be in the pool but has gone silent past a 30-minute grace produces one calm notice naming it AND naming any topic workspaces stranded on it. A machine that keeps dropping and returning collapses to a single "it's flapping" notice. Hygiene signal only — it detects sloppy state, never judges legitimacy, and clears silently when the machine returns.

### PendingPullLedger
The durable "files I still owe you" notebook (P2.2) — the EXO case, solved. A pull whose producer machine is asleep, unreachable, or wrongly evicted doesn't die at a retry limit; it's written down durably and re-fires the moment that machine returns. All six things that can write to it go through one serialized funnel (the exact lost-update race that caused a notification flood gets closed at birth), a corrupted notebook is quarantined with one honest notice — never silently read as empty — and a record that goes a week unrecovered surfaces once instead of forever.

### AutonomousSessions
The shared helpers behind multi-session autonomy: which topics have an active autonomous job right now (each topic's run lives at `.instar/autonomous/<topicId>.local.md`), the stable run-id derivation that lets monitors and the coherence journal name a specific run, and the parsing of run state (goal, duration, end time) that the can-start gate, the session clock, and the stop hook all share. One source of truth for "what's running" instead of three slightly-different parsers.

### ApprovalLedger
The durable record of operator approvals (PIN-gated decisions like mandate issuance). Every approval is appended with what was approved, when, and under which authority — so "did the operator actually authorize this?" is answerable from disk long after the chat scrolled away. Append-only and hash-chained: a tampered entry breaks the chain visibly rather than rewriting history silently.

### MeshUrlAdvertiser
Keeps each machine's reachable URL fresh in the machines registry. Tunnel URLs rotate (quick tunnels get a new hostname every restart), so peers would otherwise keep dialing a dead address; the advertiser publishes the current URL on a cadence and peers pick it up on their next presence pull. The reason "the Mini moved networks" doesn't mean "the Mini vanished."

### PeerEndpointRecorder
The single chokepoint that records a peer's *fast ropes* (Tailscale/LAN endpoints) into this machine's registry. On a git-less personal 2-machine setup the registry-sync git channel never runs, so each machine only ever learned the other's flaky Cloudflare URL — and the lease, forced onto that one rope, would false-flip `holdsLease` on a Cloudflare hiccup and freeze session revival. `PeerEndpointRecorder` closes that by carrying each machine's validated self-endpoints inside the already-signed lease RPC bodies (broadcast, pull request, and pull *response*) and recording them against the **authenticated** sender — never a self-asserted body field; the pull-response path records only after the responder identity is cryptographically verified. It is idempotent (skips an unchanged set), and absence is a no-op, never a wipe. Gated dark behind `multiMachine.meshTransport.enabled`; the resolver remains the dial-time authority.

### MeshEndpointValidator
The shared, defense-in-depth validator both `PeerEndpointRecorder` (ingest) and `PeerEndpointResolver` (dial-time) run an advertised endpoint set through before trusting it: per-kind host rules (Tailscale `100.64/10` CGNAT, LAN RFC-1918, Cloudflare public HTTPS) with loopback/link-local/metadata addresses rejected, a `MAX_ENDPOINTS` cap, a URL-length bound, and drop-element-and-log on any bad entry (fail-closed). Validation is hardening, not authority — a spoofed endpoint that slips a check still becomes a *failed rope* the resolver demotes, never a trusted one.

### LiveConfig
Watches `config.json` every 5 seconds for changes. When a value changes, it emits events so other systems can hot-reload without a server restart.

### SleepWakeDetector
Ticks every 2 seconds. If the gap between ticks exceeds 10 seconds, your machine slept. On wake, it fires an event that triggers: tunnel reconnection, Telegram re-polling, session health re-checks, and heartbeat resumption. Without this, opening your laptop would leave the agent looking online but actually broken.

### CaffeinateManager
macOS only. Runs `caffeinate -s` to prevent your Mac from sleeping while the agent is running. Monitors the process every 30 seconds and restarts it if it dies.

### ProcessIntegrity
Freezes the running version at startup and compares it to what's on disk. Detects when `npm install -g` updated the binary but the running process still has old code in memory.

### ForegroundRestartWatcher
When running without a supervisor, watches for restart signals (written by AutoUpdater after an update). Notifies you, waits 3 seconds for graceful shutdown, then exits so the process manager can restart with the new code.

### CredentialSwapExecutor
Ships **dark** (off + dry-run for everyone). The staged-exchange primitive of live credential re-pointing: it MOVES an account's OAuth credential between two config-home "slots" without restarting the sessions reading them (the `claude` client re-reads its store on the next API call). The `CredentialSwapExecutor` exchanges (never copies) the two slots' credentials through a crash-proof sequence — stage an escrow copy and journal `begin`, exchange keychain-first then config-second, verify each slot on its **account identity** via the profile-endpoint oracle, commit with the escrow retained, then re-verify ~90s later before deleting the escrow. It writes only what an oracle can identity-confirm: an unverifiable slot is quarantined, never repaired blindly. Going live requires a deliberate two-flag flip (`enabled:true` AND `dryRun:false`); see `docs/specs/live-credential-repointing-rebalancer.md` §2.3.

### CredentialAuditEmit
The single secret-scrub chokepoint for live credential re-pointing (spec §2.9). Every `logs/credential-swaps.jsonl` audit write, every `/credentials/*` HTTP response body, and every attention-item this feature constructs routes through one `CredentialAuditEmit.scrub(record)` funnel that deep-walks the record and redacts any token-shaped run (reusing `CredentialProvider.redactToken`). The no-token-material invariant is enforced **structurally**, not by "remember to scrub at each callsite": the real leak vector is developer-authored interpolation (a `${raw}`-bearing log line, a `security`/keychain stderr that carries a token fragment in free text), exactly what a single chokepoint neutralizes. The `/credentials/swap`, `/credentials/set-default`, and `/credentials/restore-enrollment` levers all send their responses through `CredentialAuditEmit` so no token byte can exit any surface.

</details>

---

## Messaging

**Reliable delivery with intelligent routing.** Messages don't get lost, and they go to the right session.

<details>
<summary>See the 5 messaging systems</summary>

### SessionSummarySentinel
Every 60 seconds, captures terminal output from each active session and generates a structured summary via Haiku. Uses hash-based change detection to skip sessions with no new output. These summaries enable intelligent message routing — when you send a message marked "send to best session," the system scores each session's relevance and picks the right one.

### SessionActivitySentinel
Every 30 minutes, creates condensed digests of what each session accomplished. Splits activity into meaningful chunks, summarizes each via LLM, and stores them in episodic memory. When a session completes, generates a full synthesis. This is how the agent builds long-term memory of what it's done.

### NotificationBatcher
Three tiers of notification urgency:
- **Immediate** — quota exhaustion, critical stalls (sent instantly)
- **Summary** — job completions, session lifecycle (batched every 30 minutes)
- **Digest** — routine system notices (batched every 2 hours)

Uses state-change-only deduplication: repeated identical notifications are suppressed until the content actually changes. Supports quiet hours (demotes Summary → Digest during configured times).

### DeliveryRetryManager
Three layers of retry for inter-agent messages:
- **Layer 1** — Server unreachable (exponential backoff, up to 4 hours)
- **Layer 2** — Session unavailable (30-second intervals, up to 5 minutes)
- **Layer 3** — ACK timeout (escalates unacknowledged messages)

Plus a post-injection watchdog: 10 seconds after delivering a message, checks if the session is still alive. If it crashed during injection, the message goes back to the retry queue.

### MessageStore
File-based message persistence. Atomic writes (temp file + rename for crash safety), deduplication, dead-letter archiving for failed messages (30-day retention), and JSONL indexes for fast queries.

</details>

---

## Agent Network

**Inter-agent communication.** Optional — only activates when Threadline is enabled.

<details>
<summary>See the agent network systems</summary>

### AgentDiscovery
5-second heartbeat. Announces this agent's presence in the shared registry, discovers other agents on the same machine.

### HandshakeManager
Ed25519 identity key management for end-to-end encrypted communication between agents.

### TrustManager
Maintains trust levels for known agents: untrusted → verified → trusted → autonomous. Determines what actions other agents can take.

### ThreadlineRouter
Routes messages between agents via the Threadline protocol. Handles trust verification, payload validation, and delivery.

### InboundMessageGate
Validates incoming relay messages against trust levels. Blocks oversized payloads (>64KB).

### Relay Client
WebSocket connection to the cloud relay for cross-machine agent communication.

### SecureInvitation
Ed25519-signed, single-use, recipient-bound invitation tokens used to bootstrap a Sealed Handoff. The invitation binds the submit host and TLS cert fingerprint inside the signed payload (endpoint pinning), so a sender validates the destination against the receiver's key rather than trusting whatever host it is handed — defeating a relay-swapped collector.

### SecretDrop
In-memory, one-time, never-on-disk store for collecting a credential from a user or peer agent. The submit URL is the auth; the secret value lives only in memory until consumed and is never written to disk or routed to Telegram. Supports optional sender-signature verification (an Ed25519 `_sig` over the canonical payload, checked before the request is consumed) so an intercepted URL cannot be poisoned by a first-POST-wins race. The receiver self-mints a request over a localhost-only loopback route, so no externalized bearer is needed.

### OperatorConfirmGate
Code-enforced requester-≠-authorizer gate for an agent-to-agent credential transfer: the agent requesting a secret cannot self-authorize. A relayed "operator said go" is not valid authorization — an operator-auth record scoped to the specific request, naming the holder, with requester ≠ authorizer and holder ≠ authorizer, must exist before the transfer is allowed.

### ThreadlineGroundingGate
"Ground Before You Assert" pre-send check for outbound agent-to-agent messages. Flags a scheme-qualified URL to a host the agent has not verified this session, so an unverified claim does not propagate to a peer as fact. Known/infra hosts and bare-host references are exempt; the gate is wired into `threadline_send` as a block-with-override.

### A2ACheckInPolicy
The decision core of the agent-to-agent coherence "check-in" (Layer 4): given whether a conversation is active, whether a salient event occurred, and how long since the operator last heard anything, it returns `salience` (something to surface), `heartbeat` (the silence-breaker — a periodic "still talking" while active and silent for the configured interval), or `none` (stay quiet — routine churn never surfaces). Pure and clock-injected.

### A2ACheckInSummarizer
Turns an ongoing agent-to-agent conversation into a short operator-facing check-in. It redacts credentials out of the peer content before the LLM ever sees it, frames that content as untrusted data to summarize (never instructions to follow), requires attribution ("X says…", never asserted as fact), and guards the generated summary so no URL, command, or credential-request can reach the operator's topic.

### A2ACheckInProxy
Orchestrates one check-in: decide → fetch history → summarize → guard → surface. It short-circuits before any LLM spend when there is nothing worth saying, and drops a summary that fails the output guard rather than surfacing it.

### A2ACheckInScheduler
Drives the Layer-4 cadence: on each tick it walks the active agent-to-agent threads and runs the check-in flow per thread. First-sight starts the silence clock (it never fires the instant a conversation becomes active), the heartbeat fires only after the full interval of subsequent silence, and the clock resets on any surface. Summaries run on the shared LLM queue's background lane; the scheduler is a no-op while the feature is disabled (it ships dark, off by default).

</details>

---

## Dashboard & Streaming

**Real-time visibility** into what your agent is doing.

<details>
<summary>See the 3 dashboard systems</summary>

### WebSocketManager
Manages dashboard connections. Handles authentication, client subscriptions, and message routing between the browser and the server.

### Terminal Stream
Captures terminal output from subscribed sessions every 500ms, computes diffs, and sends only changed content to connected dashboard clients. Efficient — no captures happen when nobody is watching.

### Session List Broadcast
Sends the running session list to all connected clients every 5 seconds. Includes session metadata, display names, and telemetry (tool usage, subagent activity).

</details>

---

## Housekeeping

**Keeps things clean.** Without these, logs grow forever and zombie processes accumulate.

<details>
<summary>See the 8 housekeeping systems</summary>

### OrphanProcessReaper
Every 60 seconds, detects orphaned Claude processes that aren't tracked by the session manager. Classifies them (managed vs orphaned vs external IDE processes), auto-kills orphans after 1 hour, and reports external processes to you.

### Reap notices & the mid-work resume queue
When a session is autonomously killed, `ReapNotifier` posts a plain-English notice into the topic that lost it (durably delivered by the always-on `ReapNoticeDrain` over the pending-relay store), and the kill chokepoint stamps killer-supplied `WorkEvidence` onto the reap event and reap-log. Sessions killed mid-work enter the durable `ResumeQueue`; `ResumeQueueDrainer` revives at most one per tick once the machine is calm and quota allows, re-validating reality before any spawn. See [Reap notices & the mid-work resume queue](/features/reap-notify-resume-queue/).

### JSONL Rotation
Lazy, size-based rotation built into all append-only log files. When a file exceeds 10MB, it keeps the newest 75% and atomically replaces the file. Non-fatal — rotation failure doesn't block writes.

### Session File Cleanup
Removes session state files for completed sessions (after 24 hours) and killed sessions (after 1 hour).

### Triage Evidence Cleanup
Every 6 hours, removes stale triage evidence files and cleans up abandoned triage sessions.

### Recovery Backup Cleanup
Every 6 hours, removes `.bak` files created during conversation JSONL truncation that are older than 24 hours.

### Dead-Letter Cleanup
Every 6 hours, removes failed messages from the dead-letter queue that are older than 30 days.

### Temp File Cleanup
On server startup, removes temporary Telegram files older than 7 days.

### Global Install Cleanup
On server startup, removes stale global instar installations.

</details>

---

## Lifecycle

**Handles the transitions** — starting up, shutting down, and everything in between.

<details>
<summary>See the 2 lifecycle systems</summary>

### SleepWakeDetector
Described in [Core Infrastructure](#core-infrastructure) — detects when your machine sleeps and triggers recovery on wake.

### Graceful Shutdown
Signal handlers (SIGTERM/SIGINT) that ensure clean shutdown: stops all polling, persists state, disconnects messaging, closes WebSocket connections, kills the caffeinate process, and unregisters from the agent registry.

</details>

---

## Platform Services

**The higher-level systems** that give the agent capabilities beyond just running code.

<details>
<summary>See the 9 platform services</summary>

### QuotaTracker
Monitors Claude API token usage in real-time. Sends Telegram warnings when approaching limits, enforces quotas to prevent runaway sessions, and can auto-switch between accounts if configured.

### CommitmentTracker
When you tell your agent to change a setting ("always use Haiku for jobs"), this system watches for config changes that revert your instruction and alerts you if it happens.

### EvolutionManager
The self-improvement loop. Detects gaps in the agent's capabilities, generates improvement proposals, and implements approved changes. Runs the full pipeline: gap detection → proposal → review → implementation.

### AgentRegistry Heartbeat
Every 30 seconds, writes a heartbeat to the global agent registry so other agents and tools can discover this agent.

### TopicResumeMap
Every 60 seconds, updates the mapping between Telegram topics and session UUIDs. When a session dies and respawns, this mapping ensures the new session can resume with full conversation context via `--resume`.

### CommitmentSentinel
Scans Telegram messages every 5 minutes to detect promises the agent made ("I'll deploy on Friday") that weren't formally registered.

### MemoryMonitor
Tracks heap memory usage. Triggers orphan cleanup when memory exceeds 80% of available capacity.

### WorktreeMonitor
Monitors git worktrees created for isolated agent work. Detects stale branches, reaps orphaned worktrees.

### HealthChecker
Legacy health probe system — superseded by SystemReviewer's more comprehensive tiered probe architecture.

</details>

---

## Subsystem class inventory

The sections above describe what each subsystem does at a behavioral level. The lists below enumerate every top-level class shipped under `src/<subsystem>/` so you can grep from a class name straight to its owning page. This is meant as a navigation aid — see the per-subsystem feature pages for actual descriptions.

### `src/core/` — agent fundamentals, gates, orchestration

`AccessControl`, `AdaptationValidator`, `AdaptiveTrust`, `AgentBus`, `AgentConnector`, `AgentRegistry`, `AgentWorktreeDetector`, `AuditTrail`, `AutoApprover`, `AutoDispatcher`, `AutoUpdater`, `AutonomousEvolution`, `AutonomyProfileManager`, `BackupManager`, `BitwardenProvider`, `BlockerLearningLoop`, `BranchManager`, `CaffeinateManager`, `CallbackRegistry`, `CanonicalState`, `CapabilityMapper`, `CapabilityRegistryGenerator`, `CircuitBreakingIntelligenceProvider`, `ClaudeCliIntelligenceProvider`, `CodexCliIntelligenceProvider`, `CoherenceGate`, `CoherenceJournal`, `CoherenceJournalReader`, `CoherenceReviewer`, `ResponseReviewDecisionLog`, `CommitmentSweeper`, `Config`, `ConflictNegotiator`, `ContextHierarchy`, `ContextSnapshotBuilder`, `ContextualEvaluator`, `ConvergenceChecker`, `CoordinationProtocol`, `CustomReviewerLoader`, `DecisionJournal`, `DeferredDispatchTracker`, `DiscoveryEvaluator`, `DispatchDecisionJournal`, `DispatchExecutor`, `DispatchManager`, `DispatchScopeEnforcer`, `DispatchVerifier`, `DriftSpendLedger`, `EvolutionManager`, `ExecutionJournal`, `ExternalOperationGate`, `FeatureDefinitions`, `FeatureRegistry`, `FeedbackManager`, `FileClassifier`, `ForegroundRestartWatcher`, `FrameworkSessionStore`, `GitStateManager`, `GitSync`, `GlobalInstallCleanup`, `GlobalSecretStore`, `HandoffManager`, `HeartbeatManager`, `IdentityRenderer`, `InitiativeTracker`, `InputGuard`, `InstarWorktreeManager`, `IntentDriftDetector`, `JargonDetector`, `JobReflector`, `LLMConflictResolver`, `LlmCircuitBreaker`, `LearnSkillBridge`, `LedgerAuth`, `LedgerParaphraseDetector`, `LedgerSessionRegistry`, `MachineHeartbeat`, `MachineIdentity`, `MessageSentinel`, `MessagingToneGate`, `MeteredSpendGate`, `MeteredSpendLedger`, `MigrationProvenance`, `MigratorStepEngine`, `ModelSwapService`, `MultiMachineCoordinator`, `NonceStore`, `OrgIntentManager`, `OutboundDedupGate`, `OverlapGuard`, `PairingProtocol`, `ParallelDevWiring`, `PatternAnalyzer`, `PlanDocParser`, `PlatformActivityRegistry`, `PolicyEnforcementLayer`, `PortRegistry`, `PostUpdateMigrator`, `PreCompactionFlush`, `Prerequisites`, `ProactiveSwapMonitor`, `ProcessIntegrity`, `ProjectAutoAdvancePoller`, `ProjectDigestCache`, `ProjectDriftChecker`, `ProjectDriftCheckerCache`, `ProjectMapper`, `ProjectRoundCompleteMessage`, `ProjectRoundExecution`, `ProjectRoundLock`, `ProjectRoundRunner`, `ProjectRoundWorktrees`, `PromptBuildRecall`, `PromptGuard`, `PinAttemptStore`, `RecipientResolver`, `ReflectionConsolidator`, `RenderedPlanStore`, `RoutingSpendCapsStore`, `RelationshipManager`, `RelevanceFilter`, `ResearchRateLimiter`, `ResumeValidator`, `SafeFsExecutor`, `SafeGitExecutor`, `SafeYaml`, `ScopeCoherenceTracker`, `ScopeVerifier`, `SecretManager`, `SecretMigrator`, `SecretRedactor`, `SecretStore`, `SecurityLog`, `SendGateway`, `SessionBuildContextStore`, `SessionMaintenanceRunner`, `SessionManager`, `SessionRefresh`, `SharedStateLedger`, `SleepWakeDetector`, `SoulManager`, `SourceTreeGuard`, `SpendAlertDispatcher`, `SpendAlertEmitters`, `SpendAlertResolver`, `StageTransitionValidator`, `StaleProcessGuard`, `StateManager`, `StateWriteAuthority`, `StopGateDb`, `StuckInputSentinel`, `SurfacingTemplates`, `SwapAntiThrashEngine`, `SwapLedger`, `SwapWorkGate`, `SyncOrchestrator`, `TemporalCoherenceChecker`, `TopicFrameworksStore`, `TopicLocalModelStore`, `TelegramSpendTopicChannel`, `TopicResumeMap`, `TrustElevationTracker`, `TrustRecovery`, `UnjustifiedStopGate`, `UpdateChecker`, `UpdateGate`, `UpgradeGuideProcessor`, `UpgradeNotifyManager`, `WorkLedger`, `WorktreeKeyVault`, `WorktreeManager`, `WriteAdmission`, `WriteDomainRegistry`.

### `src/monitoring/` — sentinels, watchdogs, observability

`AccountSwitcher`, `AttributionResolver`, `BurnAlertButtons`, `BurnAlertDelivery`, `BurnDetectionSubscriber`, `BurnDetector`, `BurnThrottleRunbook`, `BurnVerifier`, `CoherenceMonitor`, `CommitmentSentinel`, `CommitmentTracker`, `CompactionSentinel`, `CrashLoopPauser`, `CredentialProvider`, `DegradationReporter`, `ErrorCodeExtractor`, `FeedbackAnomalyDetector`, `FrameworkParitySentinel`, `HealthChecker`, `HelperWatchdog`, `HomeostasisMonitor`, `HookEventReceiver`, `InputClassifier`, `InstructionsVerifier`, `LlmQueue`, `LlmRateGate`, `MemoryPressureMonitor`, `NativeHealDegradationBridge`, `OrphanProcessReaper`, `PresenceProxy`, `PromiseBeacon`, `ProviderCostReportStore`, `ProviderReconciliationSweep`, `PromptGate`, `ProxyCoordinator`, `QuotaCollector`, `QuotaExhaustionDetector`, `QuotaManager`, `QuotaNotifier`, `QuotaTracker`, `Redactor`, `ReflectionMetrics`, `ReviewCanaryBattery`, `SessionActivitySentinel`, `SessionCredentialManager`, `SessionMigrator`, `SessionMonitor`, `SessionRecovery`, `SessionWatchdog`, `StallTriageNurse`, `SubagentTracker`, `SystemReviewer`, `TelemetryAuth`, `TelemetryCollector`, `TelemetryHeartbeat`, `TokenLedger`, `TokenLedgerPoller`, `TriageOrchestrator`, `WorktreeMonitor`, `WorktreeReaper`.

### `src/threadline/` — agent-to-agent protocol stack

`A2AGateway`, `AgentCard`, `AgentDiscovery`, `AgentTrustManager`, `ApprovalQueue`, `AuthorizationPolicy`, `AutonomyGate`, `BackfillCore`, `CircuitBreaker`, `ComputeMeter`, `ContentClassifier`, `ContextThreadMap`, `DNSVerifier`, `DigestCollector`, `DiscoveryWaterfall`, `HandshakeManager`, `HeartbeatWatchdog`, `HeartbeatWriter`, `InboundMessageGate`, `InvitationManager`, `ListenerSessionManager`, `MCPAuth`, `MessageSecurity`, `OpenClawBridge`, `OpenClawSkillManifest`, `PipeSessionSpawner`, `RateLimiter`, `RelayGroundingPreamble`, `RelaySpawnFailureHandler`, `SalienceGate`, `SecureInvitation`, `SessionLifecycle`, `SpawnLedger`, `SpawnNonce`, `TelegramBridge`, `TelegramBridgeConfig`, `ThreadResumeMap`, `ThreadlineBootstrap`, `ThreadlineCrypto`, `ThreadlineEndpoints`, `ThreadlineMCPServer`, `ThreadlineNicknames`, `ThreadlineObservability`, `ThreadlineRouter`, `TopicLinkageHandler`, `TrustAuditLog`, `TrustBootstrap`, `TrustEvaluator`, `UnifiedTrustWiring`, `WakeSocketServer`.

### `src/memory/` — conversational + semantic memory

`ActivityPartitioner`, `Chunker`, `EmbeddingProvider`, `EpisodicMemory`, `EvidenceRenderer`, `MemoryExporter`, `MemoryIndex`, `MemoryMigrator`, `NativeModuleHealer`, `SemanticMemory`, `TopicMemory`, `TopicSummarizer`, `VectorSearch`, `WorkingMemoryAssembler`.

### `src/messaging/` — channel adapters and routing

`AdapterRegistry`, `AgentTokenManager`, `DeliveryRetryManager`, `DropPickup`, `GitSyncTransport`, `MessageDelivery`, `MessageFormatter`, `MessageRouter`, `MessageStore`, `NotificationBatcher`, `SessionSummarySentinel`, `SpawnRequestManager`, `TelegramAdapter`, `TelegramMarkdownFormatter`, `TopicContentValidator`, `WhatsAppAdapter`.

### `src/scheduler/` — cron + agentmd job execution

`AgentMdAtomicSave`, `AgentMdJobLoader`, `AgentMdLockFile`, `AgentMdReconcile`, `DisabledBodyDrift`, `InstallBuiltinJobs`, `IntegrationGate`, `JobClaimManager`, `JobLeaseCutoverGate`, `JobLeaseClaimStore`, `JobLoader`, `JobRunHistory`, `JobScheduler`, `MigrationInvariants`, `MigrationLedger`, `SkipLedger`.

`JobRunHistory` applies the shared `CapacityEnforcement` contract before each JSONL append. Rows within budget are written unchanged; oversized optional detail is condensed and recorded as a durable `truncated` outcome; a row whose essential fields still cannot fit is refused and reported as an invariant failure. This keeps expected bounded-storage behavior observable without misclassifying successful condensation as a service degradation.

**WS4.3 journal-lease cutover.** On a multi-machine pool, scheduled-job claims start on the best-effort AgentBus broadcast (`JobClaimManager`) and upgrade to a durable, epoch-fenced lease over the replicated journal (`JobLeaseClaimStore`) — but only when the `JobLeaseCutoverGate` confirms every online peer advertises the `ws43JournalLease` capability (invariant-5 flag coherence). The gate is the single decision point that guarantees the two claim mechanisms are never both live for the same job set (the named migration hazard); a mixed or single-machine pool stays on the legacy bus path, byte-for-byte today's behavior. Ships dark behind `multiMachine.seamlessness.ws43JournalLease` (dry-run first).

### `src/identity/` — machine + agent cryptographic identity

`IdentityManager`, `KeyEncryption`, `KeyRevocation`, `KeyRotation`, `Migration`, `RecoveryPhrase`.

### `src/lifeline/` — persistent supervisor

`LifelineHealthWatchdog`, `MessageQueue`, `RestartOrchestrator`, `ServerSupervisor`, `SlackLifeline`, `TelegramLifeline`.

### `src/knowledge/` — self-knowledge tree

`CoverageAuditor`, `IntegrityManager`, `KnowledgeManager`, `ProbeRegistry`, `SelfKnowledgeTree`, `TreeGenerator`, `TreeSynthesis`, `TreeTraversal`, `TreeTriage`.

### `src/users/` — multi-user identity + GDPR

`GdprCommands`, `OnboardingGate`, `UserContextBuilder`, `UserManager`, `UserOnboarding`, `UserPropagator`.

### `src/remediation/` — Self-Healing Remediator v2

`IntentJournal`, `MachineLock`, `NovelFailureReviewer`, `PrimaryAggregatorLease`, `Remediator`, `RemediatorBootstrap`, `RemediationContext`, `RemediationKeyVault`, `TrustElevationSource`.

### `src/tasks/` — durable task flow registry

`DivergenceChecker`, `LruCache`, `RateLimiter`, `TaskFlowDueWaker`, `TaskFlowMaintenanceSweeper`, `TaskFlowRegistry`, `ThreadlineFlowBridge`.

### `src/paste/` — paste content lifecycle

`PasteManager`, `TruncationDetector`.

### `src/privacy/` — sensitive-response routing

`OutputPrivacyRouter`.

### `src/moltbridge/` — agent profile + trust network

`MoltBridgeClient`, `ProfileCompiler`.

### `src/security/` — cryptographic primitives

`SecretRedactor`.

### `src/tunnel/` — Cloudflare tunnel management

`TunnelManager`.

### `src/providers/` — cross-framework intelligence routing

`AnthropicIntelligenceProvider`, `CostAwareRoutingPolicy`, `LocalModelAdapter`, `ProviderRegistry`, `StallTriageNurse` (provider-side fork), `TierResolver`.

## Subscription & Auth (multi-account quota pool)

The Subscription & Auth Standard lets one agent draw on several Claude (or other
provider) subscriptions at once, draining each before its quota resets and never
letting a long-lived session die on a quota limit.

- **`SubscriptionPool`** (`src/core/SubscriptionPool.ts`) — the durable account
  registry. Each entry records an account's login *location* (its
  `CLAUDE_CONFIG_DIR` config home), provider, framework, and last quota snapshot.
  It stores **login location, never tokens** — a structural credential-field guard
  rejects any attempt to persist a secret into the registry.
- **`QuotaPoller`** (`src/core/QuotaPoller.ts`) — the background poller that reads
  each account's live utilization + reset windows (hybrid read: Claude Code's
  `/usage` by default, the `/api/oauth/usage` endpoint as a bounded fallback),
  derives a *measured burn rate* (not a call count), and keeps idle-but-likely-next
  accounts warm.
- **`QuotaAwareScheduler`** (`src/core/QuotaAwareScheduler.ts`) — reset-date-optimal
  account selection (score = unused headroom × reset urgency) plus the **hard
  continuity guarantee**: when a session hits its account's quota, the scheduler
  picks an alternate account and resumes the *same conversation* there via
  `SessionRefresh` (which threads an account-swap option into the respawn so the
  new process launches under the alternate account's `CLAUDE_CONFIG_DIR`). Because
  `claude --resume` is account-agnostic, the conversation is preserved across the
  swap. If no alternate is eligible it raises a single deduped HIGH attention item
  rather than letting the session die silently.

Enrollment (P2.1) — adding a new account from a phone, expiry-proof:

- **`PendingLoginStore`** (`src/core/PendingLoginStore.ts`) — a durable ledger of
  logins-in-progress. Each record holds PUBLIC artifacts only (verification URL,
  optional device code, flow kind, TTL, re-issue count, the target config home as a
  path) — there is no field to hold a token, the same credential-safety-by-
  construction guard the account registry uses. Persists to disk, so an in-flight
  login survives a server restart.
- **`EnrollmentWizard`** (`src/core/EnrollmentWizard.ts`) — orchestration on top of
  the store: start a login (drive the framework's flow via an injected
  `LoginDriver`, capture the public code/URL, store it with its TTL visible), and a
  sweep that auto-reissues any EXPIRED login without the operator asking — the gap
  the pi-harness live-test exposed. A failed re-drive is skipped + retried next
  sweep. Per-provider default flow kind: Codex/OpenAI = device-code, everyone else
  = url-code-paste (the phone-friendly Claude path).
- **`FrameworkLoginDriver`** (`src/core/FrameworkLoginDriver.ts`) — the concrete
  `LoginDriver`: spawns the framework's own login command under the new account's
  `CLAUDE_CONFIG_DIR` (reusing the proven tmux-spawn + capture-pane primitive) and
  scrapes the public verification URL + device code + TTL from the pane. The scrape
  logic is pure and unit-tested against real captured-output fixtures.

Spec: `docs/specs/_drafts/subscription-auth-standard-master-spec.md`.

## Inter-agent comms (agent-to-agent Telegram primitive)

- **`AgentTelegramComms`** (`src/messaging/AgentTelegramComms.ts`) — the agent-to-agent
  Telegram comms primitive's pure logic: marker parse/format, the recipient routing
  matrix (incl. user-spoof defense + per-source role acceptance), and cycle-detection.
- **`AgentTelegramLedger`** (`src/messaging/AgentTelegramLedger.ts`) — append-only JSONL
  audit trail of every a2a send and every receive decision (routed or dropped, with the
  reason code). Best-effort + non-throwing.
- **`ProcessedIdStore`** (`src/messaging/ProcessedIdStore.ts`) — bounded persistent set
  of recently-processed marker ids; idempotency against Telegram retry / adapter restart.

Spec: `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2a.

## Cross-machine memory foundation

- **`HybridLogicalClock`** (`src/core/HybridLogicalClock.ts`) — the total-order clock the
  cross-machine memory-replication family is built on. Each replicated change carries a
  `{ physical, logical, node }` stamp; the canonical HLC merge keeps cause before effect,
  `compare()` is a strict total order (machine id breaks ties) so every machine sorts the
  same history identically, it is monotonic across restarts (atomic persistence), and it
  rejects a poison far-future stamp measured against the *pool's* reference (not the local
  clock, so a slow machine never wrongly quarantines a legitimately-ahead peer). Pure +
  dependency-injected; ships inert until the replicated-store steps consume it. Spec:
  `docs/specs/multi-machine-replicated-store-foundation.md` §3.
- **`ReplicatedRecordEnvelope`** (`src/core/ReplicatedRecordEnvelope.ts`) — the generic
  substrate every replicated store (preferences, relationships, learnings, …) layers a
  journal kind onto. It defines the **replicated-record envelope** — the fields each
  replicated change carries on top of its store-specific data: `recordKey` (primary key),
  `hlc` (the `HybridLogicalClock` stamp at author time), `op` (`put`/`delete`), `origin`
  (the author machine), and `observed` (the single HLC the author had already merged for
  that key — the last-writer-witness; absent means "no prior witness" so a conflict is
  flagged, the safe direction). A strict, parameterizable validator mirrors the coherence
  journal's typed-schema discipline (rejects free text, drops + counts unknown fields, jails
  any path-shaped field). A `ReplicatedKindRegistry` lets each store register its kind
  independently (it ships empty — the first concrete kind lands with the preferences pool),
  and the emission gate is **flag-gated** (a store emits only when its
  `multiMachine.stateSync.<store>.enabled` is on, default off) **and flag-coherence-gated**
  (a kind is forwarded to a peer only when that peer advertises it can receive it — so a new
  kind is never silently dropped by an older peer, the named skew-failure mode). A boot-time
  pool-flag-coherence check surfaces a mixed-flag pool once, coalesced across all peers.
  Pure mechanism, dark by default; a single-machine install is a strict no-op. Spec:
  `docs/specs/multi-machine-replicated-store-foundation.md` §4 / §10.
- **`StoreSnapshot`** (`src/core/StoreSnapshot.ts`) — the **snapshot-then-tail** join/recover
  path so a returning / compacted / long-dark machine never replays a peer's journal from
  genesis. `materializeSnapshot()` builds a **single-origin** snapshot — a peer serves ONLY
  the records it authored (`origin === serving machine`, the first-hop anti-forgery invariant
  enforced at materialization: a cross-origin entry is dropped, never landed). The snapshot
  carries a per-`(origin, kind)` seq-watermark **vector** (not a scalar), computed from which
  entries actually materialized so it cannot lie; `applySnapshotCutover()` seeds
  `PeerMeta.lastHeldSeq = snapshotSeq` and then tails via the UNCHANGED `buildServeBatch` seq
  transport, so the no-gap / no-double-apply guarantee is inherited from the existing
  seq-contiguity (HLC is demoted to a secondary dedup hint). A deleted-keys high-water seed
  blocks delete-resurrection across tombstone GC. `StoreSnapshotEngine` runs the build **off
  the event loop** in `storeSnapshotBuild.worker.ts` (the instar#1069 worker discipline,
  mirroring `CartographerSweepEngine`); `SnapshotCache` is a fixed-ceiling LRU ring
  (`maxCachedSnapshots` + `maxCacheBytes`, NOT pool-scaled) with a `cacheLossCounter`, and
  `SnapshotRebuildBreaker` bounds rebuild storms from a flapping peer. The pull rides the
  authenticated mesh RPC as a `state-snapshot` read/observe verb (Phase-C: no LAN broadcast).
  Pure mechanism, dark by default; a single-machine install is a strict no-op. Spec:
  `docs/specs/multi-machine-replicated-store-foundation.md` §6 / §8.2.
- **`RelationshipsReplicatedStore`** (`src/core/RelationshipsReplicatedStore.ts`) — the SECOND
  concrete consumer of the replicated-store foundation and the FIRST **PII kind**:
  `relationship-record`. `RelationshipsReplicatedStore` layers the kind onto the generic
  envelope with PII-specific hardening the security spec demands. Its schema is a
  **discriminated union on `op`** — an `op:'put'` VALUE schema and an `op:'delete'` TOMBSTONE
  schema coexist under one kind — and it **type-clamps every known field on receive**
  (`firstInteraction`/`lastInteraction` validate as ISO-8601-only, `interactionCount`/
  `significance` as finite numbers, free text length-clamped) so a foreign, attacker-controlled
  record can never smuggle markup through a render slot that bypasses `sanitize()`. The
  replicated projection is **disclosure-minimized** (only resolution + merge-relevant fields,
  NEVER the raw on-disk blob and NEVER the local UUID `id`), and the cross-machine `recordKey`
  is derived deterministically from a person's sorted **channel set** (the identity surface the
  manager already collides on), so the same human reaches the same record across machines even
  though each machine mints its own UUID. A delete propagates as a channel-keyed tombstone (so
  an erased person stays erased on an offline-then-rejoining peer), and a foreign record is
  rendered inside a `<replicated-untrusted-data origin="…">` envelope — quoted data, never an
  instruction, never the authoritative answer to "who is messaging me". Per-entry cap raised to
  64KB so a fat relationship replicates instead of wedging the stream; HIGH-impact
  (append-both-and-flag, never a silent clobber of two divergent people). Pure mechanism, dark
  by default behind `multiMachine.stateSync.relationships`; a single-machine install is a strict
  no-op. Spec: `docs/specs/ws23-relationships-userregistry-security.md`.
- **`LearningsReplicatedStore`** (`src/core/LearningsReplicatedStore.ts`) — the THIRD
  concrete consumer of the replicated-store foundation and the SECOND **memory-family kind**:
  `learning-record`. `LearningsReplicatedStore` layers the kind onto the generic envelope so a
  lesson the agent learned on machine A is known on machine B — ONE learning registry, not
  one-per-machine. It REUSES the WS2.3 PII machinery rather than downgrading it: a discriminated
  union on `op` (an `op:'put'` VALUE schema and an `op:'delete'` TOMBSTONE schema), a strict
  **type-clamp on receive** (`source.discoveredAt` validates as ISO-8601-only, `applied` as a
  strict boolean, `tags[]`/`description` length-clamped) so a foreign, attacker-controlled record
  can never smuggle markup through a render slot. The replicated projection is
  **disclosure-minimized** (only the merge-relevant fields, NEVER the raw on-disk blob and NEVER
  the local sequential `LRN-NNN` id), and the cross-machine `recordKey` is a **content
  fingerprint** — `sha256(normalize(title) + normalize(category) + (source.contentId ||
  source.discoveredAt))` — so the SAME lesson learned on two machines collapses to ONE record
  instead of duplicating (the LRN-id is the cross-machine-unstable id, exactly the
  relationship-UUID trap solved with a stable identity surface). A removal/prune propagates as a
  channel-keyed tombstone (CRITICAL: the EvolutionManager prune-over-`maxLearnings` path emits a
  tombstone per pruned learning, else a peer re-replicates it forever — resurrection), and a
  foreign record renders inside a `<replicated-untrusted-data origin="…">` envelope — quoted
  advisory data, never an instruction. Per-entry cap raised to 64KB so a fat learning replicates;
  HIGH-impact at the **replication** layer (append-both-and-flag) but **advisory** at the **read**
  layer (both variants of an open conflict surface as guidance hints — a learning is guidance,
  not authority — the read never blocks). Pure mechanism, dark by default behind
  `multiMachine.stateSync.learnings`; a single-machine install is a strict no-op. The
  `LearningsReplicatedStore` projection strips the local id by construction. Spec:
  `docs/specs/multi-machine-replicated-store-foundation.md` §4 / §7.
- **`KnowledgeReplicatedStore`** (`src/core/KnowledgeReplicatedStore.ts`) — the FOURTH
  concrete consumer of the replicated-store foundation and the THIRD **memory-family kind**:
  `knowledge-record`. `KnowledgeReplicatedStore` layers the kind onto the generic envelope so a
  knowledge SOURCE the agent ingested on machine A is known on machine B — ONE knowledge catalog,
  not one-per-machine. It REUSES the WS2.2/WS2.3 PII machinery rather than downgrading it: a
  discriminated union on `op` (an `op:'put'` VALUE schema and an `op:'delete'` TOMBSTONE schema),
  a strict **type-clamp on receive** (`ingestedAt` validates as ISO-8601-only, `type` against the
  {article, transcript, doc} enum, `wordCount` as a finite number, `tags[]`/`summary` length-clamped,
  a path-shaped `url` jailed out) so a foreign, attacker-controlled record can never smuggle markup
  through a render slot. The replicated projection is **disclosure-minimized + metadata-only**: only
  the catalog metadata (title, url, type, tags, summary, word count) crosses the wire — NEVER the
  markdown file BODY (the `filePath` file can be a huge transcript; full-content sync is a tracked
  follow-up), NEVER the local generated `id`, and NEVER the local `filePath`. The cross-machine
  `recordKey` is a **content fingerprint** — `sha256(normalize(url || title) + normalize(type))` —
  so the SAME article ingested on two machines collapses to ONE record instead of duplicating (the
  generated id is the cross-machine-unstable id, exactly the relationship-UUID / LRN-id trap solved
  with a stable identity surface). A removal propagates as a fingerprint-keyed tombstone (CRITICAL:
  the `KnowledgeManager.remove()` path emits a tombstone per removed source, else a peer
  re-replicates it forever — resurrection), and a foreign record renders inside a
  `<replicated-untrusted-data origin="…">` envelope — quoted advisory reference, never an
  instruction. Per-entry cap raised to 64KB so a fat summary replicates; HIGH-impact at the
  **replication** layer (append-both-and-flag) but **advisory** at the **read** layer (both variants
  of an open conflict surface as guidance hints — a knowledge source is reference, not authority —
  the read never blocks). Pure mechanism, dark by default behind `multiMachine.stateSync.knowledge`;
  a single-machine install is a strict no-op. The `KnowledgeReplicatedStore` projection strips the
  local id + filePath by construction. Spec:
  `docs/specs/multi-machine-replicated-store-foundation.md` §4 / §7.
- **`EvolutionActionsReplicatedStore`** (`src/core/EvolutionActionsReplicatedStore.ts`) — the FIFTH
  concrete consumer of the replicated-store foundation and the FOURTH **memory-family kind**:
  `evolution-action-record`. `EvolutionActionsReplicatedStore` layers the kind onto the generic
  envelope so a self-improvement ACTION the agent raised on machine A (the EvolutionManager action
  queue — `ActionItem`) is known on machine B — ONE action queue, not one-per-machine. It REUSES the
  WS2.4/WS2.2 machinery rather than downgrading it: a discriminated union on `op` (an `op:'put'` VALUE
  schema and an `op:'delete'` TOMBSTONE schema), a strict **type-clamp on receive**
  (`createdAt`/`dueBy`/`completedAt` validate as ISO-8601-or-absent, `priority` against the
  {critical, high, medium, low} enum, `status` against the {pending, in_progress, completed, cancelled}
  enum, `tags[]`/free text length-clamped, a path-shaped `source` sub-field jailed out) so a foreign,
  attacker-controlled record can never smuggle markup through a render slot. The replicated projection
  is **disclosure-minimized**: the local `ACT-NNN` id is NEVER replicated. The cross-machine `recordKey`
  is a **content fingerprint** — `sha256(normalize(title) + normalize(commitTo) + createdAt)` — so the
  SAME committed action on two machines collapses to ONE record instead of duplicating (the ACT id is
  the cross-machine-unstable id, exactly the relationship-UUID / LRN-id trap solved with a stable
  identity surface). **`status` is the load-bearing cross-machine field**: a status change RE-EMITS a
  put so a peer SEES that an action was already completed/in_progress elsewhere and does not redo the
  work; `status`/`priority`/`completedAt` are mutable (last-writer-witness wins; a concurrent
  divergence — one machine completed, another in_progress — rides the SAME append-both-and-flag path,
  no CRDT special-case). A `completed`/`cancelled` action is a TERMINAL state whose record is RETAINED
  (history), NOT tombstoned — only an actual queue-REMOVAL (the prune-over-maxActions path) emits a
  fingerprint-keyed tombstone (the resurrection guard); a foreign record renders inside a
  `<replicated-untrusted-data origin="…">` envelope — quoted advisory work-item, never an instruction.
  Per-entry cap raised to 64KB so a fat action description replicates; HIGH-impact at the
  **replication** layer (append-both-and-flag) but **advisory** at the **read** layer (both variants of
  an open conflict surface as guidance hints — an action is a work item to surface, not authority — the
  read never blocks). Pure mechanism, dark by default behind `multiMachine.stateSync.evolutionActions`;
  a single-machine install is a strict no-op. The `EvolutionActionsReplicatedStore` projection strips
  the local ACT id by construction. Spec:
  `docs/specs/multi-machine-replicated-store-foundation.md` §4 / §7.

- **`UserRegistryReplicatedStore`** (`src/core/UserRegistryReplicatedStore.ts`) — the SIXTH
  concrete consumer of the replicated-store foundation and the SECOND **PII kind** (after WS2.3
  relationships): `user-record`. `UserRegistryReplicatedStore` layers the kind onto the generic
  envelope so a registered USER the agent knows on machine A (the UserManager registry —
  `UserProfile`) is known on machine B — ONE user registry, not one-per-machine. It REUSES the
  WS2.3 PII machinery rather than downgrading it: a discriminated union on `op` (an `op:'put'`
  VALUE schema and an `op:'delete'` TOMBSTONE schema), a strict **type-clamp on receive**
  (`createdAt` validates as ISO-8601, `telegramUserId` as a finite number, `channels[]`/
  `permissions[]`/free text length-clamped, a path-shaped channel `type` jailed out) so a foreign,
  attacker-controlled record can never smuggle markup through a render slot. The replicated
  projection is **disclosure-minimized**: the local `userId` is NEVER replicated. The cross-machine
  `recordKey` is the **channel set** — `sha256(sorted("type:identifier" pairs))`, mirroring
  `UserManager.channelIndex` — so the SAME user on two machines collapses to ONE record instead of
  duplicating (the local id is the cross-machine-unstable id, exactly the relationship-UUID trap
  solved with a stable identity surface). HIGH-impact at the **replication** layer
  (append-both-and-flag — auto-merging two divergent profiles could fuse two distinct humans) but
  **advisory** at the **read** layer: a replicated user record is a HINT about what the agent's
  OTHER machines know, NEVER the authoritative answer to "who is this inbound sender?" — identity
  RESOLUTION of an inbound principal is LOCAL-ONLY (the local channel index always wins). A removed
  user emits a channel-keyed tombstone (resurrection guard); a foreign record renders inside a
  `<replicated-untrusted-data origin="…">` envelope. Per-entry cap raised to 64KB; the
  `UserManager.persistUsers`/`removeUser` funnels carry the emit seam. Pure mechanism, dark by
  default behind `multiMachine.stateSync.userRegistry`; a single-machine install is a strict no-op.
  Spec: `docs/specs/multi-machine-replicated-store-foundation.md` §4 / §7,
  `docs/specs/ws23-relationships-userregistry-security.md`.

- **`TopicOperatorReplicatedStore`** (`src/core/TopicOperatorReplicatedStore.ts`) — the SEVENTH
  concrete consumer of the replicated-store foundation and the THIRD **PII kind**, completing the
  WS2 memory family: `topic-operator-record`. `TopicOperatorReplicatedStore` layers the kind onto
  the generic envelope so the VERIFIED operator a topic was bound to on machine A (the
  `TopicOperatorStore` binding — `TopicOperator`) is VISIBLE as advisory context on machine B. **THE
  LOAD-BEARING SAFETY INVARIANT** (the whole point of this kind — Know Your Principal): a replicated
  topic-operator record is UNTRUSTED peer data — it can NEVER become this machine's authoritative
  answer to "who is my verified operator?". The LOCAL auth-derived binding
  (`TopicOperatorStore.setOperator` from an AUTHENTICATED sender) is ALWAYS authoritative; the
  replicated record is advisory context only, rendered as quoted untrusted data that EXPLICITLY says
  so, and there is NO apply path back into `TopicOperatorStore` by construction. It rides the same
  hardened machinery: a discriminated union on `op`, a strict **type-clamp on receive** (`boundAt`
  ISO-8601-or-absent, `platform`/`uid` short slugs jailed, `names[]` length-bounded), a
  **disclosure-minimized** projection of exactly `{platform, uid, names, boundAt}`. The cross-machine
  `recordKey` is `sha256(topicId + ":" + verified-uid)` — keyed on the topic + the AUTHENTICATED uid,
  NEVER a content-name (a name in a message body can never become part of the identity surface). An
  unbind emits a tombstone; HIGH-impact at the **replication** layer (append-both-and-flag) but
  **advisory** at the **read** layer (a replicated operator record is a hint, never the authoritative
  principal). Per-entry cap raised to 64KB; the `TopicOperatorStore.setOperator` funnel carries the
  emit seam (emit the LOCAL binding to peers; never receive one). Pure mechanism, dark by default
  behind `multiMachine.stateSync.topicOperator`; a single-machine install is a strict no-op. With
  `UserRegistryReplicatedStore`, the WS2 memory family is COMPLETE (7 kinds; playbook deferred).
  Spec: `docs/specs/multi-machine-replicated-store-foundation.md` §4 / §7,
  `docs/specs/ws23-relationships-userregistry-security.md`.

## Live Credential Re-pointing (Subscription & Auth Standard)

The machinery that can move a pool account's OAuth credential between config-home "slots" without
restarting the sessions reading them — the "stock-trader" rebalancer. Ships dark/dry-run-first (live on
a development agent in dry-run, dark on the fleet); a real credential write needs a deliberate
`dryRun:false`. Spec: `docs/specs/live-credential-repointing-rebalancer.md`.

### CredentialRebalancerPolicy

The pure §2.4 decision core: `decidePass(snapshot)` computes the zero-or-more credential swaps for one
balancer pass from a read-only snapshot (per-account quota + reset proximity, per-slot tenancy/verify/
activity, cooldown state, resolved config). Objective-0 dead/quarantined-default eviction + the
correlated-oracle-outage floor; objective-1 wall avoidance + the bounded wall-override (fresh-data gate,
`maxForcedSwapsPerPass`, per-window override budget, recency gate); objective-2 use-it-or-lose-it drain
(weekly-only, headroom floor, per-slot drain-in-progress hold); eligibility + hysteresis (per-pair +
per-tenant cooldowns on the account basis, urgency-clamped min-improvement floor, 1 swap/pass). No IO,
no authority — it decides; the actuator routes an accepted decision through the gated executor.

### CredentialRebalancer

The stateful orchestrator that wraps `decidePass()` in a pass loop: on each `tick()` it builds the
read-only snapshot from injected providers, asks the policy for the swaps, and actuates each through the
injected `CredentialSwapExecutor` wrapper — but ONLY under the feature's dark/dry-run gate (dark = a
strict no-op; dry-run actuates the decision but the executor writes nothing). Carries the cross-pass
hysteresis the pure policy cannot (cooldown timestamps) and the §2.4 P19 breaker (N consecutive LIVE
failed swaps opens it; a success resets it; it self-heals by re-probing).

### CredentialRebalancerSnapshot

The pure mappers translating the live system state into the policy's snapshot: `mapAccount` (a
SubscriptionPool account → `AccountState`; a missing quota reading maps to an epoch `measuredAt` so the
account is treated as stale/source-only; `rate-limited` stays eligible so wall-avoidance can rescue its
slot), `mapSlot` (a CredentialLocationLedger assignment → `SlotState`), and `resolveRebalancerConfig`
(clamp the configured knobs + derive the cooldowns from the poll interval). Kept pure so a units/sign
bug that would mis-steer the balancer is unit-testable.

### CredentialRepointingLivetest

The §5 livetest battery as testable orchestration — the dry-run→live PROMOTION gate (NOT part of merge
CI; runs only when the operator arms it at enablement, since it exchanges REAL credentials between REAL
accounts). Drives the automatable round-trips (identity-verified exchange-then-restore via the oracle,
always restoring) and surfaces the inherently-manual items (refresher correctness, the §0.c at-expiry
residual via a disposable grant, liveness) without ever auto-passing them. An `armed` guard performs
zero swaps unless explicitly armed, so importing or unit-testing the module can never move a credential.

### POST /credentials/livetest (the promotion gate)

`POST /credentials/livetest` is the reachable entrypoint for the §5 livetest battery (the
`CredentialRepointingLivetest` harness) — the dry-run→live PROMOTION gate. It wires the harness to
the real swap executor + identity oracle and runs the automatable round-trips. Two independent
gates protect it: the harness performs ZERO swaps unless `armed:true` is in the request body (the
operator explicitly arms the battery), and even armed the executor's own `dryRun` keeps writes off
until a deliberate `dryRun:false`. Dark → 503; every named slot is validated against the enumerated
ledger set (→ 400) before the harness runs. The report is scrubbed and carries no token material.
