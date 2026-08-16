---
name: feedback-scheduled-jobs-starved-by-user-sessions
description: Scheduled maintenance jobs silently starve when 10-slot session pool is held by long-lived user topic sessions; needs reserved quota or queue.
metadata:
  type: feedback
---

When the global session cap (10) is fully occupied by long-running user topic sessions (OpenClaw, instar-jobs-as-agentmd, instar agent robustness, token management, topic-intent-layer, exploring slack integration, standby mode edits, qalatra, claude agent sdk, ...), scheduled jobs cannot spawn and emit `job_error: Max sessions (10) reached` on every tick. Observed 2026-05-18: commitment-detection and dashboard-link-refresh each accumulated 25+ consecutiveFailures; degradation-digest, guardian-pulse, session-continuity-check, coherence-audit, health-check, git-sync all blocked. No auto-mitigation kicks in.

**Why:** Single shared session pool with no priority class means user-named work (often idle/parked) crowds out housekeeping jobs that exist to detect drift. The job log fills with retry noise rather than producing signal; the very jobs that would notice the degradation (guardian-pulse, degradation-digest) are themselves victims.

**How to apply:** When building/tuning the session manager, reserve a small quota (e.g. 2 slots) for scheduled/system jobs separate from user sessions, OR add a reaper that closes idle "running" sessions with no lastActivity for >N hours before applying the cap, OR queue spawn requests rather than hard-failing. Also: add a guardian rule that fires when any single job's consecutiveFailures crosses ~5 with the same "Max sessions" stderr — that's a structural starvation signal, not a job bug. Related: [[feedback_active_followthrough]] (passive waiting on a stuck spawn is banned).
