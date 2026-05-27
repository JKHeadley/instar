---
title: "Unified Session-Lifecycle Robustness — one authority for every session kill"
date: 2026-05-27
author: echo
status: converged-awaiting-reconfirm
review-method: internal-5-reviewer-plus-conformance-gate (security, scalability, adversarial, integration, lessons-aware) — external cross-model deferred to the cross-review-via-frameworks initiative (Codex/Gemini panel not yet wired)
approved: false
approved-by: null
approved-note: "Justin approved the DRAFT (Telegram topic 2169, 2026-05-27); convergence then MATERIALLY strengthened the design (single authority, multi-machine lease-gating, unkillability backstop, reap-log ships). approved reset to false pending Justin's re-confirm against the converged design after reading the convergence report."
eli16-overview: unified-session-lifecycle-robustness.eli16.md
supervision: oracle/guard = tier0 (pure data, no policy); reap-notification disposition + quota soft-check = tier1
topic: 2169 (session-robustness)
review-convergence: "2026-05-27T17:18:34.456Z"
review-iterations: 3
review-completed-at: "2026-05-27T17:18:34.456Z"
review-report: "docs/specs/reports/unified-session-lifecycle-robustness-convergence.md"
---

# Unified Session-Lifecycle Robustness

## Problem

On 2026-05-27 a user reported sessions "disappearing without notice." Investigation found the
boot purge silently marked **9 of 9 tracked sessions** dead in one sweep while their tmux windows
were still alive:

```
2026-05-27T01:12:45.648Z [SessionManager] Startup purge: removed 9 dead session(s) of 9 tracked
```

`SessionManager.purgeDeadSessions()` probes liveness with
`execFileSync(tmux has-session, { timeout: 1000 })` inside a bare `try/catch`. A timeout (tmux busy
at boot — exactly when many sessions exist and a process just restarted) throws the **same** error as
"session does not exist," and the catch treats both as dead. A 100%-purge ("9 of 9") is the fingerprint
of a systemic timeout, not nine coincidental deaths. With 3 auto-update restarts that day the boot
purge ran 3 times.

The deeper problem — and the scope of this spec, per the user's request to "make all parts of the
system that monitor and kill sessions equally robust" — is that **the decision to end a session is
made ad-hoc in eight different places**, each with its own timeout, its own (mis)handling of transient
errors, its own (missing) protected-session check, its own multi-machine blindness, and its own
(missing) user notification. A careful, recently-built reaper (`SessionReaper`) sits next to seven
cruder ones that predate its discipline.

## The robustness bar (three rules)

Every path that can autonomously end a session must satisfy:

1. **Never mistake "slow / busy / unreachable-for-a-moment / asleep" for "dead."** A failed or
   timed-out liveness probe is *indeterminate*, not *dead* — the session-lifecycle application of the
   ratified standard **"A Wall Is a Hypothesis"**: absence of a heartbeat is a hypothesis of death,
   never a proof.
2. **Never kill a session that is genuinely doing work** — idleness proven by *positive* evidence,
   never inferred from the *absence* of a signal. (With the dual backstop in §Unkillability: nothing
   is *unconditionally* immortal either — a session that fakes "work" or stays unverifiable forever
   escalates to a human decision, never silently lingers.)
3. **Never kill silently** — a genuine terminal reap of a user-facing session reaches the user
   (near-silent: a kill-to-respawn *recovery bounce* is not a disappearance and stays quiet; routine
   job cleanup lives on the pull-surface reap-log).

## Current state — the eight autonomous killers, graded

`SessionReaper` already meets rules 1–2 (every "can't tell" path → KEEP, positive-evidence idle,
protected/topic/commitment/build guards, double-confirm, dry-run). It is the gold standard. Critically,
it already funnels its kills through **`SessionManager.terminateSession()`** (SESSION-REAPER-SPEC §3.6)
— a CAS-guarded single-writer that emits `beforeSessionKill` + `sessionComplete` exactly once, checks
`protectedSessions`, guards against double-kill, and records `endedReason`. The idle/zombie kill path
already uses it too. **This existing chokepoint is the foundation of this spec.**

| # | Killer | Trigger | Kills via | Rule 1 | Rule 2 | Rule 3 |
|---|--------|---------|-----------|--------|--------|--------|
| 1 | `purgeDeadSessions` (boot) | startup sweep | inline `kill`/state | ❌ 1s timeout = dead | ❌ | ❌ silent; **not lease-gated** |
| 2 | age-limit kill | age>240m + idle | inline `kill` + `sessionComplete` | ⚠ | ❌ no topic-bound exemption | ❌ silent |
| 3 | idle/zombie kill | idle > threshold | `terminateSession('idle-zombie')` ✅ | ✅ | ✅ topic-bound grace | ❌ silent |
| 4 | `isSessionAliveAsync` (shared) | — | n/a (liveness only) | ⚠ 5s timeout = dead | n/a | n/a |
| 5 | `SessionWatchdog` | child proc "stuck" 3m+ | inline `kill-session` | ⚠ LLM+stdin guards | ⚠ | ⚠ event, delivery not guaranteed; no protected check |
| 6 | `OrphanProcessReaper` | orphan proc > 60m | inline `kill` | ⚠ age-based | ❌ age only; **prefix-matches** | ⚠ mostly silent |
| 7 | `QuotaManager`/`SessionMigrator` | 95% 5h quota | `killSession` | n/a hard constraint | ❌ no work gate | ⚠ queued |
| 8 | `SessionRecovery` (×4) | JSONL stall/crash/loop | `killSession`→respawn | ❌ JSONL age ≠ frozen | ❌ no process cross-check | ❌ silent (but **bounce**, not disappearance) |
| 9 | `JobScheduler` wake-reaper | wall-clock>expected×2 | `killSession` | ❌ counts sleep as runtime | ❌ | ❌ silent |
| — | `CrashLoopPauser` | crash loop | — (disables jobs) | n/a | ✅ | ✅ |

(Line numbers drift — grep the named methods. Verified against `JKHeadley/main` @ v1.3.26.)

## Design — one authority, five shared primitives

The fix is to **make `terminateSession()` the single ReapAuthority** every killer routes through, and
to extract `SessionReaper`'s discipline into shared, reusable primitives the authority enforces. After
this change, an individual killer cannot end a session on its own — it *signals* a kill request (with a
reason and disposition) and the authority, holding full context, decides. This is the structural
resolution of Signal-vs-Authority (no longer a deferral — see Convergence round 1, L1/SE-10).

### P0 — `terminateSession()` is the sole kill chokepoint (ReapAuthority)

Every kill in killers #1, #2, #5, #6, #9 (and #7/#8 below) routes through `terminateSession()`. The
inline `tmux kill-session` + manual `status=...` mutations in those paths are removed. `terminateSession`
gains:
- a `disposition: 'terminal' | 'recovery-bounce'` parameter (explicit — never inferred from ambient
  state; the caller declares it). SessionRecovery/version-skew/context-exhaustion pass
  `'recovery-bounce'`.
- a mandatory **ReapGuard (P2)** consultation *inside* the authority: if the guard returns a KEEP
  reason, the terminate is a no-op `{ terminated:false, skipped:<reason> }`. A killer can request, but
  the authority refuses to kill a guarded session — even a buggy killer cannot bypass the guard.
- emission of a single **`sessionReaped`** event `{ session, reason, disposition, keptReason? }` at the
  one chokepoint (P3). It already emits `beforeSessionKill`/`sessionComplete`; `sessionReaped` joins
  them. Routing inline kills here also *restores* the `sessionComplete` emission the inline age-limit
  path fired, so no listener regresses.
- a **lease-holder gate**: an **autonomous-reap** terminate on a standby (non-awake) machine is a no-op
  `skipped:'not-lease-holder'`. Only the awake/lease-holding machine may autonomously reap; this also
  dedupes notifications. **Operator-initiated kills bypass the lease gate unconditionally** — origin is
  an explicit `origin: 'operator' | 'autonomous'` argument **defaulting to `'autonomous'` when omitted**
  and stamped `'operator'` only by the (Bearer-authed) HTTP route layer — in-process autonomous killers
  call `terminateSession` directly and therefore cannot mint `'operator'`; origin is **never inferred
  from the reason string** (a misclassified or mid-handoff operator kill must never be silently dropped
  — the user clicks "kill" and it must happen). Every terminate that is skipped for *any* reason
  (`not-lease-holder`, a KEEP, in-flight, protected) is recorded as a `skipped` entry in the reap-log
  (P4), so a dropped kill is never invisible.
- **re-entrancy ordering (explicit):** the ReapGuard reads the in-flight reap-lock (`isReaping`) state
  *as of authority entry*; the authority acquires its own CAS/in-flight lock **after** the guard
  clears — so the authority's own lock for the kill it is performing is never misread by the guard as a
  KEEP for that same kill.

The inline-removal + funnel-routing for each killer lands as **one atomic commit per killer** so a
revert is all-or-nothing (no double-emit window).

### P1 — `SessionLivenessOracle` (tri-state, fast, never "dead" on doubt)

```ts
type Liveness = 'alive' | 'dead' | 'indeterminate';
```

- **`dead` requires two facts together:** (a) the tmux **server is reachable** (a single
  `tmux list-sessions` succeeds) AND (b) the session's **canonical id is absent from that list**
  (exact full-id match — never a prefix match, never inference from an unrecognized error string or
  exit code; this closes the version-drift / name-collision / sibling-prefix false-positive).
- **Everything else → `indeterminate`:** a timeout, tmux-server-unreachable, `ENOENT`/`EPIPE`, or any
  unrecognized failure. **Never transition a session to killed on `indeterminate`** (enforced in code
  at the authority).
- **Performance contract (must, not should):** the oracle is **async** (`execFileAsync`) — never
  `execFileSync` on the boot path. Liveness is resolved from **one** `tmux list-sessions` for the whole
  set; only sessions *absent* from that list get an individual `has-session` re-probe (≥5s + one
  backoff retry). Individual re-probes run at **bounded concurrency (N=6)**. A **total boot-probe
  wall-clock cap (8s)** applies: any session unresolved at the cap is left `indeterminate` and finished
  by the first monitoring tick — boot never blocks on slow probes. A **short-TTL (3s) shared liveness
  cache** means multiple killers in one tick never re-probe the same session.

This single primitive backs killers #1 and #4 and would have prevented the entire 2026-05-27 incident
(boot purge becomes: resolve from `list-sessions`; `dead` → terminate; `indeterminate`/`alive` → keep).

### P2 — `ReapGuard` (stateless positive-evidence KEEP-checks, extracted from `SessionReaper`)

A reusable, injectable guard the authority consults immediately before any autonomous kill:

```ts
function reapBlockedReason(session): ReapKeepReason | null; // KEEP reason, or null = safe to reap
```

Scope is the **stateless** guards from `SessionReaper.evaluate()` only — protected → recovery-active
veto → relay-lease-active → pending-injection → open-commitment (topic-bound) → recent-user-message
(topic-bound; unresolved-topic → KEEP) → build/autonomous-active → active child process →
main-process CPU/IO (uninspectable → KEEP) → **in-flight reap lock** (`isReaping`). The **stateful**
checks (transcript-growth delta, positive-idle proof) **stay inside `SessionReaper.evaluate()`**, which
calls the shared guard first and then layers its own per-instance `obs`-backed checks. A wiring test
asserts `SessionReaper.evaluate()` returns identical `keptBy` reasons post-extraction.

Cheap-first ordering is **normative**: in-memory checks (protected, recovery flag, commitment, lease)
run before any subprocess fork (capture-pane / `ps`); guard inputs are **memoized per session per
tick** behind the P1 short-TTL cache. The guard is consulted **only immediately before a kill
decision**, never speculatively for every session every tick.

### P3 — `sessionReaped` event + one coalescing listener

`terminateSession` emits `sessionReaped` exactly once. One listener (in `server.ts`, beside the
existing kill listeners) turns a `terminal` reap of a user-facing/topic-bound session into a user
notice routed to the bound topic (or lifeline topic if unbound). `recovery-bounce` reaps emit the
event but the listener stays **silent**. **Coalescing (SE-7):** terminal reaps within a short rolling
window (60s) collapse into ONE consolidated lifeline message (single shared timer; bounded buffer
≤100, drop-oldest). The consolidated message states the **total count** ("N sessions reaped in the
last 60s; showing latest 100 — full list in the reap-log"), so a mass-reap burst that overflows the
buffer is never under-reported (the reap-log P4 has the complete record regardless). Isolated
topic-bound reaps notify per-session. **Sanitization (mandatory):** the
notice routes through the existing Telegram HTML-escaping path — session names (which follow
user-controlled topic renames) and reasons are treated as **literal text**, never markup.

### P4 — reap-log (ships in Phase 1, not deferred)

A pull-surface audit: `GET /sessions/reap-log` returns every reap `{ ts, session, reason, disposition,
keptReason?, machine }`. **Bearer-auth required** (stated explicitly, like every non-`/health` route);
**read-only** (no write methods); backed by a JSONL sink mirroring `sentinel-events.jsonl`, written
with **JSON encoding** (never raw string concat — closes newline-injection of names/reasons). It
satisfies the **Observability** standard ("you can't tune what you can't see") and gives the dashboard a
"why did my session vanish?" answer. Shipping it triggers **Agent-Awareness** (CLAUDE.md template +
capabilities index) and a `migrateConfig` entry in the **same** phase — not deferred.

### P5 — Unkillability backstop (nothing is unconditionally immortal)

Rules 1–2 are deliberately conservative, which creates a dual risk the round-1 review surfaced:
(a) a session that *fakes* work (a tight CPU loop, or an ever-growing transcript with no prompt return)
is KEPT by every killer forever; (b) a session stuck `indeterminate` forever leaks resources. Both are
resolved by a single staleness escalation — **never an auto-kill:**

- The authority/guard tracks, per session: consecutive `indeterminate` probes, and a **no-forward-
  progress** clock. Forward progress is **not** raw byte-count growth — a wedged session that appends a
  heartbeat byte (or a stuck tool-loop that logs) every 29 minutes would defeat a naive "any growth"
  gate forever, which is exactly the absence-of-signal inference rule 2 forbids. Instead, "stale" =
  *neither* of: (i) **meaningful** transcript advance (delta ≥ a config `progressFloorBytes`, default
  512B, **and** the new content is not a repeat of the prior tail — guards the heartbeat/loop case),
  *nor* (ii) main-process CPU above an idle floor, *nor* (iii) a change in the positive-idle/prompt
  state SessionReaper already computes. After **M=30 min** (config `unverifiableEscalateMinutes`) of
  no-forward-progress, or **N=15** consecutive `indeterminate` probes (config
  `indeterminateEscalateCount`), a **single deduped Attention-queue item** is raised ("session X
  unverifiable / stale-but-unkillable for M min — investigate / force-kill?") for an operator decision.
  Dedupe is **per episode**, and `indeterminate` due to a *server-unreachable* cause raises **one
  global** "tmux control-plane unreachable" item, not one per session (anti-flood).
- **Spawn-cap exclusion:** long-`indeterminate` sessions are excluded from the **absolute**
  `maxSessions × 3` cap (they count only toward the soft scheduler cap), so a fleet of unverifiable
  panes can never lock a human out of spawning — the death-spiral the original purge guarded against
  cannot relocate here. (SE-3:) the scheduler's "indeterminate = occupied" slot projection applies only
  within a short staleness window, after which it re-probes — an unreachable tmux never freezes all
  scheduling.

## Per-killer remediation

- **#1 boot purge** — P1 oracle (async, single `list-sessions`, bounded, capped); `dead`-only;
  lease-gated; routes terminate through P0.
- **#2 age-limit kill** — consult P2 (gains topic-bound grace); route through P0 (restores
  `sessionComplete`, gains `sessionReaped`).
- **#3 idle/zombie kill** — already via `terminateSession`; gains P2 + `disposition:'terminal'`.
- **#4 `isSessionAliveAsync`** — back with P1; **two documented projections** for its consumers
  (SE-3): *reaping* treats `indeterminate` as "keep"; *scheduler slot-counting/health* treats it as
  "occupied" but only within the staleness window, then re-probes.
- **#5 watchdog** — keep LLM gate + stdin guard; consult P2 before its final level; route kill through
  P0 (gains protected check + notify).
- **#6 orphan reaper** — **exact-id** match (no prefix); add P2 work check (60m age = necessary, not
  sufficient); route through P0.
- **#7 quota/migrator** — quota keeps final authority (hard constraint); add a *bounded* P2-style soft
  check that gives build/autonomous-active topics **one** extra Ctrl-C grace round before force-kill,
  **disabled above a config ceiling** so it can never push real usage to 100%/lockout (SE-9); route
  through P0 for notify. Force-kill is `tier1`-supervised (it's a policy decision).
- **#8 SessionRecovery** — add a P1/P2 cross-check before kill-to-respawn (a still-progressing process
  is KEEP regardless of JSONL age); tag `disposition:'recovery-bounce'` (silent). The recovery flag is
  written **synchronously / CAS** before any kill-eligible evaluation so a same-tick reaper sees the
  veto (SE-4/SE-5).
- **#9 wake-reaper** — gate through P1/P2 (a progressing process is KEEP regardless of clock); the
  sleep-subtraction becomes **advisory only** and uses **cumulative** wall-time-asleep-during-run, not a
  single last `sleepDurationSeconds` event (SE-8); route through P0.

## Bonus — session label follows topic rename

When the user renames a Telegram topic, update the bound session's **display `name` only** (never the
`tmuxSession` key or `id` — verified no lookups key off the display name). On the existing topic-rename
signal. Low-risk; the renamed value is user-controlled and therefore flows through the same P3
sanitization wherever it surfaces.

## Multi-machine

Reaping is **awake-machine-only**, enforced at the P0 authority (lease-holder gate), not per-killer.
The boot purge — today called unconditionally before any `isAwake` check — is moved behind the same
gate. `sessionReaped` notices are emitted only by the lease holder, so a handoff cannot double-notify.
A standby machine's killers may still *detect and signal* but the authority no-ops their terminate.

## Supervision (LLM-Supervised Execution)

- **P1 oracle, P2 guard:** `tier0` — pure data probes with no policy judgment; justified because they
  only *gather* facts (alive/dead/keep) and never decide a user-visible action alone.
- **P3 reap-notification disposition** and **#7 quota soft-check:** `tier1` — they make a policy call
  (notify-or-not / grace-or-kill); a Haiku-class validation wraps the decision.

## Migration parity

- P0–P2, P5, and the kill paths are server-side TypeScript — ship with the server; no migrator needed
  for code.
- New config defaults (`liveness.probeTimeoutMs`, `liveness.probeRetries`, `liveness.bootCapMs`,
  `liveness.cacheTtlMs`, `reapNotify.enabled`, `reapNotify.coalesceWindowMs`,
  `unverifiableEscalateMinutes`, `indeterminateEscalateCount`, `progressFloorBytes`, quota soft-check
  ceiling) go in
  `migrateConfig()` additively (existence checks) **and** are validated at startup alongside the
  existing multi-machine config validation — a sub-floor/0ms probe timeout is rejected (it would
  re-create the death spiral), retries ≥ 0, caps > 0.
- P4 reap-log endpoint → Agent-Awareness: CLAUDE.md template (`generateClaudeMd()`) + capabilities
  index, same phase.

## Testing (three tiers, both sides of every boundary) + reproduce-before-claim

- **Unit:** P1 returns `indeterminate` (not `dead`) on simulated timeout / unreachable tmux, and `dead`
  only on server-reachable + exact-id-absent; never on prefix match or unknown error. P2 returns a KEEP
  reason for each guard and `null` only when all clear; cheap-first ordering verified. P5 escalates to
  Attention (never auto-kills) after N/M; spawn-cap exclusion holds. Wake-reaper cumulative-sleep math.
  Notice sanitization escapes a malicious topic name; reap-log line is valid JSON for a newline-laden
  reason.
- **Integration:** through the real HTTP/event path — a terminal reap emits exactly one (coalesced)
  notice; a `recovery-bounce` emits none; protected + lease-non-holder + guarded sessions survive every
  killer; `GET /sessions/reap-log` requires Bearer and is read-only.
- **E2E ("feature is alive"):** a real slow/busy session at server boot is NOT purged (reproduces the
  2026-05-27 incident and proves it cannot recur); a genuinely-dead session still is; `terminateSession`
  wiring test asserts `SessionReaper.evaluate()` `keptBy` reasons unchanged post-extraction; the
  resume-UUID `beforeSessionKill` listener is asserted idempotent (SE-5).
- **Reproduce-before-claim (evidence bar):** before "fixed," reproduce the false-purge on a real boot
  with a deliberately-slowed `has-session` and watch the live session survive; watch one terminal reap
  deliver exactly one Telegram notice. Green tests are necessary, not sufficient.

## Rollback

Each primitive is additive and independently revertable; P0/P1/P2 only make killing *more* conservative
(failure mode: a dead session lingers one extra tick — caught next tick, far cheaper than killing a live
one). P3 notify and P4 reap-log have config flags. Each killer's funnel-routing is one atomic commit.

## Convergence round 1 — what the review changed (ELI10)

Justin approved the original draft; the convergence round (5 internal reviewers + the constitution
conformance gate) then **strengthened** it materially. The biggest changes:

- **From "guard as a floor" to "one real authority."** The original kept all eight killers able to kill
  on their own, with the shared guard only advisory — which the conformance gate + lessons-aware
  reviewer both flagged as a Signal-vs-Authority violation the draft had self-approved past. The
  rewrite routes every kill through the existing single-writer `terminateSession()`, which now *holds*
  the guard — so a killer can only *ask*, and the authority decides. The deferral is gone.
- **Multi-machine safety was entirely missing.** Reaping is now awake-machine-only, so a standby can't
  reap the active machine's sessions or double-notify.
- **Boot speed.** The conservative probing, done naively, would have blocked boot for ~100s with 9
  sessions — re-creating the very death spiral we're fixing. Now: one `list-sessions`, bounded
  concurrency, an 8s hard cap, async throughout.
- **Nothing is immortal either.** A session faking work, or stuck "can't tell" forever, now escalates to
  a single operator decision (never an auto-kill) and is kept out of the hard spawn cap, so it can't
  lock the user out.
- **The reap-log ships now** (was an open question) — observability is a standard, not a nice-to-have —
  with auth + injection-safe encoding.
- **Supervision tiers declared**, input sanitized, config validated at startup, exact-id matching.

This rewrite addresses every material round-1 finding; a round-2 convergence pass confirms no new
material issues (see convergence report).

## Open questions (for Justin — the only two left)

1. **Terminal-reap notice on by default?** Recommendation: **on**, coalesced and routed to the
   bound/lifeline topic only — a genuine terminal reap of a session the user was using is exactly the
   "actionable" class that should reach them, unlike housekeeping. (Config flag either way.)
2. **Quota at 95% (#7):** force-kill a mid-build topic, or give build/autonomous-active topics one extra
   grace round (bounded, ceiling-capped)? The spec implements the bounded-grace option as default;
   confirm the quota-vs-lost-work tradeoff is acceptable.

(Open question 2 from the draft — "ship a reap-log?" — is resolved: yes, P4, Phase 1.)

## Suggested phasing (one approval → chained merges, no fragmentation)

- **Phase 1 (incident + authority + backbone):** P0 authority (funnel #1/#2/#3 + disposition +
  sessionReaped + lease gate), P1 oracle + boot-purge fix, P2 ReapGuard extraction, P3 notify seam +
  listener, P4 reap-log (+ Agent-Awareness), P5 backstop. Closes the reported bug and establishes the
  single authority. (Larger than the original Phase 1 because the authority + backstop are now in
  scope — but they are what make the fix correct rather than cosmetic.)
- **Phase 2 (bring remaining killers onto the authority):** #5 watchdog, #6 orphan (exact-id), #8
  recovery cross-check, #9 wake-reaper.
- **Phase 3 (quota + polish):** #7 quota bounded soft-check + label-rename.
