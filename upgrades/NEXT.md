# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Mentor check-ins can have their own Telegram topic — off the human conversation.**

The Framework-Onboarding Mentor delivers its periodic a2a check-ins to the
mentee. That delivery used `mentor.menteeTopicId` as its Telegram topic — which
is the SAME topic the human chats with the mentee in. So the mentor's automated
check-ins interleaved with the real human↔agent conversation (surfaced while
dogfooding Codey over Telegram, topic 13435).

New optional `mentor.mentorTopicId`: when set, the mentor exchange (the prompt
delivery AND the mentee's session/reply binding, which both key off one topic
id) flows through that dedicated topic instead. Unset → falls back to
`menteeTopicId` (fully backward-compatible — no behavior change for anyone who
hasn't configured it).

## What to Tell Your User

If you run the mentor cycle and don't want its automated check-ins mixed into
your own conversation topic with the mentee, give it a dedicated topic: set
`mentor.mentorTopicId` in `.instar/config.json` to a topic id in the mentee's
chat. Leave it unset to keep today's behavior.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Dedicated mentor topic | Set `mentor.mentorTopicId` in `.instar/config.json`. The mentor exchange routes there instead of `menteeTopicId`. Falls back to `menteeTopicId` when unset. |

## Evidence

- Unit: `tests/unit/MentorOnboardingRunner.test.ts` — `resolveMentorDeliveryTopic`
  cases: prefers `mentorTopicId`, falls back to `menteeTopicId`, undefined when
  neither set, and treats topic `0` as a real topic (nullish, not falsy).
- Live: observed during the Codey dogfooding run (mentor markers in topic 458);
  verified after configuring a dedicated topic (evidence in the PR).

Spec: `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` (2026-05-28 amendment).
