# Side-effects review: every "needs you" row has somewhere to act

## Change
`dashboard/console/home-model.js` adds `needAction(item)`; `buildNeeds` uses it for every row. Order: the item's own topic; a `desktop` item opens `/dashboard/desktop.html?machineId=<its machine>` (that page has the guided setup and Retry for that machine); a sign-in item opens Accounts; anything else opens the Attention topic in Telegram, where the item was posted. `dashboard/console/console.js` reads `GET /telegram/system-topics` once to learn the Attention topic and maps the new `href` and `attention` action kinds to links.

Before, a row without a topic id rendered as expandable text with no link. On the Studio today both rows in "needs you" (Remote Desktop permission on Mac Lan and Mac Mini) were like that.

## 1. Over-block
None. Not a gate.

## 2. Under-block
If the Attention topic cannot be read, an `attention` row falls back to the old expandable text (no link). It never shows a broken link.

## 3. Level-of-abstraction fit
The console page model decides where a row links. Correct layer.

## 4. Signal vs authority
No decision point. Not applicable.

## 5. Interactions
A row with a link renders as a link instead of an expandable row, so its description is not shown inline; the destination (Desktop page, conversation, Attention topic) carries the full text. The headline now says "Tap to review and respond." for these items, as it already did for conversation items. The card still hides itself when there is exactly one actionable item, because the headline then links to it.

## 6. External surfaces
One extra read (`GET /telegram/system-topics`) per console load. It is read-only and already authenticated.

## 6b. Operator-surface quality
Checked on the preview: each of the two Remote Desktop rows links to the Desktop page with that machine selected.

## 7. Multi-machine posture
Items come from `/attention?scope=pool` and carry their machine id; the Desktop link uses the item's own machine. The Attention topic is the agent-wide system topic (one per agent). Machine-local page code.

## 8. Rollback cost
Revert the commit; no data or migration.
