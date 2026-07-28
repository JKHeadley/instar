# MESH-SELF-HEAL G2 — Build Plan (nobody-polling detector + single-claimant recovery)

Drives the G2 increment of `MESH-SELF-HEAL-SPEC.md` (already converged + approved; parent-principle "Cross-Machine Coherence"). Rollout order: G3 (done, shipped dark, live-verified observe-mode) → **G2 (this)** → G1. Ships DARK + dryRun-first behind a new flag, exactly like G3.

## Why G2 (the live motivation, 2026-06-27)
The mesh on the Mini+Laptop pair is in the exact state G2 detects: Laptop (`m_cc2ec651`) holds the lease + is preferredAwake but `awakeMachineCount=0` (zombie holder, not polling); Mini (`m_4cbc0d4a`) is standby. G3 prevents DUPLICATES but does nothing about the DROPS this causes. G2 is the silent-loss backstop: detect "nobody is polling Telegram" and force exactly ONE fit machine to take poll-ownership.

## Reuse, do NOT reinvent (spec §3.2, finding Int2-A)
- **`src/core/pollerCount.ts` (B5)** already computes `ok`/`dual`/`silence`/`indeterminate` from `pollingActive` truth, already wired in `routes.ts`. G2's condition REDUCES over B5 — not a new boolean fold:
  - B5 `silence` persisting across `nobodyPollingConfirmObservations` ⇒ the nobody-polling condition (confirm-obs so a normal handoff gap never trips it — finding Adv-F9).
  - B5 `indeterminate` (dark/unknown peer) ⇒ **fail-CLOSED, no claim**.
  - B5 `dual` (two pollers) ⇒ **VETO any G2 claim** (claiming into dual IS the 409 poll-war G2 prevents).
- **Fenced lease epoch-CAS** = the same authority that gates the lease (reuse, not a parallel mechanism).
- **`poll-follows-lease` / `effectivePollIntent` lever in `TelegramLifeline.ts`** = the actuation seam (start winner's getUpdates, stop loser's). Do NOT build a new poll start/stop path.
- **`lifeline-poll-active.json`** = the post-claim live-verify target (confirm the winner's poll actually ADVANCES — FD10 server-intent ≠ lifeline-actual, applied to actuation).

## The algorithm (spec §3.2 — single-claimant, NOT each-machine-decides)
1. Detector tick reads B5 over the pool. `silence` persisting ⇒ nobody-polling episode.
2. **Single claimant chosen deterministically:** the F4-preferred-awake machine IF it is itself fit, ELSE the lowest-machineId fit machine (finding DC-OQ2). NOT each machine independently deciding "am I fit?" (that's the split-brain double-poll bug).
3. Claimant acquires poll-ownership by **winning the fenced epoch-CAS**.
4. **CAS-win is necessary but NOT sufficient (Adv2-F1):** after winning, the claimant RE-VERIFIES its OWN live `pollSucceededMonoMs` freshness (current, local) before serving. On self-unfit: immediately relinquish the epoch (signed tombstone + G1 quiesce) AND advertise `pollFresh:false` + `selfExcludedThisEpisode` in its signed heartbeat (Adv3-F-A — so peers' next election skips it at once instead of re-nominating the lagged set). Bounded by `confirmObservations` (no ping-pong).
5. **Actuation:** winning drives `poll-follows-lease`/`effectivePollIntent` to START winner's getUpdates + STOP loser's; **post-claim live-verify** confirms `lifeline-poll-active.json` advances. Loser stands down on observing the higher epoch (≤1 tick).
6. **Escalation:** signal-only, toward NOT-escalating (alarm-fatigue is the failure mode) — confirm-observations + dedup. (spec §8 fail-direction table.)

## Fail directions (committed, spec §8)
- Nobody-polling escalation: toward NOT-escalating (signal-only; confirm-obs + dedup).
- Global-blindness (can't hear any peer): does NOT satisfy "Telegram down for everyone" (Adv2-F2). Requires POSITIVE peer evidence (a fresh signed heartbeat from ≥1 live peer that ALSO reports pollSucceeded-stale) to HOLD. Absent that, a pollAttempted-fresh + pollSucceeded-stale holder is LOCAL failure → proceed toward relinquish (safe direction) and let G2 pick a server.
- `indeterminate` ⇒ fail-closed (no claim). `dual` ⇒ veto claim.

## Observability (spec §3 Observability)
- `/health → multiMachine.syncStatus` gains `pollOwned`, `pollFresh`, per-machine job-liveness ages, `nobodyPollingEpisodes`.
- `logs/mesh-selfheal.jsonl` audit line per transition (nobody-polling detected/recovered, claim-won, self-excluded, escalated).
- Self-disarm + ONE Attention on auto-relinquish OR G2-re-claim CHURN (mirror F1b `maxReArmsPerHour`, finding Adv4-C — a chronically-unfit-but-CAS-winning machine re-nominated across episodes is itself an incident).

## Dependency (spec §3, finding Les-C5)
G2's detection runs INSIDE the lease/heartbeat tick; if that tick wedges, G2 wedges too. It DEPENDS on F1's bounded-await + monotonic watchdog to keep the tick running, and the out-of-process fleet/launchd watchdog is the final backstop. State this explicitly so the detector doesn't share the failure mode it catches.

## Test matrix (Testing Integrity — both sides of every boundary)
- Unit (pure decision fn): silence→claim-by-this-machine vs not-the-claimant→stand-down; indeterminate→no-claim; dual→veto; global-with-peer-evidence→HOLD; global-without-peer-evidence→relinquish; CAS-win-then-self-unfit→relinquish+self-exclude; churn→self-disarm.
- Integration (HTTP): `/health` exposes pollOwned/pollFresh/nobodyPollingEpisodes; the audit line is written per transition.
- E2E ("feature alive"): the G2 status surface returns 200 (not 503) when enabled.
- Wiring-integrity: the detector actually reads B5 (not a reimplemented fold); the actuation actually drives `poll-follows-lease` (not a no-op).
- Live-verify (the real gate): on the Mini+Laptop pair, force the nobody-polling state and confirm exactly ONE machine claims + polls (no dual, no drop), via the same internal-path technique used for G3 (`/internal/telegram-forward` + the lifeline poll-active record).

## Ceremony notes (do not skip)
- Spec prereq MET (MESH-SELF-HEAL-SPEC is converged + approved + has ELI16). No new spec-converge needed.
- This touches lease/sentinel/poll-ownership ⇒ **Phase 5 second-pass review REQUIRED** (high-risk: "lease"/"sentinel"/"gate" + session-lifecycle-adjacent).
- **Husky `_` is MISSING in this fresh worktree** → run `npm run prepare` (and `npm ci`) BEFORE the first commit, else the instar-dev pre-commit gate SILENTLY skips and CI decision-audit fails the PR (known trap).
- Ships DARK + dryRun-first; new flag under `multiMachine.sessionPool` (or `multiMachine.*`) + a DARK_GATE_EXCLUSIONS entry (or dev-gated, omit `enabled`). Add `upgrades/next/<slug>.md` fragment IN this PR (G3 lesson: no fragment → never publishes). Add `parent-principle` already on the spec.
- Tooling note: `instar worktree create` failed here (global CLI ERR_MODULE_NOT_FOUND; dev-clone fallback's `repoUrlAllowlist` excludes its own remote) — this worktree was made via manual `git worktree add` off origin/main with Echo's git identity set. Fix the worktree helper's allowlist as a separate friction item.
