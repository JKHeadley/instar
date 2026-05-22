---
title: "Wizard audit bundle — agentName + admin + greeting + polish (v1.2.20)"
slug: "wizard-audit-bundle"
author: "echo"
eli16-overview: "wizard-audit-bundle.eli16.md"
review-convergence: "2026-05-22T03:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T03:30:00Z"
review-report: "docs/specs/reports/wizard-audit-bundle-convergence.md"
approved: true
---

# Wizard audit bundle — agentName + admin + greeting + polish (v1.2.20)

## Problem statement

After v1.2.19 closed the three end-to-end-blocker issues for the
Codex agentic Telegram path (privacy off, Forum enable, system
topics + intros), Justin asked for a thorough diff of the
Claude SKILL.md vs the Codex prompt to catch everything else
that was missing — instead of continuing the reactive patch
cadence one issue at a time.

An audit (research subagent run, full results published via
tunnel and reviewed by Justin) catalogued 14 findings: 5 high-
priority (UX/identity), 5 medium-priority (polish + security),
and 5 low-priority deferrals (image assets, command vocabulary,
multi-channel resilience). Scope approved for v1.2.20 covers the
5 high + 5 medium items.

## Proposed design

Single PR with 10 changes across two files:

### File 1: `src/commands/setup-wizard/codex-driver.ts`

**1. Agent identity is piped into the prompt (D2/G1 — high).**

`buildTelegramAgenticPrompt` signature changes from
`(projectDir: string)` to `(projectDir: string, ctx?:
TelegramAgenticContext)`. `TelegramAgenticContext` is a new
exported interface with optional `agentName`, `userName`,
`agentRole` fields. The action dispatcher passes the values from
`answers` (collected during the conversational phases of the
state machine).

The prompt now begins with an "AGENT CONTEXT" section the model
sees up front, and step 6 (BotFather display name) uses
`agentName` instead of the hardcoded "Instar Agent". Default
fallbacks (project basename for `agentName`, "friend" for
`userName`, "persistent AI agent" for `agentRole`) cover the
test/no-state cases.

**2. Richer Lifeline orientation message (C1 — high).**

Step 14a (the Lifeline topic seed) is rewritten from the
v1.2.19 two-sentence label into a multi-paragraph orientation
that:
- Greets the user by name in the agent's voice.
- Explains how topics work ("each topic is a separate
  conversation thread, like Slack channels").
- Invites the user to ask for new topics ("you can ask me to
  create new topics for different tasks").
- Hints at the post-server "magic moment" greeting that's
  coming.

**3. Post-server "magic moment" greeting (C2/D1 — high).**

The state-machine's `send-greeting` action was a no-op. It now
delegates to a new `runSendLifelineGreeting(answers, options)`
helper that:
- Reads `token` + `chatId` + `lifelineTopicId` from
  `.instar/config.json`.
- Silently no-ops if any are missing (Telegram skipped, or the
  manual backstop didn't capture `lifelineTopicId`).
- Composes a 3-paragraph personal greeting in the agent's
  voice — references `agentName`, `userName`, `autonomy` blurb,
  and the "settings can be changed by chatting me" promise.
- POSTs to `sendMessage` with `message_thread_id =
  lifelineTopicId`.
- Logs `✓ {agentName} said hello in the Lifeline topic.` on
  success.

This fires AFTER `start-server`, so the agent's server is alive
when the greeting lands — true "agent comes alive" moment per
SKILL.md Phase 5b.

**4. Bot admin promotion via Playwright (A1 — high).**

New step 12b drives Telegram Web's "Add Administrator" flow
right after Forum mode is enabled. Verifies via Bot API
`getChatMember`. Non-fatal — if promotion fails, narrate and
continue. (Pinning in step 14b will silently no-op if admin
rights are missing; we accept that degraded mode rather than
hard-failing the entire wizard.)

**5. Token redaction rule (F1 — high).**

New "CRITICAL CREDENTIAL HYGIENE" section at the top of the
prompt explicitly forbids printing the bot token to the
terminal, gives the regex pattern (`\d+:[A-Za-z0-9_-]{35}`),
and instructs Codex to redact to `[REDACTED]` even in error
narration. Closes the same class of leak Echo's MEMORY.md
records under `feedback_never_print_response_body_when_probing_json_shape`.

**6. `/setdescription` (A2 — medium).**

New step 9b drives `/setdescription` in BotFather using
`agentName` + `agentRole` + `userName` to produce a 1-sentence
bot-profile description ("I'm {agentName}, a {agentRole} for
{userName}. ..."). Non-fatal — BotFather rejection narrates
and continues.

**7. `/setabouttext` (A3 — medium).**

New step 9c — 120-char short line in the chat header. Non-fatal.

**8. Pin Lifeline orientation (B3 — medium).**

New step 14b — `pinChatMessage` on the Lifeline-orientation
message right after step 14 captures `LIFELINE_INTRO_MESSAGE_ID`.
Non-fatal if pin fails (requires admin from 12b).

**9. `chmod 0600` on config.json (F2 — medium).**

New step 15b restricts the config file (which now contains the
bot token) to owner-only read/write. Default umask leaves it
world-readable.

**10. Two-call getUpdates flush pattern (G5 — medium).**

Step 12 updated to first issue `getUpdates?offset=-1` to drain
any stale long-poll backlog (e.g. when another instar instance
is already polling the same bot), sleep 1 second, then issue
the actual `getUpdates?timeout=5` probe. Matches SKILL.md
lines 993-996.

### File 2: state-machine `send-greeting` action

`src/commands/setup-wizard/codex-driver.ts`'s `runAction` case
for `send-greeting` was `return {};`. Now delegates to
`runSendLifelineGreeting`.

## Decision points touched

- New context interface (`TelegramAgenticContext`) is the SIGNAL
  shape passed from state-machine answers into the prompt
  builder. Exported for tests.
- Token redaction rule is a behavioral SIGNAL; the AUTHORITY
  for whether tokens leak remains the actual stdout stream.
- Admin promotion is a SIGNAL (operator intent); the Bot API's
  `getChatMember.status` is the AUTHORITY for whether it stuck.
- Pin requires admin — captured as a dependency between two
  audit items (A1 and B3); B3 is non-fatal if A1 didn't stick.

## Open questions

None for v1.2.20 scope. Five deferred items (LOW priority,
out-of-scope) need separate decisions before they can ship:

- Bot profile picture (A4): needs an image-source decision.
- Group photo (B2): same.
- `/setcommands` (A5): needs an instar-wide command vocabulary
  decision before a default list can ship.
- Group description (B1): low value, low risk.
- Browser-close on agentic exit (G2): polish; bundle with any
  future Playwright touch-ups.

## Out of scope

See "deferred" above. Cross-platform-alerts wording (E1) also
deferred — only relevant after WhatsApp + Slack agentic ports.
