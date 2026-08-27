# Watchdog Wait Attribution

<!-- bump: patch -->

## What Changed

The session watchdog now recognizes bounded external waiters such as the safe
merge runner and GitHub watch commands and will not classify their quiet polling
periods as stuck work. When the watchdog does interrupt a genuinely stuck
command, its durable audit row explicitly identifies `session-watchdog` as the
principal and records that the action was not operator-initiated.

Codex sessions receive one process-local attributed continuation attempt after a successfully delivered watchdog
interrupt so work resumes from durable state instead of waiting for another
user message when the session is still alive. The attempt is intentionally not described as durable exactly-once delivery.

## What to Tell Your User

When the watchdog interrupts a stuck command, the framework may print a line
saying the task was aborted by the user. That is just how the framework words
it — it is not evidence that you interrupted anything. The watchdog's
audit record now preserves the actual principal.

## Evidence

Unit tests cover wait classification and attribution, an HTTP-pipeline-style
integration test proves safe waits never reach the LLM judge or Ctrl+C path,
and an E2E lifecycle test proves one attributed continuation attempt follows a
real watchdog intervention. The complete main, standalone integration, and
standalone E2E lanes pass with live-agent environment isolation and sequential
real-session fixtures enabled.
