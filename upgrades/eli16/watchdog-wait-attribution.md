# Watchdog Wait Attribution — Plain-English Overview

## The problem

Instar has a session watchdog that can press Ctrl+C when a command appears to be
stuck. During two release attempts it treated `safe-merge`—a command whose job is
to wait quietly for GitHub checks—as hung work. Codex then displayed its generic
“aborted by user” message even though the operator had done nothing. The release
stopped and stayed stopped until the operator returned.

## What changes

The watchdog now recognizes a small, enumerable class of commands that are
explicitly designed to wait for an external result: Instar's safe-merge runner,
GitHub Actions run watching, and GitHub PR-check watching. Recent terminal output
that explicitly says it is waiting with a deadline, timeout, poll, or check also
protects the current command. Those commands are excluded before the existing
LLM stuck-command judge is called, so a healthy quiet poll is never interrupted.

If the existing judge interrupts some other genuinely stuck command, Instar now
records who actually did it. The audit row says the principal was
`session-watchdog`, gives the stable reason `stuck-command-judge`, and records
that it was not operator-initiated. After the terminal settles, the watchdog
attempts one process-local system continuation telling the agent to verify durable state and
resume the same task. This prevents a supervisory action from being mistaken for
a human cancellation, while honestly allowing zero delivery after restart or input failure.

## Safeguards and limits

The protection is deliberately narrow. It does not bless every long-running
command, and it does not replace the context-aware LLM judge for ambiguous work.
The continuation is attempted only after Ctrl+C succeeds and the session remains alive, is deduplicated per
intervention within the running process, and creates no new user message, URL, database, or cross-machine
coordination state. Each machine's watchdog remains responsible only for sessions
running on that machine. Rollback is a normal patch revert with no state cleanup.

Unit, integration, and production-lifecycle tests cover classification,
attribution, refusal to interrupt safe waits, and the bounded continuation
attempt. The standalone integration and E2E runners also strip live-agent
routing variables and serialize real tmux fixture files, so evidence cannot be
redirected into the running agent or killed by another test file's cleanup.
