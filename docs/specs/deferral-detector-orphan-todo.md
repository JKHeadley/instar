---
title: "Deferral Detector — Orphan-TODO Patterns"
slug: "deferral-detector-orphan-todo"
author: "echo"
review-iterations: 1
review-convergence: "2026-04-27T22:30:00Z"
review-completed-at: "2026-04-27T22:30:00Z"
review-report: "docs/specs/reports/deferral-detector-orphan-todo-convergence.md"
approved: true
approved-by: "justin"
approved-at: "2026-04-27T22:35:00Z"
---

# Deferral Detector — Orphan-TODO Patterns

**Status:** spec — pending principal yes
**Owner:** Echo
**Date:** 2026-04-27
**Trigger incident:** Justin caught Echo proposing "queue them for the next session" after Layer 1 of telegram-delivery-robustness shipped, with no `/schedule` cron and no `/commit-action` tracker — i.e., an orphan-TODO that would evaporate between sessions.

## 1. Problem

The existing `deferral-detector.js` hook (PreToolUse on Bash for outbound message commands) catches "I can't do this" / "you'll need to" / "this requires human input" patterns. It does NOT catch the *other* shape of deferral: agents proposing future-self follow-up — "queue for next session", "loop back later", "in a follow-up" — without backing the deferral with real follow-through infrastructure.

The result: a promised follow-up evaporates because the future agent session has no automatic carry-over. Memory files are passive. Plans drift. The "no orphan TODO" rule (Echo memory `feedback_no_out_of_scope_trap`) gets violated structurally, even when the agent is trying to follow it.

## 2. Goal

The detector also catches orphan-TODO proposals in outbound messages and injects a checklist that names the actual infrastructure available (`/schedule`, `/commit-action`, same-branch follow-up commits, tied-to-existing-spec). Messages that already mention any of those infrastructure references get a pass — they are not orphan TODOs.

## 3. Non-goals

- Blocking the message. The detector is non-blocking by design (`decision: 'approve'`); it only injects an additional-context checklist for the agent to read.
- Detecting deferrals in non-message contexts (code comments, plan docs). Those have their own review channels.
- Catching arbitrarily-creative phrasings. The detector trades false-negative rate for false-positive rate; the cost of a missed catch is one orphan TODO, the cost of a false catch is a noisy nudge that the agent already knows how to handle.

## 4. Design

Extend the `getDeferralDetectorHook()` template in `src/core/PostUpdateMigrator.ts` with a second pattern category and a third anti-trigger category:

### 4a. Orphan-TODO patterns

Six regex patterns, all case-insensitive, covering common orphan-TODO phrasings:

- `queue (them|it|this) (up |for )?(the )?(next session|later|future|follow-up)` — direct "queue" framing
- `(pick this up|circle back|loop back|come back) (later|in (a |the )?(next|future|follow-up))` — passive carry-forward
- `(in |for )(a |the |another )?(follow-up|next session|future session|later session)` — sessional reference
- `(I'll|I will|I can|we (can|could)) (address|tackle|handle|fix|do|build|implement) (that |this |it )?(later|next time|in (the |a )?(future|follow-up))` — first-person promise
- `(deferred|defer|deferring) (to|until|for) (a |the |next |another )?(follow-up|session|later|future)` — explicit defer verb
- `(next time|future work|left for later|future iteration|TODO:?\s*later)` — bare deferral markers

### 4b. Infrastructure-backed anti-triggers

If any of these patterns also appear in the same message, the orphan-TODO match is suppressed (the deferral is structurally backed):

- `\/schedule\b` — the slash command for scheduled remote agents
- `\/commit-?action\b` and `commit-action\b` — the commitment tracker
- `scheduled (agent|run|cron|routine)` — describing a scheduled run
- `cron (expression|schedule)` — explicit cron
- `tracked (commitment|deadline|action-?item)` — explicit tracker reference
- `follow-?up (PR|commit|branch) (on |from )?(this |the |same )?branch` — chained-PR pattern (the "no PR fragmentation" rule, satisfied)

### 4c. Checklist injected on detection

When orphan-TODO patterns match (and no infrastructure-backed pattern offsets them), the detector appends a separate orphan-TODO section to the existing inability-deferral checklist. The orphan section names the four real follow-through mechanisms and ends: *"`I will get to it next time` is not infrastructure."*

The two checklist sections (inability + orphan-TODO) coexist when both pattern categories fire.

### 4d. Hook installation

Wired through the same `migrateHooks()` path that already deploys all 14 instar hooks. No change to hook lifecycle, no change to settings.json. The new content is just an updated template body, hashed by `builtin-manifest.json` (which auto-regenerates).

## 5. Signal-vs-authority compliance

Pure detector. No blocking authority. The hook's decision is fixed at `'approve'` — it can only inject `additionalContext` for the agent to read. The smart authority that decides "is this deferral OK" remains the agent's own judgment, now better-informed.

The patterns themselves are low-context regex matches — exactly the brittle-detector shape the principle calls out. They feed the agent's own judgment, not a block path. Compliance: clean.

## 6. Test plan

`tests/unit/deferral-detector-orphan-todo.test.ts`:

- Each of the six orphan-TODO patterns triggers detection on a representative phrasing.
- Each of the six infrastructure-backed patterns suppresses detection when paired with a deferral phrase.
- Inability patterns continue to fire independently of orphan patterns.
- A clean message (no patterns) is a no-op.
- A message with both inability and orphan patterns gets both checklist sections.

Run via the existing hook-testing harness — pipe a JSON-encoded `tool_input.command` to the hook and assert on the JSON-decoded stdout.

## 7. Rollback

Revert the `getDeferralDetectorHook()` change in `src/core/PostUpdateMigrator.ts`. Manifest regenerates. Existing agents on next `instar update` have their hook reverted to the inability-only version. Zero persistent state.

Cost: one revert PR, ~10 min ship time.

## 8. Acceptance criteria

1. Orphan-TODO patterns match the six representative phrasings.
2. Infrastructure-backed phrasings suppress orphan-TODO matches.
3. Existing inability-pattern behavior is unchanged.
4. Hook continues to be non-blocking (`decision: 'approve'`).
5. Test file passes.
6. `pnpm tsc --noEmit` clean.
7. Manifest regenerated and validated by existing test.
8. Side-effects artifact at `upgrades/side-effects/deferral-detector-orphan-todo.md`.

## 9. Convergence note

This spec is small (~50 lines of net new template code, regex patterns and a checklist) and structurally lower-risk than the telegram-delivery-robustness spec. The convergence round used a single internal reviewer rather than the full 4-internal + 3-external panel. Rationale:

- No blocking authority introduced (detector is non-blocking by hook contract).
- No new external surface (hook only injects context for the agent's own consumption).
- No new state (no files, no DB, no migrations).
- Pattern false-positive risk is bounded: a noisy "false catch" only injects a checklist the agent reads; doesn't break delivery.

A single internal reviewer focused on (a) signal-vs-authority compliance, (b) false-positive risk in the patterns, (c) anti-trigger coverage. Findings: minor wording suggestions, all addressed pre-approval. Full pattern catalogue captured in §4 above.
