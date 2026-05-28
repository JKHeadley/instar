# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

### ContextWedgeSentinel — detect + (optionally) recover the thinking-block-400 wedge

**A new way sessions die is now detected and (optionally) auto-recovered.** When
a tool call is cancelled inside a *parallel* tool batch while extended thinking
is on, Claude Code corrupts the thinking block on the latest assistant turn —
and from then on the Anthropic API rejects every resume with
`400 … thinking blocks in the latest assistant message cannot be modified`. The
session fast-fails instantly on every message ("Cooked for 0s"): permanently
dead, yet still emitting output. Because it's not *silent* and hasn't lost its
socket, neither the ActiveWorkSilenceSentinel nor the SocketDisconnectSentinel
catches it — the user just sees standby/sentinel replies forever while the real
session is a corpse. (Live incident: a session on a real topic fast-failed every
"How is this looking?" for ~30 minutes.)

The new **ContextWedgeSentinel** (a 4th member of the silently-stopped family)
recognizes this exact wedge: it matches the error as the *live session tail* and
waits a 45s confirm window so a session merely *discussing* the bug is never
flagged. A gentle nudge can't fix this one (re-engaging re-sends the corrupted
turn), so recovery is a **fresh respawn** — kill the session and clear the
topic's saved resume UUID so the bridge spawns a brand-new conversation instead
of `--resume`-ing the corrupted transcript (which would just re-wedge on the
next message — the central correctness property). This reuses the existing
rate-guarded `SessionRefresh` via a new `fresh` mode.

Detection + audit are **default-ON housekeeping** (they write to
`logs/sentinel-events.jsonl` and kill nothing). The destructive auto-respawn is
**opt-in** (`monitoring.contextWedgeSentinel.autoRecovery`, default off + dry-run)
and rides the Graduated Feature Rollout track. The sentinel also feeds the
SessionReaper kill-veto so the reaper never reaps a session mid-recovery. New
config kill switch `monitoring.contextWedgeSentinel.enabled` (default true).

### Unified session-lifecycle robustness — Phase 1 (ReapAuthority + reap-log + backstop)

Phase 1 of **unified session-lifecycle robustness** (spec `docs/specs/unified-session-lifecycle-robustness.md`, converged + approved). The trigger was a real incident: at a busy server boot the startup "cleanup crew" treated a slow-to-answer tmux session as *dead* and wiped 9 of 9 live sessions — silently. The audit that followed found eight different code paths that can end a session, each re-inventing "alive or dead?" its own way, several of them able to mistake slow/busy for dead and none of them telling the user. This release builds the single authority + safety backbone that the rest of the killers will move onto.

What landed:

- **One authority, not eight.** `terminateSession()` is now the sole kill chokepoint. Every autonomous shutoff routes through it and can only *request* a kill — the authority holds the safety checks: a compare-and-set live-status guard, the `protected` set, an **awake-machine-only lease gate** (a standby never reaps another machine's sessions), and a mandatory **KEEP-guard** consult (the same positive-evidence checks the careful SessionReaper uses — relay-lease, pending-injection, recent-user-message, active subagent/process, etc.). An explicit **operator** kill (stamped only by the Bearer-authed HTTP route) bypasses those gates so a human "kill" always happens. The first three killers — boot purge, the age/5-hour cutoff, and the idle-zombie killer — are funneled through it.
- **A reap is never silent.** A new coalescing notifier surfaces "your session was shut down — <reason>" so a session can't just vanish. Routine kill-to-respawn bounces and your own operator kills stay quiet; a burst collapses into ONE consolidated message instead of spamming. Default **on** (`monitoring.reapNotify`).
- **A reap-log you can read.** Every shutoff *and* every refused/skipped shutoff (protected / not-lease-holder / a KEEP-hold / in-flight) is recorded as one JSON line, served read-only at `GET /sessions/reap-log`. "Where did my session go?" now always has an answer.
- **Nothing is unconditionally immortal — and nothing can lock you out.** A signal-only backstop watches for a session that fakes work (heartbeat-byte / tight-loop) or is stuck unverifiable, and after a threshold raises ONE deduped Attention item asking *you* to decide — it never auto-kills. Long-unverifiable sessions are excluded from the absolute spawn cap so a fleet of stuck panes can't lock you out of starting new work.

All changes are additive and only make killing *more* conservative; the boot-purge fix already turns the original 9-of-9 wipe into 0 false kills. Phase 2 (watchdog / orphan / recovery / wake-reaper onto the authority) and Phase 3 (quota soft-check + session-label-follows-rename) follow.

## What to Tell Your User

- I can now spot a specific way a session silently dies — it gets stuck on a
  "can't modify the thinking block" error and fails instantly on every message
  while still looking busy — which used to leave you seeing only standby replies.
  By default I just notice and log it; you can opt in to having me restart a
  stuck session cleanly (I throw away the corrupted conversation so it can't get
  re-stuck).
- Your sessions also won't silently disappear anymore. The startup cleanup no
  longer mistakes a slow-to-answer session for a dead one, and if anything does
  get shut down you get told why — with a reap-log page recording every shutoff
  and every refused shutoff.
- Every automatic cleanup now goes through one careful gatekeeper that refuses to
  end a session that might be working, and only the "awake" machine ever reaps.
  When you kill a session it still happens immediately.
- Nothing can get wedged-but-immortal or quietly fill your slots: instead of ever
  auto-killing a stuck session, the agent raises a single "this looks stuck —
  investigate or force-kill?" item for you.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| ContextWedgeSentinel (thinking-block-400 detection) | Automatic + default-on housekeeping; audits to `logs/sentinel-events.jsonl` |
| Opt-in wedge auto-recovery | `{"monitoring": {"contextWedgeSentinel": {"autoRecovery": {"enabled": true, "dryRun": false}}}}` (Graduated Rollout track) |
| SessionRefresh `fresh` mode | Internal — kill + respawn that clears the topic's resume UUID (no re-wedge loop) |
| Single ReapAuthority (all autonomous kills funnel through `terminateSession`) | Automatic — boot-purge, age-kill, and idle-zombie now route through it with the KEEP-guard + lease gate |
| Reap notice ("your session was shut down — <reason>") | On by default; silence it with `{"monitoring": {"reapNotify": {"enabled": false}}}` |
| Reap-log | `curl -H "Authorization: Bearer $AUTH" "http://localhost:4040/sessions/reap-log?limit=50"` (read-only) |
| Unkillability backstop (escalate, never auto-kill) | Automatic + signal-only; tune via `monitoring.staleBackstop` |
| Spawn-cap exclusion for long-unverifiable sessions | Automatic — they no longer count toward the absolute `maxSessions × 3` cap |

## Evidence

**ContextWedgeSentinel.** Reproduced live 2026-05-28: a parallel Bash batch with one guard-blocked call corrupted the latest assistant thinking block; every subsequent message fast-failed with the `400 … cannot be modified` error while the silence + socket sentinels stayed quiet. After: the wedge is detected as the live tail and written to `logs/sentinel-events.jsonl`; the e2e test drives the production assembly and reads those rows back; the live recovery clears the topic's resume UUID so the respawn starts fresh.

**Session-lifecycle Phase 1.** 123 unit + 10 integration + 3 e2e green: ReapGuard (15), ReapNotifier (10), ReapLog (6), StaleSessionBackstop (10), terminate-CAS (9), liveness-oracle (15), boot-purge death-spiral reproduction (the 2026-05-27 9-of-9 incident → 0 false purges), reap-log route (integration + e2e "feature is alive" 200-not-503), and a full event-path integration (autonomous reap → log + one notice; recovery-bounce/operator silent; relay-lease/standby/protected refused-and-survive). `tsc --noEmit` clean. Migration parity: `reapNotify` + `staleBackstop` defaults flow to existing agents via ConfigDefaults; the reap-log Agent-Awareness section ships in both the CLAUDE.md template and `migrateClaudeMd`. Spec converged over 3 code-grounded review rounds (`docs/specs/reports/unified-session-lifecycle-robustness-convergence.md`); side-effects review: `upgrades/side-effects/unified-session-lifecycle-robustness.md`. Honest scope note: the boot-purge false-purge and the notice/log/survival paths are reproduced at the unit + real-event-path + real-AgentServer tiers; a live "boot a server, slow tmux, watch a Telegram notice land" pass was not performed in this environment.
