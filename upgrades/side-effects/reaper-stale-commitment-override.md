# Side-Effects Review - Reaper stale-commitment override

**Version / slug:** `reaper-stale-commitment-override`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

The `ReapGuard` open-commitment KEEP-guard now protects a session only while a user message arrived within a staleness window (`staleCommitmentWindowMs`, default 24h). Past that window the open commitment is treated as abandoned and no longer vetoes reaping. Surfaced because a 2026-06-06 dry-run (during a load-avg-30 overload investigation) showed the idle-session reaper would reap NOTHING — 19 of 26 sessions were pinned by `open-commitment`, many on sessions the user hadn't touched in 26h. Adds `staleCommitmentWindowMs` to `ReapGuardOptions` (+ `DEFAULT_REAP_GUARD_OPTIONS`), `staleCommitmentWindowMinutes` to `SessionReaperConfig` + `ConfigDefaults` + the `InstarConfig` type, threaded `SessionReaper`→`ReapGuard`.

## Decision-point inventory

- `ReapGuard.evaluate()` guard J (open-commitment): now gated on `recentUserMessage(topicId, staleCommitmentWindowMs)`. Fresh ⇒ keep('open-commitment'); stale ⇒ fall through to the activeness guards (unchanged).
- `ReapGuardOptions.staleCommitmentWindowMs` (new; default 24h; `Infinity` = old always-protect).
- `SessionReaperConfig.staleCommitmentWindowMinutes` (new; default 1440) → mapped to ms in the `SessionReaper` constructor's `new ReapGuard(...)`.
- `ConfigDefaults` + `types.ts` `sessionReaper` block gain `staleCommitmentWindowMinutes`.

## 1. Behavior change / gating

This is a guard-loosening, in ONE direction only: it makes MORE sessions reap-ELIGIBLE, and only those that are BOTH commitment-pinned AND have had no user message for ≥24h. It never makes a session that was reapable into kept. Every other KEEP-guard (protected, spawn-grace, recovery, pending-injection, relay-lease, recent-user-message, active-subagent, structural-long-work, active-process, main-process) is unchanged and still fires in the same order. A session must STILL clear all remaining activeness guards (and, in the reaper, transcript-growth + positive-idle + confirmObservations) before it is actually reaped — this only removes the stale-commitment veto.

## 2. Over/under-signal

The risk direction is OVER-reaping a session whose commitment is genuinely active but whose user simply hasn't messaged in 24h. Mitigations: (a) 24h is a long, conservative horizon — Justin's explicit "no message today" intent; (b) the session must additionally have NO active processes, NO active subagent, NO recent transcript growth, and be positively idle to actually reap; (c) `Infinity` disables entirely; (d) the terminate-time authority guard uses the same default so a single chokepoint enforces it. UNDER-signal (failing to reap) is the prior behavior being fixed.

## 3. Blast radius

Pure in-memory guard logic; no I/O, no new deps (reuses the existing `recentUserMessage` dep with a longer window). Affects only the reap-eligibility decision for commitment-pinned, 24h-silent sessions. Ships behind the sessionReaper (which is itself opt-in + dry-run-first). No API route, no persistent state, no migration of data.

## 4. Failure modes

`recentUserMessage` throwing is already caught by `blockedReason()`'s try/catch → KEEP ('guard-error'), so a signal failure fails SAFE (never reaps). `staleCommitmentWindowMs` defaults are always present (DEFAULT_REAP_GUARD_OPTIONS / DEFAULT_SESSION_REAPER_CONFIG), so an old config missing the field gets 24h, not 0. `Infinity` is honored (any finite withinMs < Infinity ⇒ a correct mock keeps).

## 5. Migration parity

`staleCommitmentWindowMinutes` is an OPTIONAL config field with a code default (1440) in both `DEFAULT_SESSION_REAPER_CONFIG` and `ConfigDefaults`, so existing agents whose config omits it get the 24h behavior automatically — no `PostUpdateMigrator` entry needed (absence ⇒ default, the established pattern for sessionReaper sub-fields). No agent-installed file (hooks/skills/CLAUDE.md) changes; this is internal reaper policy with no agent-facing surface. The reaper remains opt-in (enabled:false default), so this changes nothing until an operator enables it.

## 6. Scope honesty (what this is NOT)

- This UNBLOCKS the reaper; it does not by itself reduce a live process count. It changes which sessions are eligible; the reaper (dry-run first, then live) acts on them. It's paired with enabling sessionReaper + mcpProcessReaper + SleepController (which ship opt-in and were off fleet-wide — the 2026-06-06 finding).
- It does NOT touch the commitments themselves (no auto-expiry of stale commitments — that's a separate follow-up). It only stops a stale commitment from VETOING a reap.

## 7. Causal autopsy

Origin: **latent**. The open-commitment guard has unconditionally protected commitment-bearing sessions since it was added; that was correct when sessions were short-lived and commitments closed promptly. As the fleet grew to dozens of multi-day sessions with commitments left open, the unconditional veto became the dominant blocker to idle-session reaping (grounded 2026-06-06: 19/26 keeps were open-commitment, many 26h-idle). No prior PR regressed it; an always-on protection simply never had a staleness bound. This adds the bound.
