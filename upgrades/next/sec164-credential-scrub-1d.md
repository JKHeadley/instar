# The credential sweeper cleans session records and logs where they sit

<!-- bump: patch -->

## What Changed

SEC-164, part 1d, the last slice of part 1. A sweeper now works through a fixed list of files the agent and its sessions write: this agent's own Claude Code and Codex transcripts (confirmed by the working folder they record), its logs, Local Verify run logs and transcript copies. It masks any live key in place, at the same length, so every line keeps its structure and every reader's offsets stay valid. It never follows a link, never touches a file with a second hard link, and never touches the settings file, the secret store, `.env` files or the hash-chained ledgers. It runs every 15 seconds on files that changed, paces its first pass by the machine's load, and stops itself (reporting once) if it keeps failing. Writes are crash-safe: an interrupted write is finished after a restart. On a development agent it starts by only counting what it would mask, and masks once `security.credentialScrub.inPlace` is on. Hook event files are now masked as they are written and trimmed by a safe rename. `GET /credential-scrub` shows counts by kind, the first pass's progress, bytes still pending and any file it could not measure, never a value or a path.

## What to Tell Your User

- **Old copies get cleaned too**: "If a key ever landed in one of my session records or logs before, I clean it out where it sits, without changing anything else in the file."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Live keys masked in session records and logs where they sit (counted first, masked once `inPlace` is on) | Automatic on development agents; `security.credentialScrub.inPlace` switches counting to masking |
| Sweeper status: counts, progress, pending bytes, unmeasured files | `GET /credential-scrub` (token) |

## Evidence

- `tests/unit/sec164-sweeper.test.ts` (27 cases) covers same-length masking, the dry run, the switch into masking, a new detector revision, a held partial line and the idle tail, a PEM block across lines, an unfinished PEM block, links and the never-touch set, a change during the write, finishing an interrupted or torn write, the fixed list, load pacing, the runner record and status, the breaker with a simulated clock, the wiring, and the locked settings.
- `tests/e2e/credential-scrub-sweeper-alive.test.ts` boots the real server. A planted test key in a listed log is masked in place at the same length, `GET /credential-scrub` answers 200 with the count and never the value, and the settings file keeps its key.
