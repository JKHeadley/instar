# Side-Effects Review — Work front doors, stage 2: the "Project" label

**Version / slug:** `work-front-doors-stage2-project-label`
**Date:** `2026-11-20`
**Author:** `Echo`
**Second-pass reviewer:** `not required (display label; no gate, session, or messaging decision)`

## Summary of the change

Spec docs/specs/work-front-doors.md §3.1 ("the effort is the Project") and §4.3 ("the project name on a card"), stage 2 item 3. Tier 1 (7 source files, ~80 LOC, reversible by revert). One commit attempt, no spec rounds (the spec is already converged and approved).
- `cardJson` (src/core/workBoardViews.ts) adds `projectTitle` beside `projectKey`, only for the viewers who already get `projectKey` (owner and agent). The name comes from a new optional `projectTitle(projectKey)` route dependency, filled in routes.ts from the Chief of Staff's `projectsOverview()` titles, cached for 30 s.
- Console card page (work.js / work-model.js `cardProjectLink`): "Project: <name>" linking to the project's row on the Work page; a missing or ID-only name reads "Project name unavailable".
- Console Conversations (conversations.js / conversations-model.js `projectForEffort`): an effort whose front door, or a conversation directly in it, is a tracked project shows the eyebrow "Project", the role "Project" and an "Open project on the Work page" link. A plain effort stays "Group". The rule is the same one the Chats page already uses (`trackedProjects`).

## Decision-point inventory
No decision point. Display only.

## 1. Over-block
When the projects read fails (or the Work feature is off), an effort's role line is left unsaid rather than "Group": it may be a project, and calling a project a group would be wrong. The eyebrow stays "Conversations", as before.

## 2. Under-block
An effort that holds a project only through a nested effort is not labelled a Project (only its front door and direct conversations count). That matches the Chats page rule.

## 3. Level-of-abstraction fit
The name rides on the existing board read and its existing visibility rule; the console reuses the Chats page's project mapping. No new store.

## 4. Signal vs authority compliance
Not applicable: no authority (docs/signal-vs-authority.md).

## 5. Interactions
- Opening an effort in Conversations now makes one extra read (`/work/projects`) before it renders. A stale navigation is dropped by the existing `current()` check.
- The 30 s title cache means a renamed project shows its old name on cards for up to 30 s.
- A Chief of Staff read that throws gives no name; the card keeps its project link ("Project name unavailable").

## 6. External surfaces
Board card JSON gains `projectTitle` for owner/agent viewers. A member never receives it (unit test), the same as `projectKey` (§4.4).

## 6b. Operator-surface quality
1. Leads with its primary action: the label is a line on the existing card and effort pages; their primary actions are unchanged.
2. No raw internals: names only; an ID-only name is replaced by "Project name unavailable".
3. Destructive de-emphasized: nothing destructive added.
4. Plain language at phone width: one short line each, inside existing layouts.

## 7. Multi-machine posture
Proxied-on-read through existing paths: the Chief of Staff tree replicates through its journal union, so every machine names the same project; the card record already replicates. The cache is machine-local and only a 30 s read cache.

## 8. Rollback cost
Revert the commit. No stored data changes.

## Evidence
- Unit: `tests/unit/project-label.test.ts` (8 tests: owner gets the name, member gets neither key nor name, blank name dropped, card link and "Project name unavailable", effort as Project / Group / unsaid, nested effort and conversations never projects). Related suites (console chats/work models, conversations, work board) 22 files, 449 tests passing; `tsc --noEmit` clean.
