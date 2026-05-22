# What this PR does — in plain English

## The setup

After v1.2.19 fixed the three blockers that made Telegram setup
actually work end-to-end on Codex, Justin pointed out I was
playing whack-a-mole — fixing one issue at a time as he hit them
— instead of doing the systematic comparison against the Claude
wizard's instruction set. He asked me to audit and fix
everything missing in one go.

I did the audit. Found 14 gaps. Justin approved 10 to ship in
this PR (5 high-priority UX/identity items, 5 medium-priority
polish + security items). 5 LOW items deferred — they need
separate decisions on image assets, command vocabulary, etc.

## The 10 things this PR adds

### 5 high-priority UX/identity fixes

1. **Agent name actually shows up as the bot's name.** Before:
   bot displayed as "Instar Agent" regardless of what the user
   named their agent in the wizard. After: shows up as the
   user's chosen name (e.g. "codey").

2. **Richer Lifeline orientation.** Before: the first message
   in the Lifeline topic was a one-line label. After: a
   multi-paragraph greeting in the agent's voice that addresses
   the user by name, teaches how topics work, and invites them
   to ask for new topics.

3. **Post-server "magic moment" greeting.** The state-machine's
   `send-greeting` step was doing nothing. It now sends a
   personalized "Hey {user}, {agent} here — server's up and
   I'm online" message in the Lifeline topic AFTER the server
   starts, completing SKILL.md's "agent comes alive" moment.

4. **Bot is promoted to group admin.** Without admin rights,
   pinning + topic management silently fail. After: bot has
   admin and can pin/manage topics.

5. **Credential hygiene rule.** New section at the top of the
   Codex prompt explicitly forbids printing the bot token to
   the terminal, gives the regex pattern, and demands
   [REDACTED] in error messages. Prevents the same class of
   leak that bit me on the Bitwarden master password earlier
   today.

### 5 medium-priority polish + security fixes

6. **/setdescription** — bot profile description in the user's
   voice + agent's role.

7. **/setabouttext** — short identity line in the chat header.

8. **Pin the Lifeline orientation** so users scrolling back
   later don't lose context.

9. **chmod 0600 on config.json** — the file now contains the
   bot token; default umask leaves it world-readable.

10. **Two-call /getUpdates flush** to handle the case where
    another instar instance is already long-polling the same
    bot (race condition during re-install).

## What's deferred (5 items)

- Bot profile picture
- Group photo  
- Bot commands menu (`/setcommands`)
- Group description
- Playwright browser-close at end

These need separate decisions on image sources and command
vocabulary before they can ship. Not blocking anything.

## What doesn't change

- The architecture (state machine + Codex driver + verifier).
- The agentic-first, manual-backstop dispatch.
- The Claude wizard path.
- Any existing test contracts.

This PR is purely additive — every existing test still passes,
every existing behavior preserved.
