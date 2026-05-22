# Side-effects review — Wizard audit bundle (v1.2.20)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER on 10 distinct items surfaced by the audit. Each
was a separate UX/security gap with its own failure mode (wrong
bot name in contacts, missing "agent comes alive" moment, no
admin rights, no token redaction, etc).

After: precisely targeted. Each of the 10 audit items adds a
scoped step to the Codex prompt or wires a state-machine no-op.
Every step has explicit non-fatal vs AGENTIC_FAILED semantics:
core identity steps (agentName as display name, admin promotion)
fail fast; polish steps (/setdescription, /setabouttext, pin)
narrate and continue. The verifier-based dispatch is unchanged.

## 2. Level-of-abstraction fit

One new exported interface (`TelegramAgenticContext`), one
function-signature change (`buildTelegramAgenticPrompt(projectDir,
ctx)`), one new exported helper (`runSendLifelineGreeting`). All
within the existing `src/commands/setup-wizard/codex-driver.ts`
module. No new modules, no new abstractions.

The 10 audit items map cleanly into existing structural slots:
- 8 are prompt-content additions (steps 9b/9c/12b/14a-rewrite/
  14b/15b + the AGENT CONTEXT preamble + CRITICAL CREDENTIAL
  HYGIENE preamble + two-call getUpdates flush in step 12).
- 1 is the state-machine `send-greeting` action's wiring
  (formerly a no-op).
- 1 is the action dispatcher passing `answers` into
  `runTelegramAgentic`.

## 3. Signal vs Authority compliance

- `TelegramAgenticContext` (agentName / userName / agentRole) is
  a SIGNAL flowing from the conversational phases of the
  state-machine to the Codex prompt. Fully derived from user
  answers.
- The Bot API's `getMe`, `getChatMember`, and `createForumTopic`
  responses are AUTHORITIES for "did this step take effect."
  The prompt explicitly verifies state from these.
- `verifyTelegramConfig` reading `.instar/config.json` after
  spawn end remains the AUTHORITY for "did the agentic path
  succeed."
- Token redaction is a behavioral SIGNAL; the actual leak risk
  AUTHORITY is whether any prose Codex generates contains the
  pattern. Tests assert the prompt contains the rule; a future
  audit could add a stdout-scrub pass for defense-in-depth.

## 4. Interactions with adjacent systems

- **State-machine `send-greeting` action**: previously
  `return {};`. Now calls `runSendLifelineGreeting`. No
  state-graph change.
- **`runTelegramAgentic` signature**: gained `answers` parameter.
  Only caller is the dispatcher in `runAction` — already passes
  `answers` to other actions.
- **`buildTelegramAgenticPrompt`**: signature changed (added
  optional `ctx`). Existing call site updated. The exported test
  ID-checked the no-context-passed default path.
- **`writeTelegramConfig`** (used by readline backstop):
  unchanged.
- **`verifyTelegramConfig`**: unchanged.
- **TOPIC_STYLE constants in TelegramAdapter.ts**: still hard-
  coded in the prompt (audit's drift item to revisit later;
  out-of-scope for v1.2.20).
- **Existing test suite**: one test wording update ("intro
  message" → "orienting message"). 11 new tests for v1.2.20
  additions. 81 wizard-related tests total, all green.

## 5. Rollback cost

Low-medium. 10 scoped additions inside one file; one new helper;
one state-machine wiring. `git revert` restores v1.2.19
behavior. No state migration; no config schema change.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- Codex-runtime users on existing installs: when they re-run
  setup, get the v1.2.20 prompt with correct display name +
  greeting + topics. Existing config carries forward.
- Claude-runtime users: zero change.
- Readline backstop (`runTelegramSetup`): zero change.
- Tests: all existing tests pass; new tests cover new behavior.

Drift surface: hard-coded `TOPIC_STYLE` color codes in the
prompt (from v1.2.19). Canary tests verify; if a future PR
changes the constants in TelegramAdapter.ts, the prompt drifts.
Tracked in spec as "out of scope" — could be tightened to
import from the source of truth.

## 7. Authorization / Trust posture

No change. Codex spawn flags unchanged. Bot API access
unchanged. The chmod 0600 step strictly tightens the file
permission posture (good direction, no new privilege).

## Outcome

Ship. Closes 10 of the 14 audit-surfaced gaps in one
consolidated update. Each item independently small; together
they bring the Codex agentic path to feature parity with the
Claude wizard's Telegram phase on every dimension Justin
flagged. 81 wizard tests pass; lint + tsc clean.
