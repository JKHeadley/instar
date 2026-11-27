# Side-Effects Review — Grouped conversations: Projects apart from Groups

**Version / slug:** `console-chats-grouped-sections`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `not required (display-only, no decision point)`

## Summary of the change

Owner bug report 2026-11-18 13:18 (iPhone): in Grouped view, projects and plain groups were mixed, empty groups showed, and project groups carried a "Project:" prefix. The iPhone fix is apps/instar-ios 039e813 (`ConversationTree.swift`: `EffortSummary.displayTitle`, `strippingProjectPrefix`, `projectEfforts`/`plainEfforts`, empty groups dropped). This change applies the same rules to the console:

- `dashboard/console/chats-model.js`: `stripProjectPrefix(title)` (regex `^project\s*[:\-–—]\s*`, case-insensitive; empty remainder keeps the title), `groupDisplayTitle(group, project)` (tracked project title unless empty or equal to its key, stripped; else the group title stripped; plain groups unchanged), `groupSections(groups, projectsByGroup)` → `{ projects, groups }`, dropping any group whose count is 0, keeping order within each section.
- `dashboard/console/chats.js`: Grouped view renders a "Projects" header and its rows, then the "Groups" header and its rows; each header only when its section is non-empty. Row title and aria-label use the display title. Row markup otherwise unchanged.
- Tests: model test for the prefix rule (including "Projector setup", "Projects: plural", "My Project: x", "Project:"), display title and sections; page test asserts the header order and the tracked project's title on the row, and that no "Projects" header appears without a tracked project.

Tier 1, 2 source files + 2 test files + 3 docs, about 150 lines, one commit, no spec review rounds.

## Decision-point inventory

None. Display grouping only.

## 1. Over-block

A group is hidden only when it has zero conversations among the loaded rows. The console builds groups from loaded rows, so in practice a group always has at least one; the filter is parity with the iPhone and a guard. No conversation becomes unreachable.

## 2. Under-block

No issue identified. Titles render through `textContent` as before.

## 3. Level-of-abstraction fit

Pure functions in the page's view model; the page only renders them. Same split as the iPhone (`GroupedConversationList` / `EffortSummary`).

## 4. Signal vs authority compliance

Not applicable: no decision point (`docs/signal-vs-authority.md`).

## 5. Interactions

The project link (`projectsForGroups`), status chips, pins, the Chief of Staff lead row, "Not in a group yet" and All view are unchanged. The existing page test that expected the group's own title on a project row now expects the tracked project's title (intended change).

## 6. External surfaces

Owner-visible on the console Conversations page only. No routes, config, or server data.

## 7. Multi-machine posture

Machine-local by design: browser rendering of reads the server already merges across the pool.

## 8. Rollback cost

Revert the commit. No state, no migration.

## Conclusion

Small, reversible display change matching the iPhone app. Ship.

## Evidence pointers

- `tests/unit/console-chats-model.test.ts` — "grouped sections (iPhone parity, Justin 2026-11-18)".
- `tests/unit/console-chats-page.test.ts` — the project-group test (Projects/Groups order, project title) and the plain grouped test (no Projects header).
- Chromium screenshots at 390x844 and 1280x728 against a local static server with mocked routes.
