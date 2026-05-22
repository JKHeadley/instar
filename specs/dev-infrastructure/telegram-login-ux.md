---
title: "Telegram login UX — narrative-driven Codex prompt"
slug: "telegram-login-ux"
author: "echo"
eli16-overview: "telegram-login-ux.eli16.md"
review-convergence: "2026-05-22T02:10:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T02:10:00Z"
review-report: "docs/specs/reports/telegram-login-ux-convergence.md"
approved: true
---

# Telegram login UX — narrative-driven Codex prompt

## Problem statement

End-to-end Codex install attempt on instar-codey (v1.2.17) showed
the agentic Telegram path actually worked: Playwright opened
Telegram Web, Codex started polling the page. But the user-facing
experience was bad:

- One single one-line aside before the spawn ("you may need to scan
  a QR code from your phone to log into Telegram Web").
- Then Codex polled silently every 5 seconds for 120 seconds.
- The only thing on screen during the wait was Codex's internal
  status: "Telegram Web is still on the QR login screen. I'm
  continuing 5-second snapshot polling..."
- After 120s, AGENTIC_FAILED: telegram-login-timeout, fall through
  to manual setup.

Two failures in one:

1. **The user wasn't told what to do.** No on-screen instructions
   about opening Telegram on their phone, the path
   (Settings → Devices → Link Desktop Device), what to scan, or
   that they might need to install Telegram first.
2. **120 seconds isn't enough** for a fresh user who hasn't
   installed Telegram on their phone yet.

Justin's framing of the right fix: *"why a pre-spawn instruction?
Why cant the codex agent know to stop just like the claude code
agent does?"* — i.e., don't scaffold from instar; make the Codex
prompt do it. Claude follows the wizard skill's narrative
instructions natively; Codex needs the same kind of explicit
"speak to the user" language in its prompt.

## Proposed design

Rewrite `buildTelegramAgenticPrompt` to make the conversational
behavior explicit. Three structural changes:

### 1. Explicit "you are talking to a real person" preamble

A new "CRITICAL CONVERSATIONAL RULES" section at the top of the
prompt:

- The user is sitting at the terminal RIGHT NOW.
- Only the prose Codex prints reaches them — snapshot results,
  tool calls, internal reasoning are invisible.
- Tell the user what's about to happen BEFORE acting.
- During waits, print real instructions, not internal status.

This is the equivalent of the wizard SKILL.md's "speak
conversationally / never show CLI commands / NEVER use
AskUserQuestion" rules — but framed for Codex's execution-pull
training.

### 2. Step 2 (post-navigate) prints a clear instruction block

The prompt now specifies the EXACT text to print after Playwright
loads Telegram Web. The user sees a multi-bullet block:

> A browser window just opened with Telegram Web. To log in:
>   • Open Telegram on your phone (if you don't have it yet,
>     install it from your phone's app store — it's free and
>     takes about 30 seconds)
>   • In Telegram, open Settings → Devices → Link Desktop Device
>   • Point your phone at the QR code in the browser window
>
> I'll wait up to 5 minutes for the login. Take your time — I'll
> remind you periodically.

The prompt notes that Codex should adjust the wording to match
the actual UI it sees in the snapshot — the goal is correctness,
not parroting fixed text.

### 3. Periodic reminders during the login wait + 5-min timeout

- Poll for login transition for up to 5 minutes (was 120 seconds).
- Every ~25-30 seconds during the wait, print a short user-facing
  reminder (not internal status). Vary the wording.
- After 5 minutes, print a clear "switching to manual" line, THEN
  the AGENTIC_FAILED sentinel.

The remaining steps (BotFather, group creation, token capture,
config write) also gain brief user-facing narrations between
sub-steps — "Bot's ready. Creating a group chat now and adding
the bot."

## Decision points touched

- The prompt now carries a behavioral contract for conversation.
  Same approach as the Claude wizard's SKILL.md, just authored
  with Codex's training-pull in mind (explicit "real person",
  "what they see").
- No new authority. No new spawn flags. No new sandbox posture.
  Just prompt content.
- The verifier (`verifyTelegramConfig`) still authoritatively
  decides whether the agentic path succeeded; nothing about the
  prompt changes the success contract.

## Open questions

None.

## Out of scope

- Codex-side periodic-reminder enforcement beyond what the prompt
  asks for. We trust Codex to follow the explicit
  every-25-30-seconds instruction. If a future log shows Codex
  ignoring it, we revisit with structural enforcement (e.g.
  instar prints the reminder via a parallel timer outside the
  spawn).
- An interactive "press Enter when you've logged in" Ctrl-style
  signal. Adds complexity and would conflict with the spawn's
  stdio:'inherit' setup. The 5-minute window is generous enough
  for the vast majority of users; the manual backstop covers the
  tail.
- Telling Codex to also print progress for the BotFather flow.
  The prompt now does this in steps 4, 10, 14 ("You're in.",
  "Bot's ready.", "Telegram is connected."). Lightweight; users
  see progress without being overwhelmed.
