# Side-effects review — Telegram privacy + Forum + topics + intros

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER on three counts.
- Bot privacy mode left ON → `can_read_all_group_messages: false`
  → no group messages reach the bot → server polling sees nothing
  → user message sits in the void.
- Group is "basic" not "supergroup" → topic threads impossible
  → instar's server-side topic-ensure functions silently fail.
- No system topics created → no Lifeline → server can't seed
  agent's first greeting → no "agent comes alive" moment.

After: precisely targeted. Three new prompt steps + their failure
sentinels. The agentic path either reaches a fully-working state
(privacy off + Forum enabled + 4 topics + intros + config
persisted) or it bails to the readline backstop. No silent partial-
success states.

## 2. Level-of-abstraction fit

Pure prompt-content change. All new behavior described in the
prompt's natural language + curl/UI instructions Codex already
understands. No new helper functions, no new abstractions.

The `writeTelegramConfig` helper used by the readline backstop is
unchanged (it still writes token + chatId only). The agentic path
writes its own config inline via curl-like bash steps in the
prompt — which is fine because the verifier checks the result
authoritatively.

## 3. Signal vs Authority compliance

- The user's intent SIGNAL (run the Telegram agentic flow) is
  unchanged.
- The bot's privacy state, the group's forum state, and the
  topic-creation results are all AUTHORITATIVE Telegram API
  responses. The prompt's verification steps query them directly
  (`getMe`, `getUpdates`, `createForumTopic` response.ok).
- `verifyTelegramConfig` is the final AUTHORITY for "did the
  agentic path succeed." Unchanged contract.
- The TOPIC_STYLE constants in `src/messaging/TelegramAdapter.ts`
  are the AUTHORITY for the canonical topic names + colors. The
  prompt hard-codes them. Drift risk: the canary test verifies
  the prompt contains the same color codes the source uses.

## 4. Interactions with adjacent systems

- **`src/messaging/TelegramAdapter.ts` server-side topic-ensure
  functions** (`ensureLifelineTopic`, `ensureDashboardTopic`,
  `ensureAgentAttentionTopic`, `ensureAgentUpdatesTopic`):
  unchanged. They now find pre-existing topics created by the
  agentic flow rather than creating duplicates. `lifelineTopicId`
  in config tells `ensureLifelineTopic` to reuse the existing
  topic.
- **Server boot Telegram polling**: now works because privacy is
  off and chatId is the supergroup id.
- **Readline backstop (`runTelegramSetup`)**: unchanged. Still
  serves as fallback if the agentic path fails. Note: the
  backstop doesn't drive privacy-off or Forum-enable; users on
  the backstop path will hit the same problems Justin hit. A
  follow-up should extend the readline flow with explicit
  manual instructions for the same three steps.
- **`verifyTelegramConfig`**: unchanged. Still checks token +
  chatId.

## 5. Rollback cost

Trivial. Prompt content + 5 new test cases. Revert restores the
v1.2.18 prompt (which doesn't disable privacy / enable Forum /
create topics).

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- Codex-runtime users: get full end-to-end working messaging.
  Previously got bot+group with broken delivery.
- Claude-runtime users: unchanged.
- Drift surface: the TOPIC_STYLE colors. If they change in
  `TelegramAdapter.ts`, the prompt's hard-coded values drift.
  Canary catches the divergence. Could be tightened in a follow-
  up by importing TOPIC_STYLE and string-templating the prompt.

## 7. Authorization / Trust posture

No change. Codex spawn flags and Playwright permissions unchanged.
Bot API access unchanged.

## Outcome

Ship. Closes the three real-user blockers from the v1.2.18
retest. Verifier + sentinels keep the manual backstop reachable
on any failure. Topic-style colors match the server-side
canonical TOPIC_STYLE so `ensureLifelineTopic` etc. see existing
topics on boot.
