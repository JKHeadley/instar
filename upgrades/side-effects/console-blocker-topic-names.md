# Side-effects review: "In the way" rows name the conversation, not its topic number

## Change
`dashboard/console/plans-model.js`: `blockerText(raw, topicNames)` replaces `topic <number>` (or `topic #<number>`) in a row's text with the conversation's name in quotes when the Plans page's topic-name map knows it; an unknown number is left as written. `blockerRow` and `buildInTheWay` pass the map through; `buildPlansPage` supplies `opts.topicNames` (already loaded by `plans.js`).

## Evidence
On 1.3.1612 (2026-11-02 17:50) the raw-id scan of every console page found one hit: Plans "In the way" row "Request from topic 136110 (cloud server test…)". Topic 136110 is "Instar Virtual Machine" in the pooled topic list. On the preview with this change the scan finds none.

## 1. Over-block
None.

## 2. Under-block
Only the "topic N" phrasing is mapped; other id shapes in free text are untouched.

## 3. Level-of-abstraction fit
The display layer that already cleans blocker text.

## 4. Signal vs authority
Display only.

## 5. Interactions
None.

## 6. External surfaces
Plans rows.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
A row that refers to a conversation shows its name, matching the rule that the console shows names, never ids.

## 7. Multi-machine posture
Uses the pooled topic-name map Plans already reads.

## 8. Rollback cost
Revert.
