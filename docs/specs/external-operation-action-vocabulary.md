---
title: "External Operation Gate — action vocabulary alignment"
slug: "external-operation-action-vocabulary"
author: "codey"
review-iterations: 1
review-convergence: "2026-05-29T12:05:00Z"
review-completed-at: "2026-05-29T12:05:00Z"
approved: true
approved-by: "justin"
approved-at: "2026-05-29T11:57:00Z"
incident-origin: "topic 458, 2026-05-29 — live evaluator returned proceed while generated docs described allow"
eli16-overview: "external-operation-action-vocabulary.eli16.md"
---

# External Operation Gate — action vocabulary alignment

## Problem

The External Operation Gate endpoint and the installed PreToolUse hook were
using different implied vocabularies for successful decisions. The core gate
type and evaluator emit `proceed`, `show-plan`, `suggest-alternative`, and
`block`. Older generated guidance said the endpoint returned `allow`, `block`,
`show-plan`, or `suggest-alternative`. The hook explicitly handled the latter
three actions and allowed any other action by falling through, so the live
`proceed` result did not block, but it was only accepted implicitly.

That mismatch matters because this is a trust-boundary hook. A documented flow
that disagrees with the endpoint can lead agents and tests to validate the wrong
contract. A hook that permits unknown actions by fallthrough makes future drift
harder to see.

## Source of truth

`ExternalOperationGate.ts` is the source of truth. Its exported `GateAction`
union is `proceed | show-plan | suggest-alternative | block`; its autonomy
profiles use `proceed`; and the LLM evaluator prompt asks for exactly those four
values. `allow` is treated as a legacy compatibility input at the hook boundary
only.

## Change

- Update generated and shipped documentation to name `proceed` as the canonical
  allowed action.
- Make the generated PreToolUse hook explicitly permit `proceed`.
- Keep hook compatibility for legacy `allow` responses.
- Block unknown action values from the gate instead of permitting them through
  unknown fallthrough.
- Pin the vocabulary at unit, integration, and e2e levels.

## Safety properties

- Existing canonical endpoint responses continue working.
- A stale endpoint or test double that still returns `allow` remains accepted by
  the hook, avoiding a sudden compatibility break.
- A misspelled or new unrecognized action from the gate blocks non-read MCP
  operations with a clear error rather than silently proceeding.
- Read-only operations still take the existing local fast path and do not call
  the gate.

## Tests

- Unit: core gate emits `proceed` for allowed reads; generated hook permits
  `proceed` and legacy `allow`, and blocks an unknown action.
- Integration: the evaluator route returns only the canonical vocabulary for
  representative read, write, delete, and blocked-service cases.
- E2E: an AgentServer-backed HTTP lifecycle verifies `proceed` for allowed
  reads and irreversible writes, `show-plan` for high-risk deletes, and `block`
  for configured denials.

## Rollback

Pure code and documentation rollback. Reverting restores the prior implicit
fallthrough behavior and old generated guidance. No data migration or state
repair is required.
