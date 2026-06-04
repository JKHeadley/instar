<!-- bump: patch -->

## Summary of New Capabilities

- **Turn-based agent-to-agent continuity:** a peer agent's follow-up message now resumes the SAME conversation (full prior context) instead of cold-spawning a memoryless reply session.

## What Changed

Path 1 of the Threadline A2A continuity fix. Headless one-shot `claude -p` reply
sessions never report their session id, so the resume entry kept a placeholder
uuid and every spaced follow-up cold-spawned (a live Echo↔Dawn round-trip proved
Resumed=0 even after the prior foundation shipped).

Fix: `ThreadlineRouter.spawnNewThread` now mints a uuid and launches the reply
session with `claude --session-id <uuid>` (so its transcript is created at exactly
`<uuid>.jsonl`), persisting that uuid as the thread's resume handle.
`resumeThread` launches the follow-up with `claude --resume <uuid>` — reloading
the full prior transcript — and sends only the new message + grounding (the
transcript already holds the history, so re-injecting it is dropped). The
`sessionId`/`resumeSessionId` options are threaded through
`SessionManager.spawnSession` (spliced as `--session-id`/`--resume` into the
claude-code headless argv before `-p`, mutually exclusive, gated on framework) and
`SpawnRequestManager`. Additive + gated: every non-A2A spawn is unchanged when the
options are absent; the stale-uuid resume-crash guard falls back to a fresh spawn.

## Evidence

Verified on this machine, before/after.

**Mechanism (directly verified, 2026-06-04):** `claude --session-id
a6b1c2d3-…-0002 -p "remember BANANA77"` created the transcript at exactly
`<that-uuid>.jsonl` (29 lines). `claude --resume <that-uuid> -p "what was the
secret word?"` grew the SAME transcript to 55 lines and the planted word
`BANANA77` appears in the resumed transcript (6×) — i.e. `--resume` reloaded the
full prior conversation. So set-then-resume by a known id gives real continuity.

**Before (live A6 round-trip, `echo-dawn-A6-verify-…`, server on v1.3.239):**
2× `[relay] Spawned session`, 0× `Resumed`; `onSessionComplete` fired + matched
the thread ("demoted 1 thread(s)") but `claudeSessionId` POST events = 0, so the
placeholder uuid was never upgraded → `jsonlExists` failed → cold-spawn.

**After (unit):** spawning with `sessionId` emits `--session-id <uuid>` before
`-p`; with `resumeSessionId` emits `--resume <uuid>`; neither when absent.
`spawnNewThread` persists the minted uuid as the entry uuid (not a placeholder);
`resumeThread` forwards `resumeSessionId = entry.uuid`. tsc clean; 1548
threadline/fixes/continuity tests green. The live Dawn round-trip showing
`Resumed` (not `Spawned`) runs post-deploy.

## What to Tell Your User

When another agent and I have a back-and-forth, I now stay in the same
conversation across messages instead of forgetting between each one — so the
realistic turn-based exchange (which the upcoming agent-to-agent feedback work
relies on) holds its thread. It's an internal robustness fix; nothing to turn on.
The rapid-fire 3-messages-in-10-seconds case is smoothed by a separate follow-up.
