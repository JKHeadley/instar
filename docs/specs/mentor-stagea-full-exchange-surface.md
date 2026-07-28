---
slug: mentor-stagea-full-exchange-surface
title: Mentor Stage-A full exchange surface
date: 2026-05-29
author: instar-codey
review-convergence: telegram-scope-review-2026-05-29-topic-458
approved: true
approved-by: Justin
approved-via: Telegram topic 458 at 2026-05-29 02:13 PDT
eli16-overview: mentor-stagea-full-exchange-surface.eli16.md
---

# Spec — Mentor Stage-A Full Exchange Surface

## Problem

The mentor onboarding loop now has an agenda and a Stage-A surface built from the mentee's visible replies, but the mentor's own prior prompts are not part of that surface. The mentor therefore rotates agenda items using only half of the visible exchange. A prompt the mentor already sent may be absent from the next Stage-A context, which can make the mentor repeat or mis-order agenda items.

## Scope

1. When `deliverToMentee` successfully sends a Stage-A message, append the sent message content to a JSONL log under the agent state directory.
2. Add a pure defensive parser for that sent-message log.
3. Keep `buildConversationSurface` pure and deterministic.
4. Have `buildConversationSurface` interleave mentor-sent lines and mentee-reply lines by timestamp into `threadlineHistory` as `Mentor: ...` and `Mentee: ...`.
5. Continue treating the surface as user-visible only: mentor prompts, mentee replies, and the mentor's own agenda. No logs, code, rollouts, or internal mentee state enter Stage A.

## Non-Goals

- No changes to Stage-B forensics.
- No changes to the a2a transport format.
- No changes to mentor scheduling, spend policy, or safe-window logic.
- No changes to mentee reply capture.

## Acceptance Criteria

- Unit tests cover parser behavior for the mentor-sent log: good lines, timestamp coercion, bad-line skipping, empty text skipping, mentee filtering, and empty input.
- Unit tests cover timestamp interleaving across mentor and mentee turns.
- Existing mentee-reply parser tests stay green.
- Focused tests, lint, build, upgrade-guide validation, and instar-dev precommit pass.

## Rollback

Revert the MentorStageA, AgentServer, test, and artifact changes. The only new persistent state is an append-only JSONL log of mentor prompts; leaving it behind is harmless because older versions ignore it.
