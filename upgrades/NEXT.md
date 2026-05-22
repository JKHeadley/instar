# Upgrade Guide — v1.2.20 (wizard audit bundle — 10 items)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Consolidated 10-item bundle from the v1.2.19 audit of the
Claude SKILL.md vs the Codex agentic Telegram prompt.**

After v1.2.19 closed the three end-to-end-blocker issues
(privacy off, Forum mode, system topics + intros), an audit
catalogued 14 gaps where the Codex prompt fell short of the
Claude wizard's coverage. This release ships 10 of those
(5 high-priority UX/identity, 5 medium-priority polish +
security). The 4 deferred items need separate decisions
(images, command vocabulary, etc.).

### High-priority (5)

1. **Agent name flows into the prompt as the bot display
   name.** Pre-fix bots were named "Instar Agent" in the
   user's Telegram contacts regardless of what they named
   their agent in the wizard. New `TelegramAgenticContext`
   plumbs `agentName`, `userName`, `agentRole` from the
   conversational phases into the prompt; step 6 uses
   `agentName` instead of hardcoded text.

2. **Richer Lifeline orientation message.** Pre-fix the first
   message in the Lifeline topic was a one-line label. Now a
   multi-paragraph greeting addresses the user by name,
   explains how topics work, invites them to ask for new
   topics, and hints at the post-server-start "magic moment"
   greeting.

3. **Post-server "magic moment" agent greeting** (the state-
   machine `send-greeting` action was a no-op). Now sends a
   personalized 3-paragraph greeting in the Lifeline topic
   AFTER the server starts. Uses the agent's name, the user's
   name, the autonomy choice, and the "settings can be
   changed by chatting me" promise. Per SKILL.md Phase 5b:
   "this is the magic moment — the agent comes alive."

4. **Bot promoted to group admin** via Playwright UI. Without
   admin rights, pinning + topic management silently fail.
   Non-fatal: if promotion fails, narrate and continue.

5. **CRITICAL CREDENTIAL HYGIENE rule** in prompt preamble.
   Forbids printing the bot token to the terminal even in
   error messages; gives the regex pattern; demands
   `[REDACTED]` substitution.

### Medium-priority (5)

6. **/setdescription** — bot profile description in agent
   voice + role.

7. **/setabouttext** — short identity line in chat header
   (120-char cap).

8. **Pin Lifeline orientation message** so users scrolling
   back later don't lose context. Requires admin rights from
   #4; non-fatal if missing.

9. **chmod 0600 on .instar/config.json** after writing the
   token. Default umask leaves it world-readable.

10. **Two-call /getUpdates flush** pattern in step 12 — drain
    stale long-poll backlog before verifying Forum mode.
    Robust against the re-install case where another instar
    instance is polling the same bot.

### Deferred (4 items)

Bot profile picture, group photo, `/setcommands`, group
description, browser-close — all need separate decisions
before they can ship. Tracked in the spec's "out of scope"
section.

Spec: `specs/dev-infrastructure/wizard-audit-bundle.md`.
ELI16: `specs/dev-infrastructure/wizard-audit-bundle.eli16.md`.
Side-effects: `upgrades/side-effects/feat-wizard-audit-bundle.md`.

## What to Tell Your User

The Telegram setup is now feature-complete versus the Claude
wizard's coverage. Your bot's contact name matches the agent
name you picked. The first message in Lifeline is a real
orienting greeting, and your agent says hello in voice once
the server's up. The bot has admin rights so it can manage
topics. Token never gets printed to your terminal, and the
config file is mode 0600.

## Summary of New Capabilities

10 distinct upgrades to the Codex agentic Telegram path. No
new modules or abstractions — all changes live inside the
existing `codex-driver.ts`.

## Evidence

Audit: 14 findings catalogued by research subagent, published
via tunnel and reviewed by Justin pre-implementation.

Implementation: 81 wizard tests pass locally (11 new for
v1.2.20 additions, including coverage of agentName-as-display-
name, /setdescription, /setabouttext, admin promotion, pin,
chmod, getUpdates flush, credential hygiene rule, defensive
defaults, and the new `runSendLifelineGreeting` helper for
the magic-moment greeting).

Manual end-to-end re-test on Codex install path pending on
publish.
