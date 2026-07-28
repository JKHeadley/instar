# ELI16 — Iris-Audit Session Observability & Config-Application Fixes

## What this is, in plain English

Another Instar agent (Iris) ran a "how am I spending tokens?" check on itself and
found four things that looked off. We looked into each one against the real current
code and sorted them into "actually broken" vs "works, but the agent didn't know how
it works." This change fixes the broken ones and teaches every agent about the part
that just needed explaining.

Think of it like a car: the audit is a fuel-economy check. To tune fuel economy you
need a working fuel gauge, you need to know which engine mode you're in, and you need
a way to actually switch modes. All three were missing or hidden — that's the theme.

## The four things

1. **The token gauge read zero.** There's a screen that's supposed to show how many
   tokens each background feature burns. It always said "0," even for features clearly
   making AI calls. The counter that records "a call happened" worked, but the part
   that records "and it cost N tokens" was never wired up — the tool that runs the AI
   throws the cost information away. We turn that back on.

2. **The "use this model" setting did nothing for Claude.** You can tell an agent
   "default to this AI model." For the Codex and Gemini engines that setting is
   actually passed through. For Claude it was quietly ignored — the code looked the
   setting up and then never used it. So changing it had no visible effect, which is
   exactly what Iris reported. We make Claude honor the setting (and if you don't set
   one, nothing changes — it keeps using your account's default). We also record which
   model each session actually started with, so you can check.

3. **No "apply to everything" button.** After you change a setting, sessions already
   running keep the OLD setting until they restart. You could already restart ONE
   session (keeping its conversation). Now there's a single command to restart ALL of
   them at once, staggered so nothing thrashes, each conversation preserved.

4. **The "recommend a better model" hook that didn't fire.** Iris added a rule that's
   supposed to suggest a stronger model for high-stakes work, and it didn't fire in a
   live chat. This one isn't a bug: Claude only loads its rules when a session STARTS.
   A rule added while a session is already running won't kick in until that session
   restarts — which is exactly what the new "apply to everything" button (point 3) is
   for. We write this down so every agent knows it.

## What already exists vs what's new

- Already there: the per-session model field on `GET /sessions`, the single-session
  restart (`POST /sessions/refresh`), the metrics screen, and the way Telegram
  messages are typed into the live session (which already does fire hooks).
- New: Claude now uses the configured model; the model recorded is the real launched
  one; a bulk `POST /sessions/restart-all`; the token gauge gets real numbers; and a
  CLAUDE.md note (delivered to existing agents too) explaining "restart to apply."

## The safeguards, in plain terms

- The token-counting change can't break the AI calls — if the new format can't be
  read, it falls back to the old behavior, and the cost screen only reads numbers, it
  never blocks anything.
- The bulk restart only touches Telegram-bound sessions, staggers them, preserves each
  conversation, and you can tell it to skip the one you're talking through. Each
  restart is rate-limited so you can't accidentally hammer the fleet.
- The model change does nothing unless you've set a default — no surprise switches.
- The awareness note is added without duplicating, and reverting is just a code
  revert with no cleanup.

## What a reader needs to decide

Mostly: do you agree these are the right fixes and that the bulk restart is safe to
ship (it does restart live sessions, though it preserves conversations). Token
accounting and the model fix are low-risk and additive. It ships as two PRs — session
lifecycle first, token accounting second — both pointing at this one spec.
