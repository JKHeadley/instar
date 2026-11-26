# Side-Effects Review — door + model controls: readable names, phone layout, plain refusal wording

**Version / slug:** `door-model-controls-polish`
**Date:** `2026-10-01`
**Author:** `Echo`
**Second-pass reviewer:** `not required (display and wording only; no decision logic changed)`

## Summary of the change

Follow-up to #2086 (dashboard door + model controls, shipped in 1.3.1311). The operator reported the controls "a bit buggy". A walkthrough of all three controls at 390px on the live Mac Studio dashboard (1.3.1312) found no functional failure and four display defects: raw model ids in every list and badge, a dated duplicate of one model in the Claude list, mid-word wrapping of badges in the Sessions list, and a session-view header whose model badge and "Door + model" button each wrapped to three lines. A fifth item is wording: the refusal for a topic with no bound operator did not tell the user what to do.

Files:

1. `dashboard/index.html` — three inline helpers (`friendlyModelName`, `modelFamilyClass`, `visibleModels`); the three model selects, both model badges and the door/model labels use them; CSS for whole-badge wrapping and a one-line phone header.
2. `src/core/topicProfileWriteSurface.ts` — the `reply` string of the `no-bound-operator` refusal for token writes. `refusal.reason`, the audit row and the control flow are unchanged.
3. `tests/unit/dashboard-door-model-display.test.ts` — new; evaluates the helpers extracted from the shipped page and pins the wiring, CSS and wording.

A sixth suspected defect (a dashboard-created topic never receiving its one-line start note) was investigated and is not a defect: the origin record for the test topic shows the first attempt refused with `credential-capacity-unavailable` and the recovery attempt accepted by Telegram about four minutes later. No change was made for it.

## Decision-point inventory

- `no-bound-operator` refusal in `TopicProfileWriteSurface` — pass-through — only the human-readable `reply` text changed.
- Dashboard model selects — modify (display only) — option text is the display name; option `value` and the request body are the raw id as before.
- No gate, sentinel, watchdog or authority is added or changed.

---

## 1. Over-block

No block is added. `visibleModels` hides a dated model id from a dropdown only when the undated id for the same model is in the same list; the hidden id and the shown id name the same model, so no model becomes unselectable. A dated id that is the topic's current model is kept, so an existing pin is never displayed as something else.

## 2. Under-block

Nothing is permitted that was refused before. The server still validates every door/model pair (`validateDashboardProfileChoice` and the write surface); the dashboard sends the same raw ids it sent before.

Display limits that remain: a model id outside the two recognized shapes (Claude `claude-<family>-<n>[-<n>][-<date>]`, Codex `gpt-<n>[-<word>]`) is shown raw. That is deliberate — showing an unknown id unchanged is safer than guessing a name.

## 3. Level-of-abstraction fit

The names are formatted in the dashboard page because that is the only consumer; the server's options route keeps returning raw ids, which other callers (the agent, scripts) need. Putting display names into the route would add a second naming authority. The refusal text lives where the refusal is produced, so the dashboard, the API and chat all show the same sentence.

## 4. Signal vs authority compliance

No decision logic. The formatter and the list filter have no blocking authority; they cannot change what is sent or accepted. Compliant with `docs/signal-vs-authority.md` by having no decision point.

## 4b. Judgment-point check

No new heuristic at a competing-signals point. The regular expressions format text for display only.

## 5. Interactions

- The post-switch poll compares `x.model === job.model` on raw ids; unchanged, so switch confirmation still works.
- The Sessions-list default `session.model || 'opus'` now renders as "OPUS" via the alias branch, the same text as before.
- Badge color: the class was the raw id before, which matched the `.opus` / `.sonnet` / `.haiku` rules only for bare aliases. It is now the family, so full ids get their family color; `.fable` shares the Opus color rule. Job-list badges (`.job-item-meta .model-badge`) are not touched by the new header rule; the global `white-space: nowrap` on `.model-badge` applies to them too, and their texts are short.
- At phone width the session-type tag in the session header is hidden with `!important` because the script sets its `display` inline. It remains visible in the Sessions list and at desktop width.

## 6. External surfaces

- Dashboard appearance (Sessions list, session header, the three sheets).
- The `reply` string of the `no-bound-operator` refusal on `POST /topic-profile/:id` token writes. A caller that matched on the old sentence would break; the machine-readable `reason` is the documented contract and is unchanged. No caller in the repo matches on the sentence (`grep` over `src/`, `tests/`, `dashboard/`).

## 6b. Operator-surface quality

This change is operator-surface quality. Checked at 390px and 1280px: no horizontal scroll, header on one line at 390px, list badges whole. The refusal sentence leads with the action and uses no internal term other than "operator", which it explains.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design and stateless: each machine serves its own copy of the dashboard page and formats ids at render time. No state is written. Remote (pool) session rows go through the same list renderer, so they get the same names.

## 8. Rollback cost

A code revert of one HTML file and one string. No state, config, or migration.

## Conclusion

The controls worked; they read badly on a phone. Names, list contents, wrapping and one sentence are fixed. One suspected bug (the start note) was a four-minute delivery delay, confirmed from the origin record, and needed no change.

## Second-pass review (if required)

Not required: no messaging block/allow decision, session lifecycle, gate, sentinel or watchdog logic is changed.

## Evidence pointers

- Live walkthrough screenshots at 390px before and after (session list, session header, switch sheet), taken against the Mac Studio server on 1.3.1312 with the edited page.
- Dropdown contents read from the edited page: Codex `GPT-5.2 … GPT-6 Luna`; Claude list with one `Haiku 4.5` row and `Opus (latest)` style aliases; values are raw ids.
- Origin record for the start note of test topic 121401: attempt 1 `known-failed` / `credential-capacity-unavailable`, attempt 2 `accepted` with a Telegram message id.
- `tests/unit/dashboard-door-model-display.test.ts` plus the existing `dashboard-door-model-controls`, `dashboard-door-model-server-wiring`, `topicProfileWriteSurface` and `dashboard-sessionMachineBadge` suites: 97 tests pass.

## Class-Closure Declaration (display-only mirror)

Class: an operator-facing surface that shows internal identifiers and was only checked at desktop width. Sibling sites closed here: every place the dashboard renders a session model id (list badge, header badge, three selects, three labels). Not in this change: other tabs that render model ids (jobs, LLM activity) keep raw ids; they were not part of the reported problem.
