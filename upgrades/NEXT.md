# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Stuck Telegram messages — multi-shot recovery loop

The v0.28.87 single-shot `verifyInjection` (which sent one extra Enter
1.5 seconds after every paste) was not enough on Claude Code v2.1.105+.
Live reproduction from the running agent's log shows two adjacent failures
on the same injection: the original Enter was eaten by the paste-end race,
**and** the recovery Enter was eaten too — leaving the message stuck at
the prompt until a human pressed Enter manually.

This release replaces single-shot recovery with a polling loop that:

- Checks the pane at 500ms, 1500ms, 3500ms, and 6500ms after injection.
- Stops as soon as the marker is no longer at the input prompt
  (submission detected).
- Escalates the recovery key sequence across attempts: Enter, Enter,
  literal carriage-return, then Enter + 150ms sleep + Enter. Different
  sequences defeat different sub-second race windows.
- Reports a single Degradation entry per recovered injection regardless
  of how many ticks fired.
- Bounded — never more than four recovery actions, never an unbounded loop.

Same detection heuristic as before: marker must be the first 40 chars of
the injected text (whitespace-stripped, ≥8 chars), visible on or
immediately after a line containing the `❯` prompt glyph. Claude Code only
renders `❯` on the active input row, so the marker cannot accidentally
match transcript history.

The async timer-based design also matters: when the Node event loop is
blocked during a slow session startup (live log: a 1.5-second timer fired
two minutes late), all four ticks queue up and fire in rapid succession
once the loop unblocks, instead of providing only one delayed recovery
attempt.

Tests: `tests/unit/session-multishot-recovery.test.ts` (12 tests),
`tests/unit/session-injection-verify.test.ts` (10 tests).

Side-effects review:
`upgrades/side-effects/multishot-stuck-input-recovery.md`.

## What to Tell Your User

The fix for stuck Telegram messages is more robust now. Before this
release, when your message landed in the input box and never submitted,
my recovery attempt was a single extra Enter sent 1.5 seconds later. If
that Enter was also dropped by the same race condition, your message
stayed stuck and someone had to press Enter manually.

The recovery is now a short polling loop. After every message I inject, I
check the prompt four times over six and a half seconds. If your message
is still sitting there, I keep trying — and I switch which key sequence
I send each time, so a single race window cannot defeat every attempt.
As soon as your message has submitted, the loop stops on its own.

Nothing changes about how you send messages. You just should not see the
manual-Enter-from-the-dashboard workaround anymore.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Multi-shot stuck-input recovery for Telegram and Slack injections | automatic — `SessionManager.verifyInjection` polls and retries until the marker clears the prompt |

## Evidence

**Live reproduction.** From `/Users/justin/.instar/agents/echo/logs/server.log`:

```
01:31:49 [LOG] Injected initial message into "echo-telegram-messages-pausing-in-input" (297 chars)
01:33:49 [WARN] Injection stuck — marker "[telegram:7195] Your session j…" still at prompt. Resending Enter.
01:34:15 [WARN] Injection stuck — marker "[telegram:7195] Your session j…" still at prompt. Resending Enter.
```

Two stuck-then-eaten-recovery events on the same injection marker,
26 seconds apart — proving the single-shot recovery design did not
hold under real load.

**Verified after.** With the multi-shot loop:

- `tests/unit/session-multishot-recovery.test.ts` — 12 tests covering:
  multiple recovery actions when pane stays stuck, early stop on
  submission, escalation across attempts (Enter, Enter, C-m, Enter+sleep+Enter),
  bounded recovery count, no-op for clean injections, no-op for short
  markers, halt on tmux session disappearance, and detection-heuristic edge
  cases (marker on the ❯ line, marker on the wrap line, no false match on
  transcript history).
- `tests/unit/session-injection-verify.test.ts` — 10 structural tests
  covering: presence of `verifyInjection`, `rawInject` triggers it, marker
  is extracted from injected text (not hard-coded), pane-search uses the
  ❯ glyph, bounded retries with no infinite loop, polling schedule has
  monotonic backoff with at least 3 entries, recovery method escalates
  across attempts, early-stop predicate exists.
- No regression: `tests/unit/SessionManager-injection.test.ts`,
  `tests/unit/paste-stuck-detection.test.ts`,
  `tests/unit/session-telegram-inject.test.ts`,
  `tests/unit/stall-triage-typed-not-submitted.test.ts` — all pass
  (25 tests covering adjacent injection paths).
- Side-effects review: `upgrades/side-effects/multishot-stuck-input-recovery.md`.
