# Side-Effects Review - Reaper stale-idle active-process override

**Version / slug:** `reaper-stale-idle-override`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

`SessionReaper.evaluate()` now relaxes the `active-process` existence-veto for a stale-idle session (no user message within `staleCommitmentWindowMinutes`, default 8h), falling through to the existing stateful transcript-growth + positive-idle gates which STILL must clear. The active-process analogue of the #955 stale-commitment override. Found because a post-#955 dry-run showed idle sessions just moved from keep-reason `open-commitment` to `active-process` (their own idle MCP servers), and the McpProcessReaper correctly won't kill MCP procs under a live session — so idle-MCP-heavy sessions sat in a gap. Adds `reapStaleIdleWithActiveChildren` (default true) to `SessionReaperConfig` + `ConfigDefaults` + the `InstarConfig` type, and a `staleIdleRelaxed` observability flag to `SessionEvaluation`.

## Decision-point inventory

- `SessionReaper.evaluate()`: computes `staleIdle = reapStaleIdleWithActiveChildren && topicBinding != null && !recentUserMessage(topicId, staleCommitmentWindowMinutes*60_000)`; the active-process relax now fires on `cpuFlat===true OR staleIdle`. Sets `staleIdleRelaxed` for the audit.
- `SessionReaperConfig.reapStaleIdleWithActiveChildren` (new; default true).
- `SessionEvaluation.staleIdleRelaxed` (new; observability — parallels `cpuTightened`).
- `ConfigDefaults` + `types.ts` `sessionReaper` block gain `reapStaleIdleWithActiveChildren`.

## 1. Behavior change / gating

A guard-loosening in ONE direction: more sessions become reap-ELIGIBLE, and only those that are ALL of — 8h-user-silent, topic-bound, positively idle, transcript-flat, and confirmed across the reaper's multi-tick window. It never makes a reapable session kept. The relax is implemented in `evaluate()` (NOT in the shared `ReapGuard`), so the terminate-time authority guard is UNCHANGED — it still honors the active-process veto unconditionally; only the careful multi-tick reaper relaxes it, and only with the stateful idle proof behind it.

## 2. Over/under-signal

OVER-reap risk: a session whose user simply hasn't messaged in 8h but is mid-long-autonomous-run. Mitigations: (a) `buildOrAutonomousActive` (structural-long-work) fires BEFORE active-process and is unchanged — an active autonomous run is kept; (b) transcript-growth keeps anything producing output; (c) positive-idle is required; (d) confirmObservations multi-tick; (e) topic-bound requirement excludes sessions we can't time-bound; (f) `reapStaleIdleWithActiveChildren:false` disables. UNDER-signal (the prior "reaps nothing") is the bug being fixed.

## 3. Blast radius

Pure in-memory eval logic; reuses the existing `recentUserMessage` + `topicBinding` deps (no new I/O). Affects only the reap-eligibility decision in the multi-tick reaper. No API route, no persistent state, no migration of data. Ships behind the sessionReaper (opt-in + dry-run-first).

## 4. Failure modes

`recentUserMessage` / `topicBinding` throwing: `topicBinding` is called outside the guard's try/catch in `evaluate`, but a throw there would propagate to `tick()`'s per-session try/catch which records KEEP ('eval-error') — fail-safe (never reaps). A null topic ⇒ staleIdle false ⇒ veto stands (conservative). Missing config field ⇒ default true via DEFAULT_SESSION_REAPER_CONFIG, OR explicit false to disable.

## 5. Migration parity

`reapStaleIdleWithActiveChildren` is optional with a code default (true) in both `DEFAULT_SESSION_REAPER_CONFIG` and `ConfigDefaults`, so existing agents get the behavior automatically when they enable the reaper — no `PostUpdateMigrator` entry needed (absence ⇒ default, the established sessionReaper-subfield pattern). No agent-installed file changes; internal reaper policy, no agent-facing surface. The reaper stays opt-in (enabled:false default) so nothing changes until an operator turns it on.

## 6. Scope honesty (what this is NOT)

- Third unblock in the chain (#952 Spotlight, #955 stale-commitment, this). It makes idle sessions reap-ELIGIBLE; the reaper (dry-run first, then live) acts on them. Pairs with enabling sessionReaper + mcpProcessReaper + SleepController (opt-in, were off fleet-wide).
- Does NOT touch the terminate-time authority guard (kept conservative). Does NOT change CPU-flat handling (cpuAwareActiveProcessKeep) — it adds a SECOND, independent relax reason.

## 7. Causal autopsy

Origin: **latent** (compounded by #955's own staleness fix surfacing it). The active-process existence-veto has unconditionally kept any session with a live child since it was added — correct when sessions were short-lived. As the fleet grew to dozens of multi-day sessions each running an idle MCP stack, that veto became the residual blocker once #955 removed the open-commitment one. No prior PR regressed it; #955 simply peeled the outer layer and exposed this inner one. 2026-06-06 dry-run grounding: post-#955 keeps were 100% active-process with 0 reap-eligible. This adds the matching staleness bound. The operator explicitly requested a "slightly aggressive" posture given repeated overloads.
