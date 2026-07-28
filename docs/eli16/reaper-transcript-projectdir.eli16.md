# Reaper transcript-resolution fix (projectDir) — ELI16

> The one-line version: the idle-session reaper checks whether a session is really idle by reading its transcript file — but it was looking in the wrong place (an empty folder path), so it NEVER found any transcript and could never prove a session idle. It therefore kept every session forever. This points it at the right folder.

## The problem (found 2026-06-06, "make the reaper work correctly and robustly")

After three fixes (#952, #955, #958) removed the layers that were wrongly shielding idle sessions, the reaper STILL reaped nothing — every session came back "transcript-unresolved." That's the reaper's safe default: if it can't read a session's transcript, it can't prove the session is idle, so it KEEPS it (never kill what you can't verify). Correct in spirit — but it was unresolved for EVERY session, which meant the reaper was structurally unable to ever reap.

Root cause: the transcript probe was called with an empty project directory (`projectDir: ''`). Claude Code stores each session's transcript at `~/.claude/projects/<encoded-launch-cwd>/<sessionId>.jsonl`. With an empty cwd the path became `~/.claude/projects//<id>.jsonl` — a folder that never exists — so the lookup always failed. The transcripts were right there (echo's folder holds 5.9 GB / 151,814 of them); the reaper was just looking in the wrong place.

## What this changes

Pass the real project directory (the agent's session-launch cwd, `config.projectDir`) to the probe instead of `''`, so it resolves the actual transcript and can verify idle.

- `SessionReaper` gets a new injected dep `transcriptProjectDir()` (the agent's projectDir), used by its fallback probe.
- The `StaleSessionBackstop` probe in `server.ts` is fixed the same way (it uses `config.projectDir` directly).

## Why it's safe

- It makes the idle-check MORE accurate, never more reckless. A resolved transcript lets the reaper see whether the session is producing output (working → KEEP) or quiet (idle → eligible, after every other gate). A wrong/absent projectDir still resolves to unresolved → KEEP (the prior safe default).
- The reaper is still opt-in + dry-run-first, so this is validated by watching the dry-run resolve transcripts before anything is killed.
- No change to what gets killed on its own — it only lets the reaper finally VERIFY idle, which is the prerequisite for it to work at all.

## Honest scope

This is the keystone of the chain (#952 → #955 → #958 → this): with it, the reaper can actually do its job. Separately, the 151,814-file / 5.9 GB transcript pile-up it surfaced is its own resource problem (transcript retention/pruning) — flagged for a follow-up, not fixed here.

## Evidence

`tests/unit/session-reaper.test.ts` (hermetic, HOME-overridden): the fallback probe resolves a real transcript when `transcriptProjectDir` is wired (→ reap-eligible), and stays `transcript-unresolved` (KEEP) when it's absent (the old broken path). 37/37 green. `tsc --noEmit` clean.
