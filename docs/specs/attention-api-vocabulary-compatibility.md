---
title: Attention API vocabulary compatibility
review-convergence: retrospective-single-pass
approved: true
eli16-overview: attention-api-vocabulary-compatibility.eli16.md
---

# Attention API Vocabulary Compatibility

## Problem

The Attention Queue stores and returns canonical uppercase lifecycle values such
as `OPEN` and `DONE`. The agent-facing templates and at least one internal caller
use friendlier write-side vocabulary such as `resolved`, `medium`, `body`, and
`source`. Before this change, `PATCH /attention/:id` rejected the documented
`resolved` status, and `POST /attention` rejected the documented `medium`
priority and `body`/`source` field names.

That means the read model and the write/docs model disagreed. Operators could
see valid queue items but then fail to resolve them using the documented shape.

## Scope

- Keep stored/read values canonical: `OPEN`, `ACKNOWLEDGED`, `IN_PROGRESS`,
  `DONE`, `WONT_DO`, and uppercase priorities.
- Add route-boundary normalization for write-side aliases:
  - `resolved`, `done`, and completion-shaped aliases map to `DONE`.
  - `ack`/`acknowledged` map to `ACKNOWLEDGED`.
  - `in-progress`/`in_progress` map to `IN_PROGRESS`.
  - `wontdo`/`wont-do` map to `WONT_DO`.
  - `reopen` maps to `OPEN`.
  - `medium` maps to `NORMAL`; `critical` maps to `URGENT`.
- Accept documented `body` as an alias for `summary`.
- Accept documented `source` as an alias for `sourceContext`.
- Update generated guidance to include the required stable `id` field.
- Cover the behavior at unit, route, and full server lifecycle tiers.

## Non-Goals

- Do not create new attention items as part of verification.
- Do not migrate existing attention state.
- Do not change the canonical read shape.
- Do not change the topic-flood guard thresholds or routing behavior.
- Do not make `sourceContext` required; older persisted items can be missing it.

## Acceptance Criteria

- `GET /attention` can still return existing canonical uppercase statuses.
- `PATCH /attention/:id` accepts `{"status":"resolved"}` and stores/returns
  canonical `DONE`.
- `GET /attention?status=resolved` returns canonical `DONE` items.
- `POST /attention` accepts documented `body`, `source`, and `medium` aliases.
- Generated guidance includes a required stable `id` in the queue example.
- Unit, integration, and e2e tests cover the alias compatibility path.
