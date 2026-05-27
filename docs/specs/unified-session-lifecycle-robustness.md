---
title: "Unified Session-Lifecycle Robustness — one brain for every session killer"
date: 2026-05-27
author: echo
status: draft
review-convergence: pending
approved: false
approved-by: null
eli16-overview: unified-session-lifecycle-robustness.eli16.md
topic: 2169 (session-robustness)
---

# Unified Session-Lifecycle Robustness

## Problem

On 2026-05-27 a user reported sessions "disappearing without notice." Investigation found the
boot purge silently marked **9 of 9 tracked sessions** dead in one sweep while their tmux windows
were still alive:

```
2026-05-27T01:12:45.648Z [SessionManager] Startup purge: removed 9 dead session(s) of 9 tracked
```

The proximate bug is in `SessionManager.purgeDeadSessions()`: it probes liveness with
`execFileSync(tmux has-session, { timeout: 1000 })` inside a bare `try/catch`. A timeout (tmux busy
at boot, which is exactly when many sessions exist and a process just restarted) throws the **same**
error as "session does not exist" — and the catch treats both as dead. A 100%-purge ("9 of 9") is
the fingerprint of a systemic timeout, not nine coincidental deaths. With 3 auto-update restarts
that day, the boot purge ran 3 times.

But the deeper problem — and the actual scope of this spec, per the user's request to "make all
parts of the system that monitor and kill sessions equally robust" — is that **"is this session
alive / dead / stuck / working?" is answered ad-hoc in eight different places**, each with its own
timeout, its own (mis)handling of transient errors, its own (missing) protected-session check, and
its own (missing) user notification. A careful, recently-built reaper (`SessionReaper`) sits right
next to seven cruder ones that predate its discipline.

## The robustness bar (three rules)

Every code path that can autonomously end a session must satisfy:

1. **Never mistake "slow / busy / unreachable-for-a-moment / asleep" for "dead."** A failed or
   timed-out liveness probe is *indeterminate*, not *dead*. (This is the session-lifecycle
   application of the ratified constitution standard **"A Wall Is a Hypothesis"**: absence of a
   heartbeat is a hypothesis of death, never a proof.)
2. **Never kill a session that is genuinely doing work.** Idleness must be proven by *positive*
   evidence (a ready prompt, no growing transcript, no active child process) — never inferred from
   the *absence* of a signal, because a session mid-LLM-generation or mid-network-call looks
   identical to an idle one from the outside.
3. **Never kill silently.** A genuine terminal reap of a user-facing session must reach the user
   (respecting near-silent: a kill-to-respawn *recovery bounce* is not a disappearance and must not
   generate noise; routine job-session cleanup stays on the pull surface).

## Current state — the eight autonomous killers, graded

`SessionReaper` already meets all three rules. Its `evaluate()` returns KEEP on *every* "can't tell"
path (uninspectable process → KEEP, unresolved transcript → KEEP, no *positive* idle proof → KEEP,
thrown protect-signal → KEEP), honors protected / topic-bound / open-commitment / build-active
guards, double-confirms across ticks, and ships dry-run. It is the existing gold standard.

| # | Killer | Trigger | Liveness check | Rule 1 (slow≠dead) | Rule 2 (no kill-while-working) | Rule 3 (notify) |
|---|--------|---------|----------------|--------------------|-------------------------------|------------------|
| 1 | `SessionManager.purgeDeadSessions` (boot) | startup sweep | `has-session`, 1s, bare catch | ❌ timeout = dead | ❌ no work check | ❌ silent |
| 2 | `SessionManager` age-limit kill | age > 240m + idle | idle-prompt + procs | ⚠ ok-ish | ⚠ **no topic-bound exemption** (the gentle idle path has one; this hard cutoff doesn't) | ❌ silent |
| 3 | `SessionManager` idle/zombie kill | idle > threshold | idle-prompt + procs | ✅ | ✅ topic-bound 240m grace | ❌ silent |
| 4 | `SessionManager.isSessionAliveAsync` (shared) | — | `has-session`, 5s, bare catch | ⚠ timeout = dead (longer fuse) | n/a | n/a |
| 5 | `SessionWatchdog` | child proc "stuck" 3m+ | `ps etime` + `kill -0` | ⚠ LLM-gate + stdin-guard mitigate; can still misread slow work | ⚠ partial | ⚠ event emitted, delivery not guaranteed |
| 6 | `OrphanProcessReaper` | orphan proc > 60m | `ps` elapsed | ⚠ age-based | ❌ age only, no work check | ⚠ callback, mostly silent |
| 7 | `QuotaManager` / `SessionMigrator` | 95% 5h quota | `isSessionAlive` after Ctrl-C grace | n/a (real constraint) | ❌ no work gate at 95% | ⚠ queued notify |
| 8 | `SessionRecovery` (×4 paths) | JSONL stall/crash/loop | pure JSONL analysis | ❌ JSONL age ≠ frozen process | ❌ no process cross-check | ❌ silent (but kill-to-**respawn** = bounce, not disappearance) |
| 9 | `JobScheduler` wake-reaper | wall-clock > expected×2 after sleep | wall-clock only | ❌ counts sleep time as runtime | ❌ no work check | ❌ silent |
| — | `CrashLoopPauser` | crash loop | — | n/a — disables jobs, never kills sessions | ✅ | ✅ |

(Line citations are in the implementation notes below; line numbers are against `JKHeadley/main`
@ v1.3.26 and will drift — grep the named methods.)

## Design — one brain, four shared primitives

The fix is not eight patches. It is to **extract `SessionReaper`'s discipline into shared primitives
that every killer routes through**, and bring the cruder killers up to it.

### P1 — `SessionLivenessOracle` (tri-state, never "dead" on doubt)

A single function answering liveness as a **tri-state**, not a boolean:

```ts
type Liveness = 'alive' | 'dead' | 'indeterminate';
async function probeLiveness(tmuxSession: string): Promise<Liveness>;
```

- `dead` is returned **only** on a definitive negative, which requires **two** facts together:
  (a) the tmux **server is reachable** (a control probe like `tmux ls` / `list-sessions` succeeds),
  AND (b) the specific session is absent from the live list (or `has-session` exits with the
  recognized "no such session" code while the server is reachable). Server reachable + session gone =
  genuinely dead.
- A timeout, a **tmux-server-unreachable** error, an `ENOENT`/`EPIPE`, or any unrecognized failure →
  `indeterminate`. Probe uses a generous timeout (≥5s) and one retry with backoff before settling.
- **Hard rule, enforced in code at every callsite: never transition a session to killed/completed on
  `indeterminate`.** Indeterminate means "ask again next tick," never "reap now."

The server-reachability split is what *also* protects against re-introducing the death spiral (see
side-effects SE-1): if tmux is genuinely up and a session is genuinely gone, we still reap promptly —
we only hold back when we truly cannot tell.

This single primitive, adopted by killers #1 and #4, would have prevented the entire 2026-05-27
incident. The boot purge becomes: `if (probe === 'dead') purge; else keep`.

### P2 — `ReapGuard` (positive-evidence + KEEP-guards, extracted from `SessionReaper`)

Hoist `SessionReaper`'s `evaluate()` guard chain into a reusable, injectable guard every autonomous
killer must consult *immediately before* terminating:

```ts
// returns the reason a session must be KEPT, or null if it is safe to reap
function reapBlockedReason(session): ReapKeepReason | null;
```

Guard chain (same order/semantics `SessionReaper` already uses):
protected → recent-user-message (topic-bound, unresolved-topic → KEEP) → open-commitment →
build/autonomous-active → active child process → main-process CPU/IO (uninspectable → KEEP) →
transcript growth (unknown → KEEP) → **positive idle proof required** (no positive ready prompt →
KEEP) → thrown signal → KEEP.

`SessionReaper` keeps its own `evaluate()` (which adds pressure-tier thresholds, hourly budget, and
multi-tick double-confirm on top of the guard); the other killers consult the shared
`reapBlockedReason` as a mandatory pre-kill gate. The guard is the floor; reapers may be stricter,
never looser.

### P3 — Unified reap-notification seam (`sessionReaped` event + one listener)

All terminal kills funnel through `SessionManager.killSession()` (today the direct
`tmux kill-session` callsites in the monitor loop, watchdog, orphan reaper, and wake-reaper bypass
it). `killSession()` already emits `beforeSessionKill`; add a `sessionReaped` event carrying
`{ session, reason, disposition }` where `disposition ∈ { 'terminal', 'recovery-bounce' }`.

One listener (in `server.ts`, alongside the existing `beforeSessionKill`/`sessionComplete` wiring)
turns a `terminal` reap of a user-facing/topic-bound session into a single user notice routed to the
session's topic, or the lifeline topic if unbound. `recovery-bounce` reaps (SessionRecovery,
version-skew restarts, context-exhaustion respawns — which already set a recovery flag) emit the
event but the listener stays silent (near-silent compliance). Notice text names the session, the
reason, and that no work was lost where resume applies.

### P4 — Consistent exemptions everywhere

`protectedSessions` is checked by `killSession` and `reapCompletedSessions` but **not** by
`purgeDeadSessions`, the watchdog, the orphan reaper, or the wake-reaper. Route every autonomous
killer through `reapBlockedReason` (P2), which makes protected / topic-bound / active-work
exemptions uniform by construction. The age-limit kill (#2) gains the topic-bound grace the gentle
idle path (#3) already has — folded in via the shared guard.

## Per-killer remediation

- **#1 boot purge** — replace 1s bare-catch with P1 oracle; `dead`-only purges; add P2 guard.
- **#2 age-limit kill** — consult P2 guard (gains topic-bound grace); route through `killSession` so
  P3 fires.
- **#3 idle/zombie kill** — already compliant on rules 1–2; route through `killSession` for P3.
- **#4 `isSessionAliveAsync`** — back it with P1 oracle so callers (e.g. `reapCompletedSessions`)
  inherit tri-state safety.
- **#5 watchdog** — keep LLM gate + stdin guard; add P2 guard before the final `kill-session` level;
  route the kill through `killSession` for P3.
- **#6 orphan reaper** — add P2 work check before killing a project-prefixed session; keep the 60m
  age floor as a *necessary*, not *sufficient*, condition; emit P3.
- **#7 quota/migrator** — quota is a real hard constraint, so killing stands, but add P3 notify and a
  P2-style "is it mid-build" soft check that prefers Ctrl-C + longer grace for build/autonomous-active
  topics before force-kill.
- **#8 SessionRecovery** — add a wall-clock/process cross-check to stall detection (JSONL age alone
  is insufficient — confirm the process isn't progressing via P1/P2 before kill-to-respawn); tag the
  kill `recovery-bounce` so P3 stays quiet.
- **#9 wake-reaper** — subtract measured sleep duration from elapsed before comparing to threshold
  (use `SleepWakeDetector`'s `sleepDurationSeconds`, already in hand at the callsite); add P2 guard;
  emit P3.

## Bonus — session label follows topic rename

Separate small request from the same thread: when the user renames a Telegram topic, the dashboard
session label should follow. Today the label is captured at spawn. Add: on the existing topic-rename
signal (Telegram `forum_topic_edited` / the name resolved in `telegram-topic-context`), update the
bound session's display name. Low-risk, isolated; bundled here because it is session/topic labeling.

## Migration parity

- `SessionLivenessOracle`, `ReapGuard`, and the kill paths are server-side TypeScript — they ship
  with the server on update; no `PostUpdateMigrator` entry needed for the code.
- New config defaults (liveness probe timeout/retry, notification on/off, wake-reaper
  sleep-subtraction) go in `migrateConfig()` with existence checks (additive only).
- No CLAUDE.md template / hook / skill changes required beyond an Agent-Awareness note if a new
  `/sessions/reap-log` style endpoint is added (TBD — see open questions).

## Testing (three tiers, both sides of every boundary)

- **Unit:** P1 oracle returns `indeterminate` (not `dead`) on a simulated timeout / unreachable tmux,
  and `dead` only on a genuine has-session miss; P2 guard returns a KEEP reason for each guard
  (protected, recent-user, commitment, build-active, active-proc, uninspectable, unresolved
  transcript, no-positive-idle) and `null` only when all clear; wake-reaper subtracts sleep correctly;
  boot purge keeps a live-but-slow session.
- **Integration:** through the real HTTP/event path, a terminal reap emits one user notice; a
  `recovery-bounce` emits none; protected sessions survive every killer.
- **E2E:** the "feature is alive" test — a real slow/busy session at server boot is NOT purged
  (reproduces the 2026-05-27 incident and proves it cannot recur); a genuinely-dead session still is.

## Reproduction-before-claim (evidence bar)

Per the bug-fix-evidence-bar: before this is called fixed, reproduce the false-purge on a real boot
with a deliberately-slowed `has-session` (or many sessions) and watch the live session survive; and
watch a genuine terminal reap deliver exactly one Telegram notice. Green tests are necessary, not
sufficient.

## Rollback

Each primitive is additive and independently revertable. P1/P2 default-on (they only make killing
*more* conservative — the failure mode is "a dead session lingers one extra tick," caught by the next
tick, far cheaper than killing a live one). P3 notification has an on/off config flag. The wake-reaper
sleep-subtraction and label-rename are isolated.

## Adversarial side-effects review (folded in)

Ten findings, each resolved in the design above or scoped out with reason.

- **SE-1 — Over-conservatism re-introduces the death spiral.** The original purge exists to "prevent
  the death spiral where stale sessions overwhelm startup." If P1 returned `indeterminate` for
  genuinely-dead sessions, dead records would leak, fill `maxSessions`, and block new spawns.
  *Resolved:* P1's server-reachability split — tmux-up + session-absent = `dead` (reaped promptly);
  only a truly unreachable/timing-out probe yields `indeterminate`. We hold back exactly when we
  can't tell, not when a session is plainly gone.
- **SE-2 — Indeterminate forever → resource leak.** A wedged tmux pane could stay `indeterminate`
  every tick and never be reaped. *Resolved:* bounded escalation — after N consecutive
  `indeterminate` probes over M minutes, raise a single **Attention-queue** item ("session X
  unverifiable — investigate/force-kill?") for an operator decision. Never an auto-kill, never a
  silent leak.
- **SE-3 — Tri-state has two consumers wanting opposite conservatism.** `isSessionAlive` feeds both
  *reaping* (where `indeterminate` must NOT count as dead) and *scheduler slot-counting / health*
  (where treating an `indeterminate` session as free would over-spawn). *Resolved:* explicit
  per-consumer mapping — reapers treat `indeterminate` as "keep," gating/counting treats it as
  "occupied/alive." One oracle, two documented projections; no caller gets a raw boolean that hides
  the distinction.
- **SE-4 — Reaper vs recovery race.** SessionRecovery kills-to-respawn; a purge/idle reaper firing on
  the same session mid-recovery would race. The idle path already has an `activeRecoveryChecker` veto.
  *Resolved:* the veto moves into the shared `ReapGuard` (P2) so **every** killer honors
  "recovery-in-flight → KEEP," not just the idle path.
- **SE-5 — Double `beforeSessionKill` emission.** Routing the monitor loop's inline `kill-session`
  through `killSession()` (P3) risks emitting `beforeSessionKill` twice (once inline, once in
  `killSession`). *Resolved:* remove the inline emissions; `killSession()` becomes the single emitter.
  Resume-UUID save listeners must remain idempotent (verify during impl).
- **SE-6 — Reap notice must not touch the dead session.** The P3 listener must send a plain outbound
  Telegram message; it must never try to inject into or respawn the just-reaped session. *Resolved:*
  notice is out-of-band to the topic/lifeline; respawn (if any) is owned solely by SessionRecovery's
  `recovery-bounce` path, which is silent.
- **SE-7 — Burst reaps → notification flood.** A legitimate mass cleanup could fire many terminal
  notices at once (the post-2026-05-22 topic-spam lesson). *Resolved:* P3 coalesces terminal reaps
  within a short window into ONE consolidated message to the lifeline topic, mirroring the sentinel
  escalation coalescing. Per-session notices only when topic-bound and isolated.
- **SE-8 — Wake-reaper sleep subtraction must use overlap, not raw value.** Subtracting raw
  `sleepDurationSeconds` mis-corrects when sleep only partially overlapped the run window (or the job
  started during sleep). *Resolved:* subtract only the sleep interval that overlaps
  `[run.startedAt, now]`.
- **SE-9 — Quota soft-check must not breach the hard cap.** Giving build-active topics extra grace at
  95% must never let real usage hit 100%/lockout. *Resolved:* the build-active exemption buys exactly
  one extra Ctrl-C grace round; the hard force-kill still wins, and the exemption is disabled above a
  configurable ceiling. Quota is a real, hard constraint and keeps final authority.
- **SE-10 — Signal-vs-authority posture.** Today each killer is its own authority. P2 makes the
  shared guard a mandatory *floor* but killers still decide independently. *Scoped as open question:*
  whether to go further and make killers signal-only with a single `ReapAuthority` deciding (fuller
  signal-vs-authority compliance) is noted for /spec-converge; the guard-as-floor is the pragmatic
  Phase-1 posture and is strictly safer than today.

## Conformance pass (Instar standards)

- **Structure > Willpower:** ✅ the "never kill on indeterminate" rule and the KEEP-guards are
  enforced in shared code at every callsite, not in prose.
- **Signal vs authority:** ⚠ partial — guard-as-floor now; full signal-only redesign noted (SE-10).
- **Near-silent notifications:** ✅ recovery-bounce silent, terminal reaps coalesced, detail on a pull
  surface (reap-log).
- **3-tier testing + wiring/semantic + reproduce-before-claim:** ✅ specified.
- **Migration parity:** ✅ code ships with server; config defaults additive in `migrateConfig()`.
- **No-manual-work:** ✅ nothing asks the user to run steps.

## Suggested phasing (one approval → chained merges, no fragmentation)

- **Phase 1 (the incident + backbone):** P1 oracle + boot-purge fix + P2 guard extracted from
  SessionReaper + route #2/#3 through `killSession` + P3 seam with the one listener. Closes the
  reported bug and establishes the shared brain.
- **Phase 2 (bring the rest onto the guard):** #5 watchdog, #6 orphan, #8 recovery cross-check,
  #9 wake-reaper sleep-subtraction.
- **Phase 3 (polish):** #7 quota soft-check + label-rename + any reap-log endpoint + Agent-Awareness.

## Open questions

1. Should terminal-reap notices be **on by default**, or default-off behind a flag like the sentinel
   escalation (given the post-2026-05-22 topic-spam lesson)? Recommendation: on by default but
   coalesced and routed to the bound/lifeline topic only — a genuine terminal reap of a session the
   user was using is exactly the "actionable" class that should reach them, unlike housekeeping.
2. Do we want a pull-surface `/sessions/reap-log` (audit of every reap + reason + disposition) for the
   dashboard, mirroring `sentinel-events.jsonl`? Recommendation: yes, cheap and aligns with
   near-silent (detail on the pull surface, only terminal reaps pushed).
3. Quota at 95% (#7): is force-killing a mid-build topic acceptable, or should build/autonomous-active
   topics get a longer grace even under quota pressure? Needs the operator's call on the
   quota-vs-lost-work tradeoff.
