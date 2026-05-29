# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

Two changes that merged after v1.3.79 and are released together here.

**1. AutoUpdater: recurring jobs no longer block restart activation, and the deferral is now visible (#514).**

The AutoUpdater pulls a new version into the shadow-install on its normal cadence (~30-min check + 5-min coalesce), but ACTIVATING it requires a server restart, and the restart gate would defer indefinitely while any "healthy" session existed — including recurring background jobs that perpetually re-appear as active. The result: an always-busy agent kept running the old version with the fix sitting unused on disk. This narrows the blocker set: a background job session (one with a `jobSlug`) no longer blocks restart when `SessionManager.hasActiveProcesses(tmuxSession)` — the existing process-tree ground truth — reports no non-baseline work. Mid-execution jobs still block (they finish first), and if the safety check is unavailable the job still blocks (conservative). Interactive user sessions are deliberately unchanged — whether an update may interrupt a live user session is a separate policy decision and is NOT relaxed here. The restart-deferral state (target version, first-deferred time, reason, current blockers, next retry) is now persisted and surfaced on authenticated `/health` and `/updates/status`, so "installed but not active" is no longer invisible.

**2. Mentor Stage-A surface now includes the mentor's own prior prompts (#515), completing the active-task-driving feature (#513).**

v1.3.79 gave the Framework-Onboarding Mentor an onboarding agenda and a real Stage-A surface, but that surface only contained the mentee's replies — not the mentor's own prior prompts (their content wasn't logged anywhere). So the mentor inferred "what have I already assigned?" only from replies. Now, when the mentor successfully delivers a prompt, its content is appended to `mentor-sent.jsonl`, and the Stage-A surface builder interleaves the mentor's prompts and the mentee's replies chronologically into a real two-sided "Mentor: … / Mentee: …" exchange. The mentor now sees the full conversation and rotates its agenda correctly. Still ships dark (the mentor is off by default and the agenda is empty by default).

## What to Tell Your User

Two under-the-hood improvements, no action needed. First: when your agent has a fix waiting to install, recurring background jobs no longer keep it from applying that fix on its next safe restart, and you can now see on the health page when an agent has an update installed but not yet active (and why). Interactive sessions are untouched — an update still won't interrupt a live conversation. Second: the optional onboarding mentor (off by default) now sees both sides of its conversation with a new agent, so if you ever turn it on it keeps better track of what it has already walked the agent through. Nothing changes unless you enable the mentor.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Restart-deferral visibility | Automatic. `GET /health` and `GET /updates/status` now include a `restartDeferral` object (target version, first-deferred time, reason, blockers, next retry) when an installed update is waiting on a restart. |
| Recurring jobs don't block restart | Automatic. A background job session no longer blocks update-restart activation when its process tree is idle; mid-execution jobs and interactive sessions still block. |
| Mentor full two-sided surface | Automatic when the mentor is enabled. The mentor logs its own prompts to `mentor-sent.jsonl` and interleaves them with mentee replies in the Stage-A surface, so agenda rotation reflects the real exchange. |

## Evidence

- #514: `tests/unit/UpdateGate.test.ts` + `AutoUpdater.test.ts` cover safe-idle-job de-counting, mid-execution/interactive conservatism, and persisted+surfaced deferral state; `tests/unit/server.test.ts` covers the `/health` + `/updates/status` output.
- #515: `tests/unit/MentorStageA.test.ts` covers `parseMentorSent` (defensive parsing) and the chronological interleave of mentor prompts + mentee replies into the surface, with backward-compatible `buildConversationSurface` signature.
- Both shipped through the full instar-dev gate; live fleet recovery of the prior token-ledger fixes (1.3.77/1.3.78) was observed on monroe/indra (/tokens 503→200 after restart onto the released fix).

Specs: `docs/specs/auto-updater-restart-activation-visibility.md` (#514), `docs/specs/mentor-stagea-full-exchange-surface.md` (#515), `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (the 2026-05-29 active-task-driving amendment).
