# Context-exhaustion false-positive fix — plain-English overview

## What this is

When a Claude Code session genuinely runs out of room ("conversation too long"),
Instar detects it and recovers the session. The detector decides "is this session
out of room?" by scanning the session's terminal output for the phrase
"conversation too long."

That scan was too naive: it matched the phrase **anywhere** in the output, with no
check that the phrase was an actual error versus ordinary text. So any session that
merely *talked about* the conversation-too-long failure — for example an autonomous
session whose whole job that night was working on that exact feature — had the
phrase all over its transcript, and got falsely flagged as out-of-room.

## Why it became a flood, not just a one-off

The recovery itself sends a notice to the user: *Session hit "conversation too
long" and can't continue…* That notice text contains the trigger phrase. It lands
in the session's pane, the next scan sees it, flags exhaustion again, sends the
notice again — a self-amplifying loop. On 2026-06-06 this dumped ~27 duplicate
"conversation too long" notices into a live topic while the session was perfectly
healthy and shipping a PR.

## The fix

A real Claude Code "conversation too long" error never appears alone — it always
renders **with its CLI recovery framing**: the "Press esc twice to go up a few
messages…" hint, or an "error during compaction" line. (The existing test fixtures
already show this realistic shape.) The detector now requires that framing: the
bare phrase, by itself, is treated as content, not a live error.

This kills both problems at once:
- The recovery notice has no CLI framing → it can no longer re-trigger detection
  (the self-amplification stops).
- A session discussing the phrase has no CLI framing → no false flag.

A real error still has the framing, so genuine exhaustion is still caught — there
is no loss of real detection (verified against the realistic fixtures).

## What changed vs. what stayed

- **Changed:** `detectContextExhaustion` requires the CLI error frame for the bare
  "conversation (is) too long" phrase. Soft signals like "context limit" are
  untouched.
- **Stayed:** real exhaustion detection, the recovery flow, the cooldown, every
  other pattern.

## What you need to decide

Nothing — this is a pure bug fix to an internal detector. It removes false alarms
and the flood without weakening real recovery. The only judgment encoded is "a real
error always shows its CLI hint," which the existing realistic fixtures back up.
If a future Claude Code version renders the error without that hint, the frame list
is a one-line change.
