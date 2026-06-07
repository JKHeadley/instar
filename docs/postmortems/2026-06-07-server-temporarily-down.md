# Post-mortem — "Server temporarily down on every message" (2026-06-07, topic 21816)

## Summary

Justin saw "server temporarily down" on almost every Telegram message, including the
first message of a quiet morning. Root cause was NOT an update or a single bug — it was
**CPU starvation + a restart loop**: under load the single-threaded server couldn't answer
its own `/health` within the supervisor's window, and a chain of latent assumptions turned
that into a self-sustaining flap. Five code fixes shipped; the deepest standard
(health-first boot) remains a follow-up.

## Timeline (condensed)

- Morning: Justin reports the symptom. Diagnosis: load ~19–28 on 16 cores, dominated by
  macOS `mediaanalysisd` (Photos) + Spotlight `mds_stores` — not instar. `/health` times
  out >8s; supervisor flips unhealthy; lifeline emits "server temporarily down" (messages
  queue, not lost). 65 server boots/day = a restart loop.
- Found contributing bugs: stuck-recovery re-running already-answered messages every ~10
  min (tagged "from Unknown"); blocking `spawnSync` process scans in monitors; the
  interactive-pool canary refusing to start the whole pool on a single failure; a revoked
  Mac Mini un-quarantining itself across an update.
- Built + shipped 5 fixes (below). During the rollout I **caused a regression**: I
  restarted the stable-but-already-booted server to load fixes, which forced a fresh boot
  that — on the loaded box — exceeded the supervisor's 3-min startup grace, re-triggering
  the loop. Recovered by raising the grace to 10 min.

## Root causes (deepest first)

1. **Health-first boot violation (THE root).** The server binds `/health` only AFTER
   heavy synchronous boot work (loading ~18k TopicMemory messages + SemanticMemory +
   reconciling ~45 sessions). On a loaded box that's 5–6 min during which `/health` is
   unanswerable. Any supervisor whose patience is shorter than the boot will restart
   mid-boot → loop. The grace bump treats the symptom; the cure is to bind a liveness/
   `/health` listener FIRST and load state in the background.
2. **Fixed grace < scaling boot cost.** `startupGraceMs` was a constant 3 min; boot cost
   scales with memory/session volume. Latent until the volume grew. (Fixed: 10 min.)
3. **Stuck == unanswered (replay).** Stuck-recovery re-ran any entry in `processing`
   without checking whether the topic was already answered, and dropped the sender. Under
   the flap (replies failing to commit) this re-ran handled messages forever. (Fixed:
   reply-evidence guard + sender envelope.)
4. **Synchronous process scans block the loop.** Monitors used `spawnSync('ps'…)` on a
   cadence; under load the cumulative stall starved `/health`. (Fixed for SessionWatchdog;
   OrphanProcessReaper/mcpProcessReaper are a follow-up.)
5. **A protection-in-depth check made fatal.** The pool's empty-prompt canary `throw`ing
   refused the whole pool → SDK-credit fallback + circuit-trip loop. (Fixed: graceful.)
6. **Revocation not sticky on re-register.** (Fixed.)
7. **Auto-update wipes local patches.** An "Echo-only" local dist patch is overwritten by
   the next auto-update — so an Echo-only durable fix is impossible via local patching;
   durable fixes must ship in the published release.

## The five fixes

| PR | Fix |
|----|-----|
| #971 | Replay/stuck-recovery dedupe — reply-evidence guard + sender preservation + lifeline queue id-dedup |
| #972 | Non-blocking watchdog process scans (sync→async; poll yields) |
| #973 | Pool canary degrades gracefully instead of refusing to start |
| #974 | Revoked mesh machines stay revoked across re-register |
| #979 | Supervisor startup grace 3min→10min (the restart-loop cure) |

## Standards / gates to add (the ask)

1. **Health-first boot ordering (NEW STANDARD).** Every long-lived server MUST bind its
   liveness/`/health` endpoint before any heavy/blocking initialization; load state in the
   background and report "warming" until ready. A restart must never be able to loop on a
   slow boot. (Add a boot-ordering lint/test: assert the listen call precedes heavy loads.)
2. **Restart-loop circuit breaker.** The supervisor should detect N restarts in M minutes
   and escalate (attention item) + back off, instead of looping silently. (The
   GuardPostureTripwire/reap-log are precedents; add a restart-rate breaker.)
3. **No blocking subprocess scans on the runtime hot path (lint).** Ban `spawnSync`/
   `execFileSync` of `ps`/`pgrep`/`lsof` in monitoring/server runtime dirs (test like
   no-silent-fallbacks). Force async.
4. **Protection-in-depth checks must fail soft.** A verification/canary for a non-primary
   capability must degrade (report + continue), never refuse the primary path. (Lint/review
   heuristic: a `throw` in a canary/self-test path is a smell.)
5. **Safe live-deploy path (not kill+restart).** Deploying code to a live agent must not
   require killing a stable server. Document + tool a deploy that swaps code and lets the
   supervisor cycle it under the (now safe) grace — never a manual `tmux kill-session` of a
   healthy server.
6. **Durable-fix-only rule for live agents.** "Echo-only via local dist patch" is
   anti-pattern (auto-update wipes it). Fixes to a running agent go through the release, or
   the agent's auto-updater is explicitly paused first.
7. **Latent-under-load review prompt.** For any fixed constant/threshold or
   "is-it-busy?"/"is-it-handled?" check, ask in review: "does this assumption hold as
   memory/session/CPU scale?" These four roots were all load-latent.

## Process lessons (mine)

- **Don't deflect ownership.** I told the operator to stabilize it; he correctly pushed
  back — fixing it was my job and capability. Own incidents.
- **Don't make it worse with hasty live actions.** Restarting a stable, already-booted
  server on a loaded box re-lit the loop. Prefer the least-invasive action; let the
  supervisor handle restarts.
- **Don't claim "stable" prematurely.** I called it stabilized twice before it was;
  verify (consecutive healthy checks) before reporting success.
- **Under starvation, reduce footprint, don't spin.** Diagnostics + restarts add load to
  the very thing that's struggling.
