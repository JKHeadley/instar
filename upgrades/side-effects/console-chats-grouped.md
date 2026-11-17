# Side-Effects Review — the console Conversations list grouped by the conversation hierarchy

**Version / slug:** `console-chats-grouped`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `not required (display-only grouping of rows the page already shows, no decision point)`

## Summary of the change

The owner asked (2026-11-17) for the conversation list itself to be grouped by the effort hierarchy, so that only the top level shows at first, with the Chief of Staff always at the top, and for a toggle to switch to the full flat list at any time. The hierarchy already existed (`GET /conversation-graph/roots`) and was drawn only on the separate `#/work/conversations` page; the Conversations list he uses (`#/work/chats`, `dashboard/console/chats.js`) stayed flat.

Change:
- `dashboard/console/chats-model.js`: pure `hierarchyIndex(pages)` joins hierarchy pages (normalized by the existing `conversations-model.js` `listModel`, not re-implemented) to list rows by `platform:conversationId`, mapping each conversation to its top-level effort; `groupRows(rows, index, leadKey)` returns the Chief of Staff row, one group per top-level effort (count, summed unread, newest activity) and the "Not in a group yet" rows; `listViewFrom`, `groupCountWords`, `LIST_VIEW_KEY`, `HIERARCHY_MAX_PAGES`.
- `dashboard/console/chats.js`: after each first-page list read, at most once a minute, reads `GET /mobile/conversation-graph/roots?view=all` signed by the browser's device key (paged, up to 20 pages). If that is refused and the page already holds a PIN unlock, the dashboard route is tried with it; the page never asks for a PIN for this. 403, 404 or 503 → no hierarchy: the list is exactly today's flat list and the toggle is hidden. Other failures keep the last answer. In Grouped view: pinned rows first (unchanged), then the Chief of Staff row, then one collapsed button row per effort (title, "N conversations", unread total, newest time) that expands inline, then "Not in a group yet" with a "Review suggestions" link to the existing suggestions page. A "Grouped | All" chip pair switches to the flat list; the choice is saved in `localStorage` (`instar_chats_list_view`, every access in try/catch). The group holding the open conversation is always expanded.
- `dashboard/console/console.css`: toggle, project row and label styles.
- Owner-facing words (owner decisions 2026-11-17): the general unit is a "group"; "project" appears only on a group linked to a tracked project; never "effort". Section header "Groups", bottom section "Not in a group yet", "Untitled group"; a plain group's aria-label is "Group <title>, N conversations[, U unread]". Internal names (`chat-effort-row`, effort refs) are unchanged.
- Project marks (third commit, owner 15:30 "a visual representation for which chat groups are part of a project"): `effortMembers(pages)` lists every conversation under each top-level group (front door first, nested and unloaded ones included); `trackedProjects(data)` reads `GET /work/projects` (the same read the Work page and the conversation app strip use, through the page's existing 30-second cache; a bare app id is an app key); `projectStatusOf` maps status words to chips with the mapping shared with the iPhone and Android apps (Moving ← moving, moving-under-existing-owner; Stuck ← stalled, stopped-retrying, stuck; Needs you ← waiting-on-you, waiting-on-user; Done ← done, done-verified; Drifting ← drifting; Paused ← paused or `pausedBy` set; anything else, including claims-done and unknown, no chip); `projectsForGroups` marks a group as a project when any of its conversations is a tracked project's conversation key. Project rows get a flag icon (the console's constant icon set), the chip with the Work page's tones, and when open an "Open project" link to `#/work/board?project=<key>`. `projects.js`/`work.js` accept that `project` query to open that row (and its Finished fold) and focus it once per link; a refresh never moves the page. A failed projects read leaves every group plain.

Tier 1, 11 files (4 source, 1 CSS, 3 tests, 3 docs), about 650 lines across three commits (feature, wording, project marks plus group wording), each from an owner message during the build; no spec review rounds (Tier 1, no spec).

## Decision-point inventory

None. Display grouping only; nothing gates, blocks or filters. The status chip only names the server's own project state; it decides nothing. Every row that was shown before is still reachable: grouped rows are one tap away, and All shows the flat list.

## 1. Over-block

No row is dropped. A list row whose conversation the hierarchy does not know is "Not in a group yet". The groups only cover list pages already loaded ("Show more" still adds rows); an effort with none of its conversations loaded shows no group until they load.

## 2. Under-block

The hierarchy read uses the server's existing owner checks (device admission or PIN operator session); this change adds no new route and no new authority. Effort and conversation titles are untrusted and reach the page only through `textContent` (`ui.js el`); a title with markup renders as literal text (tested).

## 3. Level-of-abstraction fit

Right layer: the join and grouping are pure functions in the page's view-model file, reusing the Conversations page's response normalizer; the page only renders them. Placement is never guessed from titles; it comes from the server's `primaryPath`.

## 4. Signal vs authority compliance

Not applicable: no decision point (see `docs/signal-vs-authority.md`).

## 4b. Judgment-point check

None.

## 5. Interactions

- Pins (conversation-list-pins) keep their own "Pinned" section above everything in both views.
- The Chief of Staff tree (`parentConversationKey`, `orderWithTree`) still orders the flat All view and the "Not in a group yet" rows.
- Unread badges: a group shows the sum of its rows' counts; the open conversation's row still hides its own badge.
- Poll budget: one hierarchy read per minute at most, counted through the page's existing `spent()`; the projects read reuses the page's existing 30-second `/work/projects` cache (shared with the conversation's app strip).
- Work page: `projectsSection(data, { openKey })` keeps its old behaviour when no key is given; existing project-apps tests pass unchanged.
- Existing page tests whose fixtures do not serve the hierarchy route get 404 and see the unchanged flat list (they pass unchanged).
- PR 3318 (console-chat-markdown) also edits `chats.js` (message bubbles, a different region); a textual conflict, if any, is resolved by keeping both.

## 6. External surfaces

Visible to the owner on the console Conversations page, plus the Work page opening a project row from a link. No routes, config, server code or stored server data change. One new browser-local key (`instar_chats_list_view`).

## 7. Multi-machine posture

Machine-local by design: browser-side rendering of the hierarchy the server already serves, which itself reads the pool's replicated graph. The view choice is per browser, by intent.

## 8. Rollback cost

Revert the commit; no state, no migration. The leftover `localStorage` key is ignored.

## Conclusion

Small, reversible display change that gives the owner the grouped list he asked for, with the flat list one tap away and today's list as the fallback. Ship.

## Evidence pointers

- `tests/unit/console-chats-model.test.ts`: top-level effort index across pages (nested efforts roll up, blank effort title → Untitled, unplaced conversation absent), malformed or empty hierarchy → null, `groupRows` lead/groups/count/unread/ungrouped, remembered-view parsing.
- `tests/unit/console-chats-model.test.ts` (project marks): members front door first with nested groups, the shared chip mapping (route states, raw verdicts, pausedBy, no chip otherwise), a group is a project by any conversation under it, failed read → plain.
- `tests/unit/console-chats-page.test.ts` (project marks): a project group row with flag, "Needs you" chip, aria-label and "Open project" link next to a plain folder row; a failed projects read leaves the group plain.
- `tests/unit/console-project-apps-model.test.ts`: `?project=<key>` opens that row (and the Finished fold), others stay closed.
- `tests/unit/console-chats-page.test.ts`: the shipped page in jsdom reads the hierarchy signed by the device key, shows Chief of Staff, a collapsed effort row (title as text, count, unread total), "Groups" header, a plain group with folder and no "project" or "effort" words, "Not in a group yet" with the suggestions link, expands inline, switches to All and remembers it; a remembered All opens flat; 403/404/503 → flat list exactly as before with the toggle hidden and no dashboard-route attempt without a PIN unlock.
