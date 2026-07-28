# Side Effects — stop-hook-idle-backoff

## Files touched

- `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` — new IDLE_BACKOFF block between the session-id reconcile and the iteration increment: measures the agent's active gap since the last re-injection via a per-topic sidecar (`<topic>.local.backoff.json`), counts consecutive quick stops, and sleeps tiered (3+ → 30s, 6+ → 120s, 10+ → 300s) before emitting the block decision. Poll-sleeps in 5s chunks with early-break on new inbound message / emergency-stop flag / state-file removal; re-checks terminal conditions after the sleep (emergency → notify + clear + exit; state gone → exit). Sleep self-clamps to a third of the hook's own registered Stop timeout read from `.claude/settings.json` (unreadable or codex-mode → conservative 20s). Env seams: `INSTAR_HOOK_BACKOFF_DISABLE`, `_QUICK_SECS`, `_T1/_T2/_T3`, `_POLL_SECS`, `_MAX_SLEEP`.
- `src/core/PostUpdateMigrator.ts` — stop-hook migration marker bumped `RESTART_NOTE_SILENT` → `IDLE_BACKOFF` so existing agents receive the paced hook (customized hooks still untouched).
- `tests/unit/autonomous-stop-hook-idle-backoff.test.ts` — new (13 tests; executes the real hook).
- 7 existing hook-exec test harnesses (`autonomous-completion-condition`, `autonomous-stop-hook-cwd-anchor`, `-codex-gate`, `-topic-keyed`, `-session-clock`, `autonomous-multi-session`, e2e `autonomous-restart-resume-lifecycle`) — gain `INSTAR_HOOK_BACKOFF_DISABLE: '1'` in their env so suites that exec the hook repeatedly never hit a real sleep.
- `tests/unit/autonomous-stop-hook-notify.test.ts` — terminal-notify call-site count 6 → 7 (the backoff's mid-sleep emergency re-check adds one) + marker-history assertion advanced to `IDLE_BACKOFF`.

## Behavioral side effects

1. **An idle autonomous session re-injects its frame ~once per 5 minutes instead of ~15×/min** — ≥98% reduction in idle-loop token burn (the 2026-06-06 rapid-idle-refire waste: thousands of no-op re-injections over one operator sleep).
2. **A productive loop is untouched**: any iteration whose active time exceeds QUICK_SECS (120s) resets the counter; tiers only engage after 3+ consecutive quick stops.
3. **Reaction to a new user message while idle-deep**: ≤ POLL_SECS (5s) — the sleep breaks early on a new inbound file for the topic. Emergency stop and job stop/stop-all break the same way.
4. **One new sidecar file per topic** in `.instar/autonomous/` (`<topic>.local.backoff.json`). The server's autonomous-dir enumeration filters on `.local.md`, so the sidecar is invisible to it. Stale sidecars self-reset on the next run (runStartedAt mismatch) and are removed on the backoff's own terminal exits; sidecars left by other terminal paths are inert.
5. **Migration**: every existing agent's stock stop-hook is overwritten at next migration run (marker bump). Customized hooks (no stock fingerprint) skipped, as before.

## Risks / blast radius

- **Hook timeout vs sleep** (the strand-class risk): a Stop hook killed by the host fails OPEN → session exits → loop strands silently. Mitigated three ways: the sleep self-clamps to registered-timeout/3 (live read of settings.json; the shipped registration is 10000s, so the clamp is far above T3); unreadable/missing registration falls back to a 20s cap; codex registrations get the same 20s cap. Worst case is therefore reduced pacing, never a stranded loop.
- **Sentinel interplay**: a session sleeping inside its Stop hook shows no pane activity for up to 5 min. The silence/socket sentinels target sessions with active work or dropped sockets, not completed turns awaiting the next injection; observed-not-theorized verification rides the dogfood loop after deploy.
- **Delayed sentinel/tmux-injected text** (not Telegram-routed): anything typed directly into the pane during a sleep sits in the input buffer until the next turn — bounded by T3 (5 min). Telegram messages are NOT affected (early-break).
- **Counter semantics during conversation**: replying to a user message usually takes < QUICK_SECS, so the counter can keep rising across an active conversation — but each new inbound message breaks the sleep within 5s, so perceived latency stays ≤5s; pacing only persists between messages, which is the desired behavior.

## Tests

- `tests/unit/autonomous-stop-hook-idle-backoff.test.ts` (13): counter evolution (first-stop zero, quick-rise, long-gap reset, new-run reset), tier engagement + MAX_SLEEP clamp + DISABLE seam, early-breaks (inbound / emergency / state-removal, real async timing), static safety properties (timeout self-clamp present, sidecar suffix invisible to server), migration upgrade path (prior-era hook gains IDLE_BACKOFF, retains RESTART_NOTE_SILENT).
- All 8 pre-existing hook suites pass with the disable seam (57 tests across the affected files).
- Full typecheck clean; `bash -n` clean.
