## What Changed

Fixed a latent bug where a **stale emergency-stop could silently strand the resume queue forever**. A MessageSentinel emergency-stop is topic-scoped in intent (it kills/clears/cancels only the topic the "stop" message arrived in — verified against the `routes.ts` handler), but it ALSO sets a **global** `resumeQueue.pause()` with no expiry and no re-arm. Nothing ever lifted that pause, so a stale emergency stop on one topic permanently disabled the revival net for *every other* topic. On 2026-06-14 an emergency stop from the previous day left the net off for ~18h; when an unrelated autonomous run was later recycled at its age cap, the resume-idle fix correctly queued it for revival — but a paused queue admits and never drains, so the run sat dead for ~4h until the operator messaged. This is the concrete cause behind the recurring "why do my sessions keep dying?" feeling.

`ResumeQueueDrainer.tick()` now runs two layers where the silent strand happened (both inert on a dry-run/observe-only queue, so the fleet default is unchanged):

- **Layer 1 (signal-only):** when the queue is paused with waiting work, raise ONE deduped `paused-waiting` aggregated attention notice — keyed on `(pausedAt | waitingCount)` so a new pause OR a growing backlog re-alerts, but a steady pause doesn't drip every tick. This alone makes the strand never silent again.
- **Layer 2 (bounded behavior change, on by default when the queue is live):** auto-resume a **stale** emergency/sentinel pause when an active-autonomous-run entry (`AGE_LIMIT_ACTIVE_RUN_REASON`) was queued **strictly more than** `staleEmergencyPauseAutoResumeMin` (default 60) minutes after the pause began, then fall through to normal draining. Every revived candidate still passes all deterministic reality gates AND the per-topic `operatorStopSince` validation — so a genuinely-stopped topic stays blocked. A FRESH "kill everything" is never auto-undone (the staleness window protects it), and a deliberate `autonomous stop-all` halt is NEVER auto-cleared.

`ResumeQueue.pause()` gains a deliberate-halt **upgrade**: a later non-auto-resumable reason (`autonomous stop-all`) overrides an existing auto-resumable emergency pause (the reverse never downgrades), so an operator's explicit halt issued during a stale pause is honored. The auto-resume predicate lives in ONE centralized, mechanically-enforced helper `isAutoResumableEmergencyPauseReason()` (a callsite-scan unit test pins every `ResumeQueue.pause()` reason's verdict, so a future rewording can't silently change behavior).

audience: agent-only
maturity: stable

Spec converged through `/spec-converge` (6 rounds; real cross-model review via codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro). Future hardening (a structured `pauseKind` enum; broadening the trigger; original-context age) is tracked as evolution-action ACT-904, not deferred-and-forgotten.

## What to Tell Your User

Nothing to announce proactively — the revival safety net ships in watch-only mode for most agents, so unless it was deliberately turned on, behavior is unchanged. If asked "why did my session restart by itself after a stop?" or "why is revival paused?": an emergency stop pauses the whole revival queue, and that pause used to never turn back off — silently stranding later, unrelated work. Now the agent tells you when revival is paused with work still waiting, and a stale emergency pause heals itself once a fresh active run has been recycled and queued well after the stop. Anything you actually stopped stays stopped — the per-topic stop record keeps blocking its revival even after the queue turns back on. If you'd rather the auto-heal stay off, just ask me to turn it off.

## Summary of New Capabilities

A behavior-correctness fix (a permanent silent strand becomes a visible, self-healing one), plus two code-defaulted config knobs.

| Change | Effect |
|--------|--------|
| Layer 1 paused-waiting notice | A paused queue with waiting sessions raises ONE deduped attention notice instead of staying silent (re-alerts on a growing backlog) |
| Layer 2 stale-pause auto-resume | A stale emergency/sentinel pause auto-resumes when an active-run revival was queued > `staleEmergencyPauseAutoResumeMin` (60) min after the pause; per-topic `operatorStopSince` still guards genuinely-stopped topics |
| `pause()` deliberate-halt upgrade | A later `autonomous stop-all` overrides an in-flight auto-resumable emergency pause (never the reverse) |
| `isAutoResumableEmergencyPauseReason()` | One centralized, callsite-scan-tested predicate for which pause reasons are auto-resumable |
| `monitoring.resumeQueue.staleEmergencyPauseAutoResumeMin` (60) / `autoResumeStalePause` (true) | Code-defaulted knobs; `autoResumeStalePause:false` disables Layer 2 (Layer 1 always on) |

## Evidence

Behavior-correctness fix proven from a real 2026-06-14 forensic chain (`logs/reap-log.jsonl`, `logs/resume-queue.jsonl`). All three test tiers green: `tests/unit/resume-queue-drainer.test.ts` (+20: Layer-1 once-per-episode + growing-backlog re-alert, dry-run silence, stale auto-resume happy path, exactly-at/just-over/malformed-timestamp boundaries, fresh-pause/stop-all/plain-mid-work negatives, `autoResumeStalePause:false`, post-resume `operatorStopSince` guard intact, both pause-overlap orderings, the closed-world predicate + mechanical `ResumeQueue.pause(` callsite scan); the suite fails for the right reason before the fix); `tests/integration/resume-queue-routes.test.ts` (+1: `GET /sessions/resume-queue` shows `paused:false` after a drainer auto-resume); `tests/e2e/reap-notify-resume-queue-lifecycle.test.ts` (+1: full lifecycle — emergency-stop pauses → active-run admitted later → drainer auto-resumes → entry `respawned`, the feature-is-alive assertion). `npx tsc --noEmit` clean; full lint + dark-gate green. Config keys are code-defaulted (not in ConfigDefaults — preserves the fleet flip), so no `migrateConfig` change is needed; CLAUDE.md awareness ships via the template + a dedicated idempotent `PostUpdateMigrator` block (so existing agents learn the self-heal too). Side-effects review: `upgrades/side-effects/resume-queue-stale-emergency-pause.md`.
