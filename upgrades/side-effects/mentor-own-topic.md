# Side-effects review — dedicated mentor topic (mentor.mentorTopicId)

**Scope**: Stop the mentor cycle's a2a check-ins from interleaving with the
human↔mentee conversation topic. Add an optional `mentor.mentorTopicId`; route
the mentor exchange's `telegramTopicId` to `mentorTopicId ?? menteeTopicId`.

**Files touched**:
- `src/scheduler/MentorOnboardingRunner.ts` — add `mentorTopicId?: number` to
  `MentorConfig`; add pure exported `resolveMentorDeliveryTopic(cfg)` returning
  `cfg.mentorTopicId ?? cfg.menteeTopicId`.
- `src/server/AgentServer.ts` — `deliverToMentee` now passes
  `telegramTopicId: resolveMentorDeliveryTopic(cfg)` (was `cfg.menteeTopicId`);
  import the helper.
- `tests/unit/MentorOnboardingRunner.test.ts` — 4 cases for the resolver.
- `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` — 2026-05-28 amendment.
- `upgrades/NEXT.md` — release note (patch bump).

**Under-block (does it ever route to the WRONG topic / break delivery?)**:
- Default is unchanged: with `mentorTopicId` unset, `resolveMentorDeliveryTopic`
  returns `menteeTopicId` — byte-identical to prior behavior. No deployed agent
  changes unless it explicitly sets `mentorTopicId`.
- Uses nullish coalescing (`??`), not `||`, so `mentorTopicId: 0` (the "General"
  forum topic) is honored rather than falling through (the classic zero-is-falsy
  trap; covered by a test).
- `getConfig()` already spreads the whole `mentor` block, so the new field flows
  through with no plumbing change; no config-schema validator gates the mentor
  block (verified by grep), so the additive field is accepted.

**Over-block (does it move something that should stay in the human topic?)**:
- It moves ONLY the mentor a2a exchange (Echo→mentee prompt + the mentee's
  session/reply binding, which both derive from this one `telegramTopicId`).
  The human's own conversation in `menteeTopicId` is untouched. That's the
  intent: separate automated mentor chatter from human conversation.

**Level-of-abstraction fit**: The topic-resolution rule lives as a pure,
unit-tested helper in `MentorOnboardingRunner` (which owns `MentorConfig`),
not as an inline `??` buried in the server closure. `AgentServer` just calls it.

**Signal vs authority**: No authority change. This is pure routing — which
topic the existing delivery targets. Delivery success/refusal, the anti-loop
gate, and the budget gate are all unchanged.

**Interactions**:
- The mentee's REPLY leg uses its own `menteeCfg.replyTopicId` (separate
  config, separate concern) — not changed here. This amendment addresses the
  PROMPT-side pollution (Echo's mentor bot posting role=mentor markers into the
  human topic), which is the observed P3 symptom.
- Same-machine HTTP a2a remains primary; the Telegram fallback (when HTTP
  fails) now posts to the dedicated topic too, since both read this one id.

**Migration parity**: Additive OPTIONAL config field with a backward-compatible
default (falls back to `menteeTopicId`). Unconfigured agents are unaffected, so
NO `PostUpdateMigrator` entry is required. New + existing agents pick up the
capability via the normal `instar` package update; it activates only when an
operator sets `mentor.mentorTopicId`.

**Rollback cost**: Single revert (`MentorOnboardingRunner.ts` field + helper,
`AgentServer.ts` one-line call). No schema/on-disk/API changes.

**Spec**: `MENTOR-LIVE-READINESS-SPEC.md` 2026-05-28 amendment (approved by
Justin, topic 13435 — Codey-dogfooding "P3 - agreed").
