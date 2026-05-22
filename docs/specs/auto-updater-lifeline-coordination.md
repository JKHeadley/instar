---
title: Auto-updater ↔ lifeline restart coordination + structural no-deferrals enforcement
date: 2026-05-22
author: echo
review-convergence: tactical-hotfix-2026-05-22
approved: true
approved-by: Justin
approved-via: Telegram topic 5447 ("Thanks, yes please do" at 2026-05-22 10:10 PDT, in response to my diagnostic of the b2lead-insights regression report)
eli16-overview: auto-updater-lifeline-coordination.eli16.md
---

# Spec — Auto-updater ↔ lifeline restart coordination + no-deferrals enforcement

**Date:** 2026-05-22
**Author:** echo
**Status:** in-flight (approved 2026-05-22 in topic 5447)
**Triggering incidents:**
- b2lead-insights, 2026-05-19 → 2026-05-20 (21h ingress drop)
- b2lead-insights regression, 2026-05-20 → 2026-05-22 (46h ingress drop) — the failure class PR #284 explicitly deferred

## Background

PR #284 (2026-05-20) shipped four of the five fixes the b2lead-insights post-incident report requested. The fifth — *"lifeline auto-restart on server upgrade"* — was explicitly marked as **"Out of scope today"** in PR #284's spec under the section "Forward note (NOT in this PR)." Two days later that exact deferral produced the same failure class with the same agent.

The mechanic:
- AutoUpdater installed v1.2.0 → v1.2.28 over ~46 hours (27 minor releases).
- Each apply wrote `state/restart-requested.json` → ForegroundRestartWatcher → server restarts.
- The **lifeline process** was never signaled. It kept running v1.1.0 binary (the version current when it last started, May 20 17:51 UTC).
- v1.1.0 lifeline lacks PR #284's fixes — its versionSkew cooldown blocks restart, its replay loop drops messages after 3 failures.
- 426 from `/internal/telegram-forward` → restart suppressed → messages dropped silently.

**The fix that prevents this entire class:** when AutoUpdater applies an update crossing major.minor, signal the lifeline to restart alongside the server. Two days ago Justin approved this PR scope with one additional constraint:

> "Our development work should focus on COMPLETE features/fixes with NO deferrals."

This spec ships:
1. The mechanical fix (auto-updater ↔ lifeline coordination).
2. A second-channel signal (server-side write on 426) so the fix is self-redundant.
3. A one-time migration so currently-stuck agents recover on next update.
4. A structural enforcement: instar-dev pre-commit blocks specs that contain orphan "deferred / out of scope today" language.
5. Agent awareness: CLAUDE.md template tells future agents what's happening.

## Goal

After this ships:

- Every AutoUpdater apply that crosses major.minor triggers a lifeline restart in the same atomic transaction as the server restart.
- A surviving v1.1.0-style lifeline that posts `/internal/telegram-forward` and gets 426 produces a server-side signal that respawns the lifeline within one watchdog tick (~30s).
- No future PR can ship a spec with the phrase "out of scope today" / "deferred" / "follow-up" / "preemptive fix" / "NOT in this PR" unless each instance is linked to an explicit tracked commitment with owner + date.
- Currently-stuck agents on pre-PR-#284 lifelines self-recover on the next update cycle without manual SIGKILL.

## Scope (must-haves — all in this PR)

### Change 1 — AutoUpdater detects major.minor crossing and signals lifeline restart

**File:** `src/core/AutoUpdater.ts` (around `gatedRestart` / `requestRestart` ~line 526–700) + `src/core/UpdateChecker.ts` (apply path).

Compute `crossesBreaking(prev, next)`:

```ts
function crossesBreaking(prev: string, next: string): boolean {
  const [pMaj, pMin] = prev.split('.').map(n => parseInt(n, 10));
  const [nMaj, nMin] = next.split('.').map(n => parseInt(n, 10));
  return pMaj !== nMaj || pMin !== nMin;
}
```

In `AutoUpdater.requestRestart`, after writing `state/restart-requested.json`, also write `state/lifeline-restart-requested.json` whenever `crossesBreaking(previousVersion, targetVersion)` is true:

```json
{
  "requestedAt": "<ISO>",
  "requestedBy": "auto-updater",
  "reason": "version-bump-crossing-major-minor",
  "previousVersion": "1.1.0",
  "targetVersion": "1.2.28",
  "expiresAt": "<ISO + 1h>"
}
```

Atomic via tmp + rename. Idempotent — if file already exists with same `targetVersion`, skip.

### Change 2 — Lifeline consumes the signal file every tick

**File:** `src/lifeline/TelegramLifeline.ts` — extend the existing watchdog tick (already runs every 30s).

On every tick, `fs.statSync(stateDir + '/state/lifeline-restart-requested.json')`. If present AND `expiresAt > now` AND `targetVersion !== this.lifelineVersion`:

```ts
this.initiateRestart('plannedUpgrade', 'auto-updater-version-bump', {
  previousVersion: signal.previousVersion,
  targetVersion: signal.targetVersion,
});
```

Add new bucket `plannedUpgrade` to `RestartBucket` type in `src/lifeline/rateLimitState.ts`. `decide()` treats this bucket the same as `versionSkew` (cooldown-bypass, daily cap as safety net) — both are hard incompatibility signals, not transient errors.

The lifeline DELETES the signal file as the first step of `initiateRestart` so a respawned lifeline doesn't see a stale signal and self-restart again. The restart-orchestrator's pid-based serialization is the backstop.

### Change 3 — Server-side belt-and-suspenders: 426 path writes the signal

**File:** `src/server/routes.ts` `/internal/telegram-forward` handler — around the 426 response path (~line 8228).

When the server returns 426 (major.minor mismatch with the requesting lifeline), it ALSO writes `state/lifeline-restart-requested.json` with `requestedBy: "server-426"`. This covers the case where AutoUpdater is in a weird state (deferred restart, lockfile race, etc.) — the running server has direct evidence the lifeline is the wrong version and signals authoritatively.

Idempotency: if a fresh signal already exists with matching `targetVersion`, skip the write.

### Change 4 — PostUpdateMigrator nudges currently-stuck lifelines

**File:** `src/core/PostUpdateMigrator.ts`.

New `migrateStaleLifelineSignal(result)`:

1. Read `state/lifeline-started-at.json` (the version the lifeline reports it's running). If it's missing or matches current package.json version, skip.
2. If `crossesBreaking(lifelineVersion, currentServerVersion)` is true → write the lifeline-restart-requested.json signal with `requestedBy: "post-update-migrator-bootstrap"`.
3. Idempotent: only fires if the signal isn't already present.

This is the one-time bootstrap that unsticks agents already on broken lifelines — they don't need to have today's Change 2 already running, because the next time their lifeline goes through any normal restart (or the next time their AutoUpdater applies an update), the migrator runs and writes the signal. The post-PR-#284 lifeline code (which is on-disk in v1.2.28) picks it up the moment it next ticks.

For agents whose lifeline is so wedged it never ticks: the migrator's signal write triggers `ServerSupervisor` to also see the signal (Change 5 below) and kill+respawn the lifeline directly.

### Change 5 — Fleet watchdog watches the signal as a third (out-of-process) channel

**File:** `src/templates/scripts/instar-watchdog.sh` (the fleet watchdog shipped 2026-05-17 in PR #245).

The ServerSupervisor lives inside the lifeline process — if the lifeline's event loop is wedged, the supervisor's loop is wedged too. A genuinely-third channel must live OUTSIDE the process. The fleet watchdog (a separate launchd job that runs every 5 minutes) is the right home.

Add a new heal step to the watchdog: for every loaded agent with a `state/lifeline-restart-requested.json` file whose `expiresAt > now` AND `requestedAt < now - 60s` (signal is at least 60s old and the lifeline hasn't acted), force-restart via launchd bootout/bootstrap. Then delete the signal so the next cycle doesn't re-fire.

Three independent channels (AutoUpdater write → Lifeline tick read; Server 426 write → Lifeline tick read; PostUpdateMigrator write → Fleet watchdog force-restart) make a single missed signal impossible. The fleet watchdog already iterates over all agents and runs out-of-process, so it can break a wedged lifeline that the in-process channels cannot.

### Change 6 — Structural enforcement: instar-dev deferrals check

**File:** `scripts/instar-dev-precommit.js`.

After Step 7 (ELI16 overview check) add a deferrals scan:

1. Read the spec referenced by the trace (already located in Step 6).
2. Search for orphan deferral patterns case-insensitively:
   - `\bdeferred?\b` (not preceded by "no " or "non-")
   - `out of scope today\b`
   - `out of scope for now\b`
   - `\bfollow[- ]ups?\b` not on a line linking to an issue or commitment ID
   - `\bpreemptive fix\b` outside a "tracked" context
   - `not in this PR\b`
3. For each hit, require either:
   - A `<!-- tracked: <ISSUE-ID or commit-action ID> -->` HTML comment within 200 chars after the hit, OR
   - A frontmatter `deferrals-tracked` field that the spec explicitly affirms (a one-line wave-through for specs whose entire deferral catalog is in-scope or absorbed elsewhere).
4. If no tracked-marker found, block the commit with a message naming the file + line.

The check is opt-out via `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1` for the bootstrap commit itself, but the hook logs every use of that override to `.instar/instar-dev-traces/orphan-deferral-overrides.jsonl` for visibility.

**File:** `skills/instar-dev/SKILL.md` — add a "Phase 4.5 — Deferrals check" section explaining the rule and the why (today's incident).

**File:** `src/core/PostUpdateMigrator.ts` — `migrateInstarDevPrecommit()` migration that updates the script on existing agents.

### Change 7 — Agent Awareness: CLAUDE.md template update

**File:** `src/scaffold/templates.ts` (`generateClaudeMd`).

New section: "Version-skew self-recovery". Tells agents:
- When server auto-updates, lifeline restart is coordinated automatically.
- If you ever see "Heads up: my server auto-updated …" Telegram alert, ingress is paused but messages are not lost; the lifeline restart is in-flight.
- The signal file `state/lifeline-restart-requested.json` is purely managed by infrastructure — agents never read or write it directly.

Migrator entry `migrateVersionSkewSection()` so existing agents pick this up on next update.

### Change 8 — Tests (all three tiers, REAL APIs, NO mocks-only)

**Unit:**
- `tests/unit/core/auto-updater-major-minor-crossing.test.ts` — covers `crossesBreaking(prev, next)` across the boundary matrix (same/minor/major/empty/malformed inputs).
- `tests/unit/lifeline/lifeline-restart-signal.test.ts` — signal-file shape + atomic write + idempotent skip.
- `tests/unit/instar-dev-precommit-deferrals.test.ts` — orphan deferral patterns, tracked-marker recognition, override flag behavior.
- `tests/unit/lifeline/rateLimitState.test.ts` — plannedUpgrade bucket bypasses cooldown.

**Integration:**
- `tests/integration/auto-updater-lifeline-handshake.test.ts` — spawn a temp project, simulate apply with crossesBreaking → assert both signal files written → assert TelegramLifeline test harness consumes lifeline signal and exits with restart code.
- `tests/integration/post-update-migrator-stale-lifeline.test.ts` — fixture project with `lifeline-started-at.json` at old version → migrator writes the signal.

**E2E (Tier 3 — feature is alive):**
- `tests/e2e/version-skew-end-to-end.test.ts` — reproduces the b2lead scenario: spawn server at vX, lifeline at vX, auto-update server to vY (crossesBreaking=true), confirm Telegram forward stops failing within one watchdog cycle. The `/health` route must return 200 with no degradations after recovery; the user-visible Telegram alert MUST have fired exactly once.

### Change 9 — Cross-model review + side-effects artifact + ELI16 + NEXT.md

All shipped in this PR, no exceptions. Cross-model review via `/crossreview` on the spec — GPT/Gemini/Grok perspectives folded into the side-effects artifact before commit.

### Change 10 — Migration parity sweep

Every agent-installed file touched gets a `PostUpdateMigrator` entry. No new feature reaches new agents only.

## Deferrals tracked

Per the new rule (Change 6), this section enumerates every related thing that COULD be deferred and confirms it's IN-SCOPE for this PR. No orphans.

- ~~AutoUpdater→lifeline coordination~~ — in scope (Change 1+2).
- ~~Server-side belt-and-suspenders~~ — in scope (Change 3).
- ~~Migration to unstick existing agents~~ — in scope (Change 4).
- ~~Supervisor force-restart channel~~ — in scope (Change 5).
- ~~Structural no-deferrals enforcement~~ — in scope (Change 6).
- ~~CLAUDE.md template update~~ — in scope (Change 7).
- ~~All three test tiers~~ — in scope (Change 8).
- ~~Cross-model + side-effects review + ELI16 + NEXT.md~~ — in scope (Change 9).
- ~~Migration parity for all touched agent-installed files~~ — in scope (Change 10).

The v3 Remediator's eventual absorption of this signal-file orchestration is the ONE forward-note. It's tracked in topic 3079 (the Remediator approval thread on 2026-05-13) with active development underway; absorption is mechanical when Tier 3 lands. <!-- tracked: topic-3079-v3-remediator -->

## Non-goals

- Changing the v3 Remediator design (separate project, separate approval).
- Adding new outbound message authority — all Telegram alerts continue through `MessagingToneGate` via `/attention`.
- Auto-recovering from genuine corruption of the signal file (corrupt file → log + ignore; the next cycle writes a fresh one).

## Signal-vs-authority compliance

| Component | Signal or Authority | Reason |
|-----------|--------------------|--------|
| `crossesBreaking(prev, next)` | Signal | Mechanical predicate. |
| AutoUpdater signal write | Signal | File-write is mechanic; consumer decides. |
| Server 426 signal write | Signal | Same. |
| PostUpdateMigrator signal write | Signal | Same. |
| Lifeline tick consumer | Authority (decides to restart) | Existing orchestrator pattern — bounded mechanic. |
| ServerSupervisor force-restart | Authority (bounded recovery primitive) | SIGTERM → 3s → SIGKILL is bounded; not a judgment call. |
| `plannedUpgrade` bucket cooldown bypass | Mechanic | Same shape as `versionSkew` bucket from PR #284. |
| instar-dev deferrals regex | Detector → block authority | But this is a hard-invariant validator at the boundary (akin to typing checks), which the principle explicitly exempts. The regex blocks malformed input, not judgment calls. |

No new judgmental gates over message content or agent intent.

## Acceptance criteria

1. `crossesBreaking('1.1.0', '1.2.28') === true`, `('1.2.0', '1.2.28') === false`, `('1.1.0', '2.0.0') === true`.
2. AutoUpdater apply with crossesBreaking=true writes both `restart-requested.json` AND `lifeline-restart-requested.json` atomically.
3. TelegramLifeline tick reads the signal and calls `initiateRestart('plannedUpgrade', ...)` exactly once.
4. `rateLimitState.decide(state, 'plannedUpgrade', now)` allows even within `WATCHDOG_COOLDOWN_MS`.
5. Server `/internal/telegram-forward` 426 path writes the signal idempotently.
6. PostUpdateMigrator on a fixture project with stale lifeline-started-at writes the signal.
7. ServerSupervisor force-restarts a lifeline whose tick hasn't run within 60s of a signal write.
8. `scripts/instar-dev-precommit.js` blocks a commit referencing a spec with orphan "deferred" / "out of scope" language; allows it when each instance has a `<!-- tracked: ID -->` marker or the frontmatter waves it through.
9. E2E: server vX + lifeline vX → auto-update to vY (crossing major.minor) → forward succeeds within 60s → no message dropped → user-visible alert fired exactly once.

## Rollback

Every change is independently revertable. The signal-file convention is purely additive (writers + readers; no existing file format changes). The deferrals check defaults to opt-in for the bootstrap commit, then becomes mandatory.
