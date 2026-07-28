# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Mentor cycle: the two remaining smoothness issues fixed.**

1. **Robust reply capture (no more empty / raw-JSON replies).** The mentee
   role-handler captured the tmux pane after the session completed — racing
   the reaper (→ empty reply) and yielding raw codex stream JSON. It now reads
   the session's persisted transcript: codex → the rollout's
   `task_complete.last_agent_message` (clean prose), claude → the JSONL
   transcript's last assistant text. The tmux capture remains a fallback when
   no transcript is found. New `SessionReplyExtractor` module (pure, unit-
   tested) + `extractMenteeReplyFromTranscript` wiring.

2. **`isMenteeBusy` is remote-aware.** It checked Echo's LOCAL
   `sessionManager.listRunningSessions()` — always non-empty, so every mentor
   tick was wrongly blocked as "busy" (the mentee is a separate remote agent;
   Echo's local sessions say nothing about it). It now gates on the
   `OutstandingPromptTracker` — busy iff a prior mentor prompt to this mentee
   is still unanswered. That's the honest per-mentee signal and the same
   anti-ping-pong invariant, so real ticks now fire when the mentee is idle.

## What to Tell Your User

The cross-agent mentor cycle now runs cleanly: replies come back as readable
prose (not empty, not raw stream JSON), and the scheduled mentor tick actually
fires when the mentee is free (it was previously always self-blocked). No
config changes.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Transcript-based mentee reply capture | Automatic — the mentee reply is read from the session transcript (codex rollout / claude JSONL), clean prose, robust to the reap race. |
| Remote-aware mentor safe-window | Automatic — `isMenteeBusy` gates on the outstanding-prompt tracker, so `/mentor/tick` runs when no prior prompt is in-flight. |

## Evidence

10 new unit tests for `SessionReplyExtractor` (codex task_complete / agent_message /
response_item fallbacks + claude assistant extraction + malformed tolerance),
all green. mentor-runner + mentor/mentee/inbox suites still green; `tsc
--noEmit` clean. Live round-trip re-verification (tick-driven, clean prose)
runs post-release. Side-effects:
`upgrades/side-effects/mentor-cycle-smoothness.md`.
