# Codex stranded-draft recovery — Plain-English Overview

> The one-line version: when you message a codex agent that's busy, your message no longer gets silently stuck in its input box forever — the system now notices the stranded message and submits it once the agent is free.

## The problem in one breath

You messaged Codey in the middle of a long autonomous run. The message reached his
session but never got submitted — it just sat in his input box as a half-typed
draft for three hours, so he never saw it and you assumed he ignored you. The only
things you saw were his automatic progress updates, which made it worse.

## What already exists

- **The message bridge** — when you send a Telegram message, the system types it
  into the agent's session and presses Enter to submit it.
- **Claude Code's input queue** — if you message a Claude agent while it's busy, the
  text waits in line and submits itself the moment the current task finishes. Self-healing.
- **The stuck-input sentinel** — a background watcher that checks every 10 seconds
  for a message that got typed but never submitted, and presses Enter to unstick it.
  It already survives restarts.

## What this adds

Codex agents behave differently from Claude in one crucial way: a message typed while
codex is busy is held as a **draft that never auto-submits**, even after the task
finishes. And the stuck-input sentinel was only looking for Claude's prompt symbol
(`❯`), not codex's (`›`) — so it never even saw stuck codex messages. This change
teaches the sentinel to recognize codex's prompt and to press Enter once codex is
free, so your message actually gets delivered.

## The new pieces

- **Stranded-draft marker** — when a message is sent to a codex session, the system
  remembers the first few words of it. The watcher looks for exactly those words still
  sitting in the input box. This is the trick that makes it reliable: codex shows a
  faint grey hint ("Explain this codebase") in an *empty* input box that looks
  identical to real text once color is stripped — but it never matches your actual
  message, so the watcher can tell a real stuck message from an empty box.

## The safeguards

**Never interrupts working agents.** The watcher only acts when the agent is idle. It
recognizes codex's "working" indicator and stays hands-off until the turn is done.

**Never false-fires on an empty box.** Because it matches your actual message text, the
faint placeholder hint codex shows in an empty box is never mistaken for a stuck message.

**Bounded and safe.** It tries at most four escalating nudges, then stops. A stray Enter
on an empty box does nothing. Claude agents are completely unaffected — their path is
untouched.

## What ships when

One change, one PR: the prompt-recognition fix, the marker tracking, and the watcher's
codex path ship together, fully tested. A small follow-up (making the marker survive a
server restart) is noted for later — the current fix already closes the reported bug.
