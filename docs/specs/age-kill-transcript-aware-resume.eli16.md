# Age-Kill Transcript-Awareness — Plain-English Overview

> The one-line version: the watchdog that retires very old sessions couldn't "see" work being done through the browser tool, so it killed a session that was busy — this teaches it to look at the session's live activity log before pulling the trigger.

## The problem in one breath

The agent runs each conversation as a long-lived background "session." A safety watchdog retires sessions that have been open a very long time (about 5 hours) — but only AFTER checking they're actually idle. The idle check looks at two things: is the terminal sitting quietly, and is anything running as a child program. Work done through the browser tool (and other plug-in "MCP" tools) shows up in NEITHER of those, so a session that was busy driving a browser looked idle and got killed mid-task — with no heads-up and no automatic resume.

## What already exists

- **The age watchdog** — retires sessions older than ~5 hours, but defers the kill if the session looks busy. The "looks busy" test is the weak part.
- **A second, smarter reaper** — the one that retires *idle* sessions under memory/CPU pressure. It ALREADY cross-checks the session's live activity log (the transcript file that grows every time the agent does anything) and refuses to kill a session whose log is still growing. So that path would never have made this mistake.
- **A mid-work resume queue** — brings interrupted work back. It only fires when a kill is tagged "was mid-work," which this kill was not.

## What this adds

One thing: the age watchdog now also checks the live activity log — the same signal the smarter reaper already trusts. If the session's log was written in the last 2 minutes, the session counts as busy and the kill is deferred (exactly like it already defers when a child program is running). Nothing else changes.

## The new piece

- **A tiny "was this session active recently?" probe** — it finds the session's activity-log file and checks when it was last written. Recent = busy = don't kill yet. It is deliberately cautious in the safe direction: if it can't find or read the log, it says "I don't know" and falls back to today's behavior — it never keeps a possibly-dead session alive forever.

## The safeguards

- It can only make the watchdog MORE cautious (kill fewer active sessions), never more aggressive.
- Genuinely-finished sessions still get retired — once their log goes quiet, the existing idle check catches them within minutes. A just-finished session is at most deferred for one 2-minute window.
- It's machine-local by design — each machine only ever looks at its own sessions and its own logs; nothing crosses between machines.
- Fully covered by tests (busy → kept, quiet → reaped, unreadable → safe fallback), and it can be turned inert by setting the window to zero.

## What you're deciding

Whether to teach the age watchdog the same transcript check the other reaper already uses, so an actively-working session is never again retired as "idle." The blast radius is small (one defer condition added to one existing kill path), the rollback is a one-file revert, and it directly closes the exact failure that killed the EchoOfDawn session.
