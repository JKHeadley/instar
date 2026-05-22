# What this PR does — in plain English

## The story

v1.2.17 made Codex+Playwright the primary path for setting up
Telegram. It actually worked — Codex opened a browser to Telegram
Web and started watching for the login to complete. Good.

But the user just stared at a QR code with no idea what to do.
Justin's first install attempt timed out at 2 minutes with zero
on-screen guidance about scanning the code with his phone.

The Claude version of this same flow doesn't have this problem.
When Claude opens Telegram Web, Claude tells the user "I see the
login screen — please scan the QR code with your phone's Telegram
app (Settings → Devices → Link Desktop Device)". Claude does this
naturally because Claude follows the wizard skill's "speak
conversationally" instructions.

Codex, by default, treats prompts as task descriptions. So when I
told Codex "take snapshots and wait for the login transition",
Codex did exactly that — silently. No user-facing narration.

## The fix

Rewrite the Codex prompt to tell it, explicitly:

- You're talking to a real person sitting at the terminal RIGHT
  NOW.
- They can only see what you print as prose. Snapshot results and
  tool calls are invisible to them.
- BEFORE you act on something, tell them what's about to happen.
- DURING a wait (like the QR code login), print real instructions
  every 25-30 seconds — not "still polling" status.
- When you hit a failure, tell them in plain English first, THEN
  output the failure sentinel.

The prompt also specifies the exact instruction block to print
right after the browser opens — what to do, where to go on the
phone, that it's OK if Telegram isn't installed yet (just grab
it from the app store), and how long the wizard will wait.

And the wait window goes from 2 minutes to 5 minutes, because 2
minutes isn't enough for a fresh user who has to install Telegram
on their phone first.

## Why this should work

The Codex prompt I wrote for v1.2.17 was implicit about
conversation — it described actions, not narration. v1.2.18 is
explicit. Codex's training does respond to clear "you are a
guide, narrate to the user" framing; the failure mode was that I
hadn't asked for it.

## What doesn't change

- The agentic-first, manual-backstop dispatch is unchanged.
- The verifier (`verifyTelegramConfig`) is unchanged.
- The Playwright registration in `~/.codex/config.toml` from
  v1.2.17 is unchanged.
- The Claude wizard path is untouched.

This PR is purely about making the Codex agentic path's UX match
the Claude one.
