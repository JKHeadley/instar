---
title: "Wizard fixes — Telegram-native flow, user-add cwd, choice echo"
slug: "wizard-telegram-native"
author: "echo"
eli16-overview: "wizard-telegram-native.eli16.md"
review-convergence: "2026-05-21T23:55:00Z"
review-iterations: 1
review-completed-at: "2026-05-21T23:55:00Z"
review-report: "docs/specs/reports/wizard-telegram-native-convergence.md"
approved: true
---

# Wizard fixes — Telegram-native flow, user-add cwd, choice echo

## Problem statement

Second real-user log of the hybrid wizard on Codex (v1.2.14, after
the buffered-Enter fix) surfaced three more issues. Reviewed
chronologically:

1. **`instar user add` errored with "unknown option '-d'"** during
   the add-user action. The codex-driver was passing
   `-d <projectDir>` but the `user add` CLI does NOT accept that
   flag — it reads project state from cwd. The user profile got
   created in the parent `~/.instar/agents/echo/.worktrees/...`
   process cwd as a side effect that nobody actually wanted, or
   silently failed. Either way the new agent's `users.json` stayed
   empty.

2. **Choice prompts silently accepted text input without
   confirmation.** Justin typed "Proactive" at the autonomy prompt
   and "Telegram" at the messaging prompt. `resolveChoice` correctly
   matched both by label-prefix and returned the right values. But
   the wizard never echoed back the selection, so the user couldn't
   tell whether the input had been understood or whether it was
   about to bail with the fallback.

3. **Telegram setup spawned `codex exec` which can't wait for user
   input.** The action handed off to a Codex agentic session with a
   "walk the user through BotFather" prompt. Codex correctly noted
   Playwright wasn't available and printed manual instructions:
   "send me the bot token and chat ID and I'll write the config."
   But `codex exec` is non-interactive single-turn — there was no
   way for the user to actually send the token because the exec call
   had already consumed stdin and was already terminating. Codex
   printed the request, ended successfully, and the wizard recorded
   `telegramConfigured: true` without anything actually configured.

Justin's verdict: *"telegram setup with playwright failed. we need
to make sure this is extremely robust and will always work."*

## Proposed design

Three scoped fixes in `src/commands/setup-wizard/codex-driver.ts`.

### Fix 1: user-add cwd (not -d)

The `add-user` action's argv changes from:

```ts
['instar', 'user', 'add', '-d', options.projectDir, '--id', id, '--name', name]
```

to:

```ts
['instar', 'user', 'add', '--id', id, '--name', name]
// + spawn option: { cwd: options.projectDir }
```

`server start` and `autostart install` already accept `-d` and they
keep it for explicitness; their spawn options now ALSO set cwd so
all action subprocesses run in the project directory consistently.

### Fix 2: Choice echo after validation

A new `echoChoice(state, answer)` helper, called from
`renderNarrativeState` after the validator accepts the answer. For
`kind: 'choice'` prompts, it prints `  → {choice.label}` (e.g.
"→ Proactive") so the user sees the wizard's interpretation of
their text input. For `kind: 'text'` prompts it's a no-op (the
answer is the answer).

The echo also catches cases where the user types a partial label
prefix and gets matched to something they didn't intend — they see
the resolved label and can interrupt before the action runs.

### Fix 3: Telegram-native setup flow

`runTelegramSetup` is rewritten end-to-end. The codex exec spawn is
gone. The new flow:

```
Step 1 of 3 — Create a bot
  ↳ Print BotFather instructions verbatim.
  ↳ readline → token input.
  ↳ Verify via GET https://api.telegram.org/bot<TOKEN>/getMe.
  ↳ Loop up to 5 attempts on bad token; "skip" exits with a
    "configure later" pointer (does NOT mark as configured).

Step 2 of 3 — Connect a chat
  ↳ Print "add the bot to a group, send a message" instructions.
  ↳ Press-Enter prompt while user does it.
  ↳ GET https://api.telegram.org/bot<TOKEN>/getUpdates.
  ↳ Find a group/supergroup chat in the result (fall back to most
    recent chat of any type). Extract id + name.
  ↳ Loop up to 4 attempts with "skip" option.

Step 3 of 3 — Save config
  ↳ Read .instar/config.json.
  ↳ Strip any existing { type: 'telegram' } entry (idempotent).
  ↳ Push { type: 'telegram', enabled: true, config: { token, chatId,
    pollIntervalMs: 2000, stallTimeoutMinutes: 5 } }.
  ↳ Write back.
```

Failure modes:
- Token validation fails 5 times → skip, `telegramConfigured: false`,
  user can run `instar add telegram` later.
- getUpdates discovery fails 4 times → save partial config (token
  only), `telegramConfigured: false`, agent's first chat from the
  user fills in the chat ID.
- Network unreachable → skip with clear "try again later" pointer.
- `.instar/config.json` write fails → `telegramConfigured: false`,
  user gets a clear message that the bot is created but not wired up.

Critically, the action NEVER returns `telegramConfigured: true` when
the config wasn't actually written — closing the v1.2.14 silent-
success failure mode.

## Decision points touched

- The wizard's `setup-telegram-agentic` action moves from
  framework-as-agent to instar-native. The action name stays
  unchanged (still describes the user-visible behavior) but the
  implementation is structural.
- No new authority. The flow uses `node:fetch` (Node 22+ builtin)
  for Telegram API calls and existing `fs.readFileSync` /
  `fs.writeFileSync` for config persistence. Both are routine.
- The action's contract with the state machine is unchanged:
  returns `{ telegramConfigured: true | false }` for downstream
  consumers (e.g., the lifeline-greeting action).

## Open questions

None for this PR's scope.

## Out of scope

- WhatsApp + Slack agentic flows. Today the wizard emits a
  "configure later" pointer for those; porting them to instar-
  native flows is a separate spec.
- A Codex agentic Telegram-via-Playwright path. If/when Playwright
  MCP tools land for Codex installs, a follow-up spec can add an
  agentic variant of the setup that runs in PARALLEL with the
  manual flow (user picks which). Today the manual + API flow is
  reliable enough on its own and works across all environments.
- LLM-driven input interpretation for choice prompts ("the user
  said 'I'd rather just have it ask me', interpret that as Guided").
  Out of scope for v1.2.15; the validator + echo pattern handles
  the failure mode this real-user log surfaced (Justin's actual
  inputs DID get interpreted correctly — they just weren't echoed).
