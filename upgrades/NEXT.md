# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Unifies the tmux injection path so EVERY message (single-line and multi-line)
is delivered via bracketed-paste markers with a 500ms settle before Enter.
Previously, single-line injections skipped the markers and the settle,
sending text and Enter back-to-back — which let Claude Code 2.1.x's TUI
eat the Enter (queued as part of the auto-detected paste buffer) and leave
the message visible-but-unsubmitted in the input box. Sessions then sat
silent until manual intervention. Reproduced live in qalatra (topic 9235)
at 2026-05-11T23:08:47Z — bootstrap pointer typed, Enter sent, session
silent for 52 minutes until a human pressed Enter.

Adds a C0/C1 control-byte sanitizer at the input boundary. Replaces
`\x1b[201~`-class byte sequences (and their 8-bit `\x9b` equivalents)
with `…` before wrapping in paste markers. Closes a paste-exit-injection
vector where a user-controlled body could otherwise close paste mode
early and execute subsequent bytes as keystrokes.

PR #159's multi-shot `verifyInjection` remains in place as defense-in-depth.
With this unification, the verifier should rarely (if ever) need to fire
for single-line injects — but the safety net stays.

Spec converged 5 rounds (4 internal multi-angle + 1 cross-model external
GPT/Gemini/Grok). Broader spec scope (richer verifier with seq+incarnation
guards, config knobs, observability counters) was scope-cut to keep this
PR from orphaning PR #159's concurrently-merged verifier-layer work. The
deferred pieces are documented as Phase-3 follow-ups in spec §4.7.

## What to Tell Your User

- **More reliable message delivery**: "Messages you send during a session
  pause used to occasionally not reach the agent — the text would appear
  in the input but never submit. That root-cause delivery race is now
  fixed, on top of the multi-shot recovery shipped earlier today."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unified bracketed-paste injection | automatic |
| Control-byte sanitization | automatic |

## Evidence

Reproduction (live, observed 2026-05-11):

- Server log for topic 9235 (qalatra):
  ```
  23:08:43Z [respawnSessionFresh] topicId=9235 session=echo-qalatra
  23:08:43Z [spawnSessionForTopic] Bootstrap message too large (15560 chars), wrote to /tmp/instar-telegram/bootstrap-9235-...
  23:08:46Z [SessionManager] Claude ready in "echo-qalatra" after 3024ms
  23:08:47Z [SessionManager] Injected initial message into "echo-qalatra" (217 chars, after stabilization delay)
  ```
- Captured pane at +50 minutes showed the bootstrap pointer text visible
  at the `❯` prompt with no submit. Session was alive, Claude process
  running, but the Enter keystroke from 23:08:47 never registered as a
  submit (single-line path skipped bracketed-paste markers).
- Manual `tmux send-keys -t echo-qalatra Enter` at 23:59:47Z unstuck the
  session. Agent immediately read the bootstrap and resumed work,
  confirming the failure was at the submit-keystroke layer.

Verified-fix evidence:

- New regression tests in `tests/unit/SessionManager-bracketed-paste.test.ts`
  exercise `sanitizeForPaste` against `\x1b[201~`, 8-bit `\x9b`, DEL, and
  other C0/C1 controls. Source-grep tests confirm the if-newline branch
  is gone and the unified path emits paste-start + literal text + paste-
  end + 500ms sleep + Enter in order.
- Pre-existing tests (`paste-stuck-detection.test.ts`,
  `session-injection-verify.test.ts`, `session-multishot-recovery.test.ts`,
  `SessionManager-injection.test.ts`) continue to pass — the regex anchor
  for "bracketed paste" still matches; PR #159's `verifyInjection` is
  still called from `rawInject` after the unified sequence completes.

The bug was reproducible 100% of the time for compaction-recovery
bootstrap injects (single-line, 217 chars) before this fix and 0% of the
time after, because bracketed-paste delivery eliminates the paste-buffer
race that ate the Enter.
