# Side-Effects Review — Mentor tick observability (durable lastResult + tick logging)

**Version / slug:** `mentor-tick-observability`
**Date:** `2026-06-05`
**Author:** `instar-echo`

## Summary

`MentorRunnerServices` gains optional `loadLastResult`/`saveLastResult`; the runner hydrates `lastResult` once at construction and routes all three write paths (disabled short-circuit, success, failure) through one `setLastResult` funnel that persists best-effort. The host (`AgentServer.buildMentorRunner`) wires both to `<stateDir>/mentor-last-result.json` (atomic tmp+rename write; shape-checked, corrupt-tolerant load). `startTick` logs one line on acceptance and one on outcome.

## Decision-point inventory

- `MentorRunnerServices.loadLastResult` / `saveLastResult` — added — optional; absent ⇒ byte-for-byte old behavior (in-memory only).
- `MentorOnboardingRunner.setLastResult` — added — single write funnel; persist failures contained (in-memory value already set).
- Constructor hydration — added — try/catch contained; corrupt/missing ⇒ null (old start state).
- `startTick` logging — added — two `console.log` lines per accepted tick; no logging change on the disabled/in-flight short-circuits (they stay quiet — they fire every 15 min when dark and would be log spam).
- `AgentServer.buildMentorRunner` — modified — wires the two services only when `stateDir` exists; the persist file lives beside the existing `mentor-sent.jsonl` precedent.

## Direction of failure

- Old failure: the loop's only outcome record was wiped by every restart; success was silent in logs — "is the mentor alive?" was unanswerable from its own surfaces.
- New behavior: outcome survives restarts; the log carries the loop's pulse.
- Conservative failure direction: ALL new I/O is best-effort and contained — a missing stateDir, unreadable file, corrupt JSON, or full disk degrades to exactly the old in-memory behavior, never a crash, never a blocked tick.

## Side-effects checklist

1. **Over-block:** none possible — the change never gates or refuses anything; it records and logs only.
2. **Under-block:** none — no authority added. A stale persisted lastResult after config flip-off is possible (file shows an old outcome while disabled writes overwrite it on the next tick POST) — acceptable: the disabled short-circuit itself writes `reason: disabled`, refreshing the file on the very next heartbeat.
3. **Level-of-abstraction fit:** the runner owns WHEN to persist (its write funnel); the host owns WHERE/HOW (state-dir path + atomic write) — mirrors the existing `capture`/`deliverToMentee` service split and the `mentor-sent.jsonl` persistence precedent.
4. **Signal vs authority compliance:** observability-only; no LLM, no gate. Log lines are signals.
5. **Interactions:** the persisted shape is exactly the in-memory `MentorRunResult & { at }` — the status route serializes it identically whether hydrated or fresh. The hydrated value can briefly present a PRIOR generation's outcome after a restart until the next tick overwrites it — that is the feature (it is timestamped via `at`, so staleness is readable).
6. **External surfaces:** GET /mentor/status semantics unchanged (same field, now durable). One new state file in the agent state dir. Two new log line shapes (`[mentor] tick accepted…` / `[mentor] tick result…`).
7. **Rollback cost:** revert the commit; the state file is ignored by old code (no reader), safe to leave or delete.

## Scope not taken

- No fix for the job-session 1-min age-limit race (`expectedDurationMinutes: 1` vs heavy boot) — that is task #14's lean loop-worker territory; this slice makes the symptom DIAGNOSABLE first.
- No X-Instar-AgentId header fix in the job template (auth deprecation warning) — separate small follow-up.
- No grounding-config addition for the mentor job (JobLoader audit warning) — separate.
- No change to tick cadence, gating, budget, or Stage-A/B behavior.

## Rollback

Revert the single commit. The runner returns to in-memory-only lastResult and silent successful ticks.
