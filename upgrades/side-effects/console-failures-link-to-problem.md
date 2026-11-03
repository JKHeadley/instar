# Side-effects review: a machine that did not answer links to the Machines page

## Change
`dashboard/console/ui.js` adds `machineIssue(text)`, `noteLinked(text)` and `MACHINES_PAGE`. A note whose wording says a machine did not answer (the console's own phrasings: "did not answer", "not answering", "Couldn't read other machines…") gets a "See machines" link to the Machines page, where each machine's state and reachability are shown. Used on Sessions (the partial-coverage note, and each unanswered machine in "Other machines", now a link), Schedule (its three note lists) and the Home status note. Any other note renders exactly as before.

## Evidence
A scan of every console page for failure wording without a link or clickable row found only the Sessions page lines "Mama PC did not answer; its sessions are not shown." and "Mama PC: not answering (last seen 1 min ago)". The same wording appears in Schedule and in the Home status note when a machine does not answer.

## 1. Over-block / 2. Under-block
Not a gate. A failure note in some other wording keeps no link; the scan found none.

## 3. Level-of-abstraction fit
A shared page helper used by the pages that render these notes.

## 4. Signal vs authority
No decision point.

## 5. Interactions
Text is unchanged; a link is appended. The Home status note is rebuilt from text nodes (no HTML is parsed).

## 6. External surfaces
Dashboard only.

## 6b. Operator-surface quality
Checked on the preview: the Sessions page's unanswered-machine lines are links to Machines.

## 7. Multi-machine posture
Page code only.

## 8. Rollback cost
Revert the commit.
