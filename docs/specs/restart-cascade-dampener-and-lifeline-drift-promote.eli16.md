# Restart Cascade Dampener + Lifeline Drift Auto-Promote — Plain-English Overview

> The one-line version: stop hitting the user with two server restarts back-to-back when two updates arrive close together, and let the lifeline catch itself up when it falls too far behind without asking for a manual kick.

## The problem in one breath

Last night Luna (the Sagemind agent) restarted twice in 30 minutes — once for v1.2.34, then again for v1.2.36 — while Justin was in the middle of asking her a question. The second restart cycle is what made her look "unresponsive" for 15+ minutes. Separately, her background watcher (the lifeline) was running with code 30 patches older than the rest of her, but the system only ever said "consider manual kick" and then waited for a human to do it. This change makes both of those self-healing.

## What already exists

- **The AutoUpdater** — checks for updates every 30 minutes, downloads them, and triggers a server restart by writing a flag file the supervisor picks up. Already has a "don't restart twice for the SAME version inside 30 minutes" cooldown to protect against loops.
- **The Lifeline** — a tiny always-running process that keeps the Telegram connection alive and supervises the main server. It can self-restart, but only when its built-in watchdog ticks (stuck forwards, queue stalls) decide to.
- **The Version Handshake** — every Telegram message the lifeline forwards to the server carries the lifeline's version. The server compares against its own version. Same MAJOR/MINOR + small drift = accept silently. Big drift = "accept-with-patch-info" — currently a degradation report ("consider manual kick") that nobody reads.
- **The RestartOrchestrator** — the single chokepoint for the lifeline's `process.exit` call. Handles quiesce + persist + exit cleanly. Used by the watchdog and the SIGTERM handler.
- **ConfigDefaults** — one file that holds default settings for every agent. Adding something here automatically applies to BOTH new agents (via `init`) AND existing agents (via the update migrator).

## What this adds

Two small, focused self-heal modules and one tiny wire between the server and the lifeline.

The first is a **restart cascade dampener** that sits in front of the AutoUpdater's existing restart logic. When a new update wants to restart the server but the previous restart was less than 15 minutes ago, instead of firing immediately it BATCHES: schedules a single deferred restart at "previous restart + 15 minutes" and remembers the latest version queued. If a third update arrives during the batch window, it joins the same batch (the highest version wins). The user sees ONE notification saying "Update v1.2.36 queued — rolling into the pending restart at 17:23" instead of two restart cycles.

The second is a **lifeline drift auto-promoter**. The server now adds a small header to its forward responses that says "your lifeline is N patches behind me." When the lifeline sees that header and N is above 20, it waits for a quiet moment (no in-flight messages, no queued work, no recent traffic) and then restarts itself through the existing orchestrator. The next time it boots, it sends ONE message: "Lifeline self-restarted: was 30 patches behind, now in sync. No action needed."

## The new pieces

- **`RestartCascadeDampener`** — a stateless decision class. Given the previous restart time and a window, returns either `proceed` (no batching needed) or `batch` (with an "eligible at" timestamp). Knows the time math; knows nothing about timers, file flags, or Telegram. The AutoUpdater is the one that turns a `batch` decision into a `setTimeout` and a user notification.
- **`LifelineDriftPromoter`** — a sentinel that owns its own lifecycle: idle → pending (after first qualifying drift signal) → fired (terminal, after restart request). Idempotent under concurrent ticks. Tolerates exceptions from the clean-window predicate (treats them as "not clean"). Has a 60-minute hard deadline so it doesn't defer forever.
- **`X-Instar-Lifeline-Patch-Drift` response header** — added to `/internal/telegram-forward` responses when the handshake decides "accept with patch info." Plain integer. The signal; not the authority.
- **`state/lifeline-drift-restart-pending.json`** — a one-shot marker written before the drift-triggered exit. The next lifeline boot reads it, sends the user notice, and deletes it.

## The safeguards

**Prevents over-blocking.** The cascade dampener only kicks in for DIFFERENT versions within the window. The same-version 30-min cooldown still runs first, so loop-prevention behavior is unchanged. `bypassWindow=true` (manual `/updates/apply` requested by the user) skips the dampener entirely — if the user explicitly asks to restart, they get a restart immediately. `windowMs: 0` disables the dampener fully. Crash and health-fail restarts are not touched.

**Prevents under-blocking.** The dampener decision class is stateless and consults only the persisted `lastRestartRequestedAt` field, which survives process restarts via the existing `state/auto-updater.json` file. So the gate works the FIRST time after the new server boots up — not just within a single process's memory.

**Prevents the drift promoter from restarting at a bad moment.** The clean-window predicate requires THREE conditions: no in-flight forwards, no queued messages, no forward success in the last 90 seconds. Conservative by design — under sustained traffic, the promoter defers. The 60-minute hard deadline (`maxDeferMs`) is the backstop; agents that are never quiet for 60 minutes are also signaling that a forced restart could disrupt a real conversation.

**Prevents silent feature loss on update.** Both new defaults live in `ConfigDefaults.SHARED_DEFAULTS`. The unified-defaults system applies them to existing agents via `PostUpdateMigrator.migrateConfig` (only adds missing keys — user customizations are preserved). The `migrateClaudeMd` step adds a new "Self-Heal: Update Restart Behavior" section to existing CLAUDE.md files so future agent sessions know how to explain the behavior to users. Content-sniffed so it's safe to run repeatedly.

**Prevents authority overreach.** The server's handshake is a signal — it sets a header, reports a degradation, then returns 200. The lifeline-side promoter is the gate with full context. The orchestrator is the only thing that calls `process.exit`. Three seams, three test boundaries.

## What ships when

Everything ships in one PR. The two features depend on each other functionally (the drift promoter wouldn't fire without the server header), and they were both surfaced by the same incident. Defaults applied automatically to existing agents on the next `npm update`. No follow-up migrations needed.

Two related improvements are deliberately NOT in this PR:
- A Remediator dispatcher that takes any failing health probe's `remediation` text and runs it. The scaffolding exists (`src/remediation/Remediator.ts`); generalizing it across all probes is its own PR.
- A "conversation-aware quiet window" that defers restarts while there's an unanswered user message under 5 minutes old on any topic. The current dampener defers based on time-since-last-restart, not conversation state. Also its own PR.

## What you actually need to decide

Are you okay with: (a) update-driven restarts being batched into a 15-minute minimum interval by default (with the existing same-version 30-min cooldown unchanged), and (b) the lifeline self-restarting at a clean window when it drifts more than 20 patches behind the server, sending one passive Telegram notice afterward — YES or NO?

The defaults are conservative, both features are off-by-config-toggle for any agent that doesn't want them, and the rollback is a one-line config edit. The incident this addresses (Luna's silent 15-minute window during a two-step update cascade) is reproduced as a regression test that asserts the exact symptom no longer happens.
