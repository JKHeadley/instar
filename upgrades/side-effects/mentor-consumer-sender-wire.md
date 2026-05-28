# Side-Effects Review — mentor consumer: sender wiring (PR 3c-1)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2b (mentor consumes the
primitive). PR 3 of the staged build, part c-1.
**Change:** Rewire the mentor's `deliverToMentee` from the file-outbox to
`sendAgentMessage` (PR 2b) via a lazily-constructed second TelegramAdapter (PR 2a's
multi-instance subDir + suppressLifelineAutoCreate). **Ships dark** — gated on three
config fields none of which default to anything (`mentor.botToken`, `mentor.menteeBotId`,
`mentor.menteeChatId`, `mentor.menteeTopicId`); without all four set, `deliverToMentee`
logs + no-ops, identical to the prior dormant state.
**Files:** `src/server/AgentServer.ts` (rewire + lazy mentor-bot helpers + cleanup in
`stop()`), `src/scheduler/MentorOnboardingRunner.ts` (new optional config fields on
`MentorConfig`).

## What changed

1. **`MentorConfig`** gains optional `botToken`, `menteeBotId`, `menteeChatId`,
   `menteeTopicId` (all undefined by default). The pre-existing `dailySpendCapUsd` is
   marked `@deprecated` (removed by a future `migrateRetireDeadMentorConfig` in PR 3c-3).
2. **`AgentServer`**:
   - New private fields: `mentorBotAdapter` + `mentorBotAdapterToken` (per-token cache),
     `a2aLedger`.
   - `getOrCreateMentorBot(botToken, menteeChatId)`: lazily constructs the second
     `TelegramAdapter` with `subDir: 'agent-telegram/mentor-bot'` + `suppressLifelineAutoCreate: true`.
     Token-change reconfigures (old adapter stopped first).
   - `getOrCreateA2aLedger()`: lazily constructs `AgentTelegramLedger` at default paths.
   - `deliverToMentee` is now **async** and:
     - Returns immediately with a warning if any of the four required mentor-bot config
       fields is unset (the dark default).
     - Otherwise calls `sendAgentMessage` with role `'mentor'`, body = the prompt, audit
       routed through the a2a ledger.
   - `stop()` now stops the mentor-bot adapter first (clean shutdown of its poll loop +
     state files under the subDir).

## The seven questions

1. **Over-block.** The dark default (no mentor-bot config) is the safe over-block — until
   the operator explicitly configures the four fields, the mentor cannot send anything.
2. **Under-block.** The anti-loop guard is enforced by `sendAgentMessage`'s
   `allowedRoles` (Echo's mentor sender is constructed with `new Set(['mentor'])` — it
   physically cannot send any other role). Bot-token scrubbing on errors is inherited
   from PR 2b.
3. **Level-of-abstraction fit.** The wiring layer composes existing primitives (`sendAgentMessage`,
   `TelegramAdapter` with subDir, `AgentTelegramLedger`). No new policy here.
4. **Signal vs authority.** N/A new — `sendAgentMessage` retains its result authority
   (ok/failed/role-refused).
5. **Interactions.** The mentor-bot adapter shares NO state files with the primary bot
   (PR 2a's subDir isolation — primary paths byte-for-byte unchanged, verified by PR 2a's
   test). The primary bot's behavior is unaffected. If the mentor bot fails to construct
   (bad token), the warning is logged and `deliverToMentee` returns — the mentor tick
   continues, just without delivery.
6. **External surfaces.** None new in this PR. PR 3c-3 adds `/mentor/bot-setup` routes
   + the Secret-Drop flow for entering the bot token.
7. **Rollback cost.** Trivial — revert restores file-outbox `deliverToMentee`. No data,
   no migration in this PR (the file-outbox retirement migration ships with PR 3c-2 or
   3c-3).

## Testing

`tsc --noEmit` clean. Coverage strategy for this PR (intentional + honest):
- The **`sendAgentMessage` path** (the actual marker formation, send, audit, anti-loop
  role refusal, token scrub) is fully covered by PR 2b's 5 unit tests + the 20 marker /
  routing / cycle-detection tests from PR 1.
- The **multi-instance TelegramAdapter** (the second-bot construction with subDir +
  suppressLifelineAutoCreate) is covered by PR 2a's 3 tests (incl. the "primary paths
  byte-for-byte unchanged" load-bearing safety assertion).
- The **mentor-bot lazy construction** in `AgentServer` is dark by default and the same
  shape that PR 3c-3's bot-setup route will live-exercise.
- A dedicated integration test for `deliverToMentee` end-to-end (with a stubbed
  TelegramAdapter send) ships with PR 3c-2 when the receiver-side handler registration
  lands and the round-trip becomes meaningful.

## Migration parity

None in this PR. The new MentorConfig fields are all optional + default undefined. The
`dailySpendCapUsd` deprecation note ships now; its actual removal (`migrateRetireDeadMentorConfig`)
+ the file-outbox cleanup (`migrateRetireMentorOutbox`) land with PR 3c-2 / 3c-3 per
the spec's §Migration parity.
